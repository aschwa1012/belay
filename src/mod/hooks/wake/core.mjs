// The wake mod's logic, kept free of the mod API so that Node tests import it (ADR 0037 amendment 5).
// Plain ES module with no globals beyond the language's own (a mod's environment has no Node, so no Buffer).

export const PLUGIN_NAME = 'belay'
// Claude Code's frame around a submitted wake adds 174 B plus the plugin name; the whole must stay under
// 400 B (wake2 VERDICTS, wake_text_215_kept), so the text is at most 226 B minus the name's length.
export const FRAME_BUDGET = 226

// UTF-8 length of one code point.
const cpBytes = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4)

export function byteLength(s) {
  let n = 0
  for (const ch of String(s)) n += cpBytes(ch.codePointAt(0))
  return n
}

export const maxTextBytes = (name = PLUGIN_NAME) => FRAME_BUDGET - byteLength(name)

// Cuts `text` to at most `max` UTF-8 bytes, on a character boundary.
export function capText(text, max = maxTextBytes()) {
  let n = 0
  let out = ''
  for (const ch of String(text)) {
    n += cpBytes(ch.codePointAt(0))
    if (n > max) break
    out += ch
  }
  return out
}

// belay-run.json -> the config the mod acts on, or null. A watching session has no such file, and a file
// whose role is not the orchestrator's activates nothing.
export function activeConfig(jsonText) {
  let c
  try { c = JSON.parse(jsonText) } catch { return null }
  if (!c || c.role !== 'orchestrator') return null
  for (const k of ['run_id', 'data_dir', 'belay_cli', 'node', 'orchestrator_dir', 'wake_nonce']) {
    if (typeof c[k] !== 'string' || !c[k]) return null
  }
  return c
}

export const streamArgv = (c) => [c.node, c.belay_cli, 'wake-stream', '--run', c.run_id, '--nonce', c.wake_nonce, '--data', c.data_dir]
export const deliveredPath = (c) => `${String(c.orchestrator_dir).split('\\').join('/')}/wakes-delivered.jsonl`

// One line from wake-stream -> { kind: 'wake', id, text } | { kind: 'hb' } | { kind: 'ignore' }.
export function parseLine(line) {
  let o
  try { o = JSON.parse(line) } catch { return { kind: 'ignore' } }
  if (!o || typeof o !== 'object') return { kind: 'ignore' }
  if (typeof o.id === 'string' && o.id && typeof o.text === 'string' && o.text) return { kind: 'wake', id: o.id, text: o.text }
  if (typeof o.hb === 'number') return { kind: 'hb' }
  return { kind: 'ignore' }
}

// wakes-delivered.jsonl -> the Set of ids it names. A torn or foreign line is skipped.
export function parseDelivered(fileText) {
  const ids = new Set()
  for (const l of String(fileText || '').split('\n')) {
    if (!l) continue
    try { const o = JSON.parse(l); if (o && typeof o.id === 'string') ids.add(o.id) } catch { /* skip */ }
  }
  return ids
}

export const errorsPath = (c) => `${String(c.orchestrator_dir).split('\\').join('/')}/wake-errors.jsonl`
export const deliveredLine = (id, at) => `${JSON.stringify({ id, at })}\n`

// Splits a stream of chunks into whole lines; the unfinished tail waits for the next chunk.
export function lineSplitter() {
  let buf = ''
  return (chunk) => {
    buf += chunk
    const out = []
    let i
    while ((i = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, i)); buf = buf.slice(i + 1) }
    return out
  }
}

// The decision for one parsed line: 'submit' (record, then submit), 'skip' (id already delivered), 'none'.
export const decide = (parsed, delivered) => (parsed.kind !== 'wake' ? 'none' : delivered.has(parsed.id) ? 'skip' : 'submit')

// Only a missing file means "nothing delivered yet". Any other failure to read it (a sharing violation, a lock, EBUSY, EPERM)
// says nothing about what was delivered.
export const isMissing = (e) => !!e && (e.code === 'ENOENT' || /\bENOENT\b|no such file/i.test(String(e.message || '')))

