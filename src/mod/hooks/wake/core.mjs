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
  if (c.session_id !== undefined && (typeof c.session_id !== 'string' || !c.session_id)) return null // the launcher's --session-id, when it wrote one
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
// While a wake is held, the mod tries again at most this far apart, so a session that comes back gets it within seconds.
export const HELD_RETRY_MS = 5000
// The status line the mod pins while wakes are held: what Claude Code said, and what happens next. '' when none is held.
export const heldNotice = (n, why = 'unbound') => (n > 0 ? `belay: ${n} wake${n === 1 ? '' : 's'} not delivered: ${why === 'other-session' ? 'this window holds a session that is not the orchestrator session' : 'Claude Code says no session is open in this window'}; ${n === 1 ? 'it is' : 'they are'} sent when the orchestrator session is back` : '')
// The toast once held wakes have gone out.
export const releasedNotice = (n) => `belay: ${n} held wake${n === 1 ? '' : 's'} delivered now that the session is back`

// Delivery (ADR 0037 amendment 5, item 7 as amended), at least once per id and in the order the wakes came. A wake is submitted
// first and recorded after: a crash or reload between the two delivers it again on the next load, and its ref id (ADR 0074
// amendment 1) lets the reader see that it is the same wake. A wake that cannot be submitted now, because Claude Code says no
// session is bound or because this window holds a session other than the orchestrator's (`io.bound`), is held: nothing is written,
// it stays first in line, and every later wake waits behind it. Any other submit failure is recorded and never re-run. A record
// write that fails is tried again; the wake is not submitted again for it.
// `io` = { write(file, content) -> Promise, submit(text) -> Promise, log(entry), bound?() -> Promise<boolean> }; `initial` is the file's text.
// Each id is logged once per kind: the first hold, the delivery after a hold, a submit failure, a record write that failed.
export function createDelivery({ file, initial = '', io, now = () => Date.now(), cap = capText }) {
  let content = String(initial || '')
  const delivered = parseDelivered(content)
  const pending = new Map() // id -> text, in arrival order: a held wake first, then every wake that came behind it
  const held = new Set() // the ids in pending that could not be submitted for want of a bound session
  const unrecorded = new Set() // submitted (or failed for good) but the record write failed: written again, never submitted again
  const logged = new Set()
  let released = 0 // held wakes delivered since the last read of it (takeReleased)
  let heldWhy = null // 'unbound' | 'other-session': why the first held wake was last refused
  const logOnce = (id, stage, entry) => {
    if (logged.has(`${stage}:${id}`)) return
    logged.add(`${stage}:${id}`)
    try { io.log({ at: now(), id, stage, ...entry }) } catch { /* nowhere to log */ }
  }
  const record = async (id) => {
    const next = content + deliveredLine(id, now())
    try { await io.write(file, next) } catch (e) { unrecorded.add(id); logOnce(id, 'write', { error: String((e && e.message) || e) }); return false }
    content = next
    unrecorded.delete(id)
    return true
  }
  const done = new Map() // id -> how the flush that took it ended
  const flush = async () => {
    for (const id of [...unrecorded]) await record(id)
    for (const [id, text] of [...pending]) {
      let bound = true
      if (io.bound) { try { bound = (await io.bound()) !== false } catch { bound = false } }
      let error = null
      if (bound) { try { await io.submit(cap(text)) } catch (e) { error = String((e && e.message) || e) } }
      if (!bound || (error !== null && isUnboundSubmit(error))) {
        heldWhy = bound ? 'unbound' : 'other-session'
        const why = error || 'this window holds a session that is not the orchestrator session'
        for (const w of pending.keys()) { held.add(w); logOnce(w, 'held', { held: true, error: why }) } // this one and everything behind it waits
        done.set(id, 'held')
        return
      }
      pending.delete(id)
      delivered.add(id)
      if (held.delete(id)) { released += 1; logOnce(id, 'released', {}) }
      if (error !== null) logOnce(id, 'submit', { error })
      done.set(id, error !== null ? 'submit-failed' : 'submitted')
      await record(id)
    }
  }
  const self = {
    delivered,
    pending,
    held,
    unrecorded,
    // Held wakes delivered since the last call. -> a count.
    takeReleased() { const n = released; released = 0; return n },
    get heldWhy() { return held.size ? heldWhy : null },
    // Tries the held wakes and the unwritten records again, in order; the caller schedules this while either is non-empty.
    async retryPending() { await flush(); return pending.size + unrecorded.size },
    // -> 'skip' (delivered before) | 'held' (waits, in order) | 'submitted' | 'submit-failed' (recorded, never re-run).
    async deliver(id, text) {
      if (delivered.has(id)) return 'skip'
      if (!pending.has(id)) pending.set(id, text)
      done.delete(id)
      await flush()
      return done.get(id) || 'held'
    },
  }
  return self
}
