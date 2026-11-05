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

// Claude Code's refusal of a submit made while no session is bound in its process (the text 2.1.293 gives: "$.prompt.submit is not
// available in this mode: no session is bound in this process ..."). Nothing was submitted. Only that clause counts: another mode
// refusal is permanent and is not held.
export const isUnboundSubmit = (message) => /no session is bound/i.test(String(message || ''))
// A claimed wake (a halting exception, or a worker death under a plan) carries its delivery key as a trailing `(ref ...)` (wake-pipe.cjs);
// ADR 0074 amendment 1 delivers exactly these at least once.
export const isClaimedWake = (text) => / \(ref [0-9a-f]{8}\)$/.test(String(text || ''))
// While a wake is held, the mod tries again at most this far apart, so a session that comes back gets it within seconds.
export const HELD_RETRY_MS = 5000
// The status line the mod pins while wakes are held. '' when none is held.
export const heldNotice = (n) => (n > 0 ? `belay: ${n} wake${n === 1 ? '' : 's'} not delivered: Claude Code says no session is open in this window; ${n === 1 ? 'it is' : 'they are'} sent when it is back` : '')
// How long, in words a toast can carry.
const spell = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`)
// The toast once held wakes have gone out: the status line cannot be seen while the session is away, so this names what happened.
export const releasedNotice = (n, longestMs) => `belay: ${n} wake${n === 1 ? '' : 's'} held for up to ${spell(longestMs)} while no session was open in this window, delivered now`

// Delivery (ADR 0037 amendment 5 item 7, as amended), in the order the wakes came.
// - A claimed wake (isClaimedWake) is delivered at least once, as ADR 0074 amendment 1 accepts for halts and deaths: it is submitted
//   first and recorded after, so a crash or reload between the two delivers it again and its ref names the repeat. A record write that
//   fails is written again, never submitted again.
// - Every other wake is delivered at most once, as before: its id is recorded (memory and file) only after the write has succeeded,
//   and submitted only after that, so a crash between the two loses it but never duplicates it. A failed write submits nothing and is
//   tried again.
// - A submit Claude Code refuses because no session is bound (isUnboundSubmit) submitted nothing: the wake is held, first in line, and
//   every later wake waits behind it. A held at-most-once wake has its record taken back first (a crash between the record and the
//   take-back loses that wake, which is the at-most-once price). Any other submit failure stays recorded and is never re-run.
// `io` = { write(file, content) -> Promise, submit(text) -> Promise, log(entry) }; `initial` is the file's text. Each id is logged
// once per kind: the first hold, the delivery after a hold, a submit failure, a failed write.
export function createDelivery({ file, initial = '', io, now = () => Date.now(), cap = capText }) {
  let content = String(initial || '')
  const delivered = parseDelivered(content)
  const pending = new Map() // id -> text, in arrival order: a held (or unwritten) wake first, then every wake that came behind it
  const held = new Map() // id -> when it was first held, for the ids in pending refused for want of a bound session
  const unrecorded = new Set() // claimed wakes submitted (or failed for good) whose record write failed: written again, never submitted again
  const logged = new Set()
  let released = { n: 0, longestMs: 0 } // held wakes delivered since the last takeReleased
  const logOnce = (id, stage, entry) => {
    if (logged.has(`${stage}:${id}`)) return
    logged.add(`${stage}:${id}`)
    try { io.log({ at: now(), id, stage, ...entry }) } catch { /* nowhere to log */ }
  }
  const write = async (id, next) => {
    try { await io.write(file, next) } catch (e) { logOnce(id, 'write', { error: String((e && e.message) || e) }); return false }
    content = next
    return true
  }
  const record = async (id) => { if (await write(id, content + deliveredLine(id, now()))) unrecorded.delete(id); else unrecorded.add(id) }
  const done = new Map() // id -> how the flush that took it ended
  const hold = (id, error) => {
    const at = now()
    for (const w of pending.keys()) { if (!held.has(w)) held.set(w, at); logOnce(w, 'held', { held: true, error }) } // this one and everything behind it waits
    done.set(id, 'held')
  }
  const settle = (id, error) => {
    pending.delete(id)
    delivered.add(id)
    if (held.has(id)) { released.n += 1; released.longestMs = Math.max(released.longestMs, now() - held.get(id)); held.delete(id); logOnce(id, 'released', {}) }
    if (error !== null) logOnce(id, 'submit', { error })
    done.set(id, error !== null ? 'submit-failed' : 'submitted')
  }
  const submit = async (text) => { try { await io.submit(cap(text)); return null } catch (e) { return String((e && e.message) || e) } }
  const flush = async () => {
    for (const id of [...unrecorded]) await record(id)
    for (const [id, text] of [...pending]) {
      if (isClaimedWake(text)) {
        const error = await submit(text)
        if (error !== null && isUnboundSubmit(error)) return hold(id, error)
        settle(id, error)
        await record(id)
        continue
      }
      const before = content
      if (!(await write(id, content + deliveredLine(id, now())))) { done.set(id, 'write-failed'); return } // tried again, in order
      const error = await submit(text)
      if (error !== null && isUnboundSubmit(error)) {
        await write(id, before) // take the record back; a failed take-back leaves it, and a reload would skip this wake
        return hold(id, error)
      }
      settle(id, error)
    }
  }
  const self = {
    delivered,
    pending,
    held,
    unrecorded,
    // Held wakes delivered since the last call. -> { n, longestMs }.
    takeReleased() { const r = released; released = { n: 0, longestMs: 0 }; return r },
    // Tries the held and unwritten wakes and the unwritten records again, in order; the caller schedules this while any is left.
    async retryPending() { await flush(); return pending.size + unrecorded.size },
    // -> 'skip' (delivered before) | 'held' or 'write-failed' (waits, first in line) | 'queued' (waits behind one of those) | 'submitted' | 'submit-failed' (never re-run).
    async deliver(id, text) {
      if (delivered.has(id)) return 'skip'
      if (!pending.has(id)) pending.set(id, text)
      done.delete(id)
      await flush()
      return done.get(id) || (held.has(id) ? 'held' : 'queued')
    },
  }
  return self
}
