'use strict';
// transcript-usage.cjs — usage of an interactive orchestrator, read from its Claude Code session
// transcript (~/.claude/projects/<encoded cwd>/<session-id>.jsonl). A headless agent gets cost and context
// from its stream-json `result` lines; an interactive session writes none, only assistant lines whose
// message.usage carries the tokens of each API message.
//
// Context: the last assistant message's input + cache_creation + cache_read tokens (sidechain turns, which
// are a sub-agent's own context, and `<synthetic>` messages are skipped), the same sum cmd-agents.cjs
// takes from a stream. The window is NOT in a transcript; the caller borrows it as it does for any agent.
//
// Cost is an ESTIMATE from the transcript, not a figure Claude Code reported: the tokens of each distinct
// message.id (one API message spans several jsonl lines; the last line of an id has its final output
// count, and each id is counted once), priced per model with PRICES. belay holds no price table of its
// own (workers take total_cost_usd from the stream), and none is invented here: a model with no entry in
// PRICES shows its tokens and no dollars.
//
// Reading never writes (invariant 6): the file is opened 'r' and nothing is created beside it. A cache
// (path -> byte offset, per-id usage, sums) is kept only when the caller passes one, i.e. in a process that
// lives across reads; a cold read parses the whole file in 4 MB chunks. A line with no newline yet is
// taken only if it parses as JSON, else left for the next read.

const fs = require('node:fs');

// Per million tokens: { input, output, cache_read, cache_write }, keyed by the exact message.model.
// Deliberately empty: add a model here only from a published rate the operator has confirmed.
const PRICES = Object.freeze({});

const CHUNK = 4 * 1024 * 1024;
const ASSISTANT = '"type":"assistant"';
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

function newState() {
  return { offset: 0, ids: new Map(), byModel: new Map(), last: null, messages: 0 };
}

function addTo(st, model, u, sign) {
  let m = st.byModel.get(model);
  if (!m) { m = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }; st.byModel.set(model, m); }
  m.input += sign * u.input; m.output += sign * u.output; m.cache_read += sign * u.cache_read; m.cache_creation += sign * u.cache_creation;
}

// false only for a line that looks like an assistant line and does not parse
function takeLine(st, line) {
  if (!line.includes(ASSISTANT)) return true;
  let j;
  try { j = JSON.parse(line); } catch { return false; }
  if (!j || j.type !== 'assistant' || !j.message || !j.message.usage || typeof j.message.usage !== 'object') return true;
  const msg = j.message;
  const model = typeof msg.model === 'string' ? msg.model : null;
  if (model === null || model === '<synthetic>') return true;
  const uu = msg.usage;
  const u = { input: num(uu.input_tokens), output: num(uu.output_tokens), cache_read: num(uu.cache_read_input_tokens), cache_creation: num(uu.cache_creation_input_tokens) };
  const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
  if (id !== null) {
    const prev = st.ids.get(id);
    if (prev) addTo(st, prev.model, prev.u, -1); else st.messages += 1;
    st.ids.set(id, { model, u });
  } else st.messages += 1;
  addTo(st, model, u, 1);
  if (j.isSidechain !== true) st.last = { model, context: u.input + u.cache_read + u.cache_creation };
  return true;
}

// Consume [st.offset, size) of the file. Only whole lines advance the offset.
function advance(st, fd, size) {
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, size - st.offset)));
  let carry = Buffer.alloc(0);
  let pos = st.offset;
  let bytes = 0;
  while (pos < size) {
    const want = Math.min(buf.length, size - pos);
    const n = fs.readSync(fd, buf, 0, want, pos);
    if (n <= 0) break;
    pos += n; bytes += n;
    const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    let start = 0;
    for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
      takeLine(st, data.toString('utf8', start, nl));
      st.offset += nl + 1 - start;
      start = nl + 1;
    }
    carry = Buffer.from(data.subarray(start)); // copied: buf is reused by the next read
  }
  if (carry.length && pos >= size) {
    const text = carry.toString('utf8');
    let whole = false;
    try { JSON.parse(text); whole = true; } catch { /* the writer is mid-line: left for the next read */ }
    if (whole) { takeLine(st, text); st.offset += carry.length; }
  }
  return bytes;
}

function costOf(byModel, prices) {
  let total = 0;
  const unpriced = [];
  for (const [model, t] of byModel) {
    const p = prices[model];
    if (!p) { if (t.input + t.output + t.cache_read + t.cache_creation > 0) unpriced.push(model); continue; }
    total += (t.input * p.input + t.output * p.output + t.cache_read * p.cache_read + t.cache_creation * p.cache_write) / 1e6;
  }
  return { usd: unpriced.length ? null : total, unpriced };
}

// readUsage(file, cache?, prices?) -> { exists, error, bytes_read, messages, model_seen, context_tokens, tokens, cost_usd, unpriced_models }
function readUsage(file, cache, prices = PRICES) {
  const none = { exists: false, error: null, bytes_read: 0, messages: 0, model_seen: null, context_tokens: null, tokens: null, cost_usd: null, unpriced_models: [] };
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return e.code === 'ENOENT' ? none : { ...none, error: e.code || 'unreadable' }; }
  try {
    const size = fs.fstatSync(fd).size;
    let st = cache && cache.get(file);
    if (!st || size < st.offset) { st = newState(); if (cache) cache.set(file, st); }
    const bytes_read = advance(st, fd, size);
    const tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
    for (const t of st.byModel.values()) { tokens.input += t.input; tokens.output += t.output; tokens.cache_read += t.cache_read; tokens.cache_creation += t.cache_creation; }
    const cost = costOf(st.byModel, prices);
    return {
      exists: true, error: null, bytes_read, messages: st.messages,
      model_seen: st.last ? st.last.model : null, context_tokens: st.last ? st.last.context : null,
      tokens: st.messages ? tokens : null, cost_usd: st.messages ? cost.usd : null, unpriced_models: cost.unpriced,
    };
  } catch (e) {
    return { ...none, error: e.code || 'unreadable' };
  } finally { fs.closeSync(fd); }
}

function readSmall(file) {
  try { const st = fs.statSync(file); return st.isFile() && st.size <= 1024 * 1024 ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; }
}

// The session transcript of this run's interactive orchestrator, or null. Sources, in order: the launch
// marker (run-start.json, this run and epoch: its session_file, else a search for its session_id), then the
// closing receipt (run.json, this run: orchestrator.interactive.session_file).
function sessionFileOf(orchDir, run, exists = fs.existsSync) {
  const m = readSmall(`${orchDir}/run-start.json`);
  if (m && m.run_id === run.id && m.epoch === run.epoch) {
    if (typeof m.session_file === 'string' && exists(m.session_file)) return m.session_file;
    if (typeof m.session_id === 'string' && m.session_id) {
      try {
        const found = require('../run/interactive-surface.cjs').findSessionFile({ cwd: '', sessionId: m.session_id, exists });
        if (found) return found;
      } catch { /* fall through to the receipt */ }
    }
  }
  const r = readSmall(`${orchDir}/run.json`);
  const f = r && r.run_id === run.id && r.orchestrator && r.orchestrator.interactive && r.orchestrator.interactive.session_file;
  return typeof f === 'string' && exists(f) ? f : null;
}

module.exports = { readUsage, sessionFileOf, PRICES };