// The delivered file's text for createDelivery's `initial`: '' when the file is missing, its text when it reads, and after
// `tries` failed reads (a pause of `delayMs`, doubling, between them) null: the caller must not deliver or write on null.
export async function readDelivered({ read, sleep, tries = 4, delayMs = 250 }) {
  for (let i = 0; i < tries; i += 1) {
    try { return String(await read()) } catch (e) {
      if (isMissing(e)) return ''
      if (i < tries - 1) await sleep(delayMs * (2 ** i))
    }
  }
  return null
}

// Delivery, at most once (ADR 0037 amendment 5): the id is recorded (memory and file) ONLY after the file write
// has succeeded, and the submit happens only after that, so a failed write submits nothing (the wake is retried
// on a replay) and a crash between the record and the submit loses that wake but never duplicates one.
// `io` = { write(file, content) -> Promise, submit(text) -> Promise, log(entry) }; `initial` is the file's text.
//
// A claimed wake (its text ends with `(ref <8 hex>)`) has a second path: the publisher releases its claim when the delivered file has not
// named it within its delivery bound (src/run/wake-pipe.cjs, 30 s) and worker_wait offers it. So a claimed wake whose write still fails
// GIVE_UP_MS after its first failure is given up and logged, never retried into that path's turn: one path delivers it. No retry
// starts later than GIVE_UP_MS after the first failure (index.ts tries at about 1, 3, 7 and 15 s), well inside the bound. An unclaimed wake has no other path and is retried
// until its write lands. A repeat that slips past (a line that reached the mod late) still carries its ref, so it is recognisable.
export const GIVE_UP_MS = 20000
export const isClaimedText = (text) => / \(ref [0-9a-f]{8}\)$/.test(String(text))
export function createDelivery({ file, initial = '', io, now = () => Date.now(), cap = capText, giveUpMs = GIVE_UP_MS }) {
  let content = String(initial || '')
  const delivered = parseDelivered(content)
  const inflight = new Set()
  const pending = new Map() // id -> text of a wake whose record write failed: kept until the write lands or, claimed, until giveUpMs
  const firstFail = new Map() // id -> when its write first failed
  const gaveUp = new Set() // claimed wakes left to the other path: never submitted here
  const self = {
    delivered,
    pending,
    gaveUp,
    // Tries every wake whose write failed again, in the order they arrived; the caller schedules this until `pending` is empty.
    async retryPending() {
      for (const [id, text] of [...pending]) {
        if (isClaimedText(text) && now() - firstFail.get(id) >= giveUpMs) {
          pending.delete(id); firstFail.delete(id); gaveUp.add(id)
          try { io.log({ at: now(), id, stage: 'gave-up', error: 'the record write kept failing; this claimed wake is left to worker_wait once the publisher releases it' }) } catch { /* nowhere to log */ }
          continue
        }
        await self.deliver(id, text)
      }
      return pending.size
    },
    async deliver(id, text) {
      if (delivered.has(id) || inflight.has(id) || gaveUp.has(id)) return 'skip'
      inflight.add(id)
      try {
        const next = content + deliveredLine(id, now())
        try { await io.write(file, next) } catch (e) {
          pending.set(id, text)
          if (!firstFail.has(id)) firstFail.set(id, now())
          try { io.log({ at: now(), id, stage: 'write', error: String((e && e.message) || e) }) } catch { /* nowhere to log */ }
          return 'write-failed'
        }
        pending.delete(id)
        firstFail.delete(id)
        content = next
        delivered.add(id)
        try { await io.submit(cap(text)) } catch (e) {
          try { io.log({ at: now(), id, stage: 'submit', error: String((e && e.message) || e) }) } catch { /* nowhere to log */ }
          return 'submit-failed'
        }
        return 'submitted'
      } finally { inflight.delete(id) }
    },
  }
  return self
}
