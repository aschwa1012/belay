'use strict';
// sent-log.cjs: the record of what the harness writes to a worker's stdin (ADR 0042 section 4, "the sent
// record"). belay's Claude launches pass no --replay-user-messages, so the stream holds no user text and the
// bottle cannot learn the task spec or a later message from it. The run manager is the only writer to a
// worker's stdin, so it records each message here: one JSON line of workers/<id>/sent.jsonl,
// { seq, turn, kind: 'task' | 'message' | 'wake' | 'resume', text }.
//
// Only with `memory.bottle` on; with it off nothing here reads, writes or creates anything. `turn` is the
// 1-based turn the message starts or is folded into, counted the way bottle.cjs counts: one more than the
// number of top-level `result` lines the stream holds when the message is written. The text is redacted
// before it is written (a message that cannot be redacted is not written, and that is named). The record is
// append-only and never blocks or fails the write it records: a failure lands on `w.lastError` and in
// `w.sentFailures`, which `flush` turns into a `memory_event` later.

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'sent.jsonl';
const KINDS = ['task', 'message', 'wake', 'resume'];

const sentPath = (w) => path.join(w.dir, FILE).replace(/\\/g, '/');

// Results in the stream so far, scanned from where the last call stopped. Only complete lines count (the
// replay rule), so a half-written final line is left for the next call. The counter lives on the worker.
function resultsSoFar(w) {
  const s = w.sentScan || (w.sentScan = { offset: 0, results: 0 });
  let fd;
  try { fd = fs.openSync(w.streamPath, 'r'); } catch { return s.results; } // no stream yet: no turn has ended
  try {
    const size = fs.fstatSync(fd).size;
    if (size < s.offset) { s.offset = 0; s.results = 0; } // a replaced stream starts the count again
    const buf = Buffer.alloc(size - s.offset);
    const n = fs.readSync(fd, buf, 0, buf.length, s.offset);
    const end = buf.subarray(0, n).lastIndexOf(0x0a);
    if (end < 0) return s.results;
    for (const line of buf.toString('utf8', 0, end).split('\n')) {
      if (!line.includes('"result"')) continue;
      try { if (JSON.parse(line).type === 'result') s.results += 1; } catch { /* a damaged line is skipped */ }
    }
    s.offset += end + 1;
  } finally { fs.closeSync(fd); }
  return s.results;
}

// The next sequence number: one past the last line already in the file (a relaunch or an adopted worker
// continues the record), read once and then counted on the worker.
function nextSeq(w) {
  if (w.sentSeq === undefined) {
    let last = 0;
    try {
      for (const line of fs.readFileSync(sentPath(w), 'utf8').split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (Number.isFinite(r.seq) && r.seq > last) last = r.seq; } catch { /* skipped */ }
      }
    } catch { /* no file yet */ }
    w.sentSeq = last;
  }
  w.sentSeq += 1;
  return w.sentSeq;
}

function redactorOf(ctx) {
  if (ctx && ctx.modules && typeof ctx.modules.redact === 'function') return ctx.modules.redact;
  return require('../core/redact.cjs').redact;
}

function failure(w, e) {
  const f = { where: 'sent-log', code: (e && typeof e.code === 'string' && e.code.startsWith('E_')) ? e.code : 'E_SENT_LOG', message: String((e && e.message) || e).slice(0, 300) };
  w.lastError = f;
  (w.sentFailures || (w.sentFailures = [])).push(f);
}

// Record one message the harness just wrote to the worker's stdin. Returns the line written, or null (lever
// off, or a failure that was named). Never throws.
function record(w, ctx, kind, text) {
  const lv = ctx && ctx.memoryLevers;
  if (!lv || !lv.bottle) return null;
  try {
    if (!KINDS.includes(kind)) throw Object.assign(new Error(`sent record kind ${JSON.stringify(kind)} is not one of ${KINDS.join(', ')}`), { code: 'E_ARGS' });
    const r = redactorOf(ctx)(String(text));
    if (!r || typeof r.text !== 'string') throw Object.assign(new Error('the redactor answered without a string text, so the message was not recorded'), { code: 'E_REDACT' });
    const row = { seq: nextSeq(w), turn: resultsSoFar(w) + 1, kind, text: r.text };
    fs.appendFileSync(sentPath(w), JSON.stringify(row) + '\n');
    return row;
  } catch (e) {
    failure(w, e);
    return null;
  }
}

// The failures `record` kept, as `memory_event`s of kind bottle with ok 0 (the receipt is later than the
// failure because the write that failed was synchronous). Returns how many were recorded.
async function flush(w, ctx) {
  const pending = (w.sentFailures || []).splice(0);
  let n = 0;
  for (const f of pending) {
    try {
      await ctx.core.memory.recordEvent({ worker_id: w.id, task_id: w.taskId || undefined, kind: 'bottle', ok: 0, code: f.code, message: `sent record: ${f.message}` });
      n += 1;
    } catch (e) {
      w.lastError = { where: 'memory.recordEvent', code: e && e.code, message: e && e.message };
    }
  }
  return n;
}

module.exports = { record, flush, sentPath, FILE, KINDS };
