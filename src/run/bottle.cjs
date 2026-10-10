'use strict';
// bottle.cjs: the replace-branch resume document built from the worker's own stream (ADR 0042 section 4).
// buildBottle is a pure function of the stream file's bytes, the sent-message record and the observations: no
// clock. Every text message is kept verbatim and in order, every tool call becomes one line, and all of it
// passes through redaction because the verbatim render is the path that would otherwise bypass it. Any failure
// returns `fallback` (a code) and no text, and the caller uses today's continuity.resumeDoc.
//
// The user's side of the conversation does not come from the stream: belay's Claude launches do not pass
// --replay-user-messages, so a real stream holds no user text. The harness records what it writes to the
// worker's stdin (workers/<id>/sent.jsonl) and the bottle interleaves that record; without it the bottle
// says so in its header and reports user_messages: 'unrecorded'.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fit } = require('../core/fit-budget.cjs');

const DEFAULT_MAX = 65536;
const CEILING_MAX = 262144;
const KEEP_LAST = 20;
const TARGET_MAX = 120;
const MAX_PASSES = 8;
const HEADER = 'Conversation so far, replayed from the interrupted session. Text messages are verbatim; each tool call is one line; lines marked (generated) were written by belay.';
const UNRECORDED = 'The messages sent to this worker were not recorded: the task spec and any later message are not in this document.';

const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '...' : s);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// Only complete lines count: a final line without its newline may be half written (the replay rule).
function parseJsonl(raw) {
  const end = raw.lastIndexOf('\n');
  if (end < 0) return [];
  const rows = [];
  for (const line of raw.slice(0, end).split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a damaged line is skipped, as the parsers do */ }
  }
  return rows;
}

// The sent record: an array of { seq, turn, kind, text }, or the jsonl file the run manager wrote. Returns the
// usable rows in order, or null when there is no record (the caller says so; it never guesses).
function loadSent(sent, sentPath) {
  let rows = null;
  if (Array.isArray(sent)) rows = sent;
  else if (typeof sentPath === 'string' && sentPath) {
    try { rows = parseJsonl(fs.readFileSync(sentPath, 'utf8')); } catch { rows = null; }
  }
  if (!rows) return null;
  const out = [];
  let turn = 1;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || typeof r.text !== 'string' || !r.text.trim()) continue;
    if (Number.isInteger(r.turn) && r.turn >= 1) turn = r.turn;
    out.push({ seq: Number.isFinite(r.seq) ? r.seq : out.length + 1, turn, kind: typeof r.kind === 'string' ? r.kind : 'message', text: r.text });
  }
  return out.sort((a, b) => (a.turn - b.turn) || (a.seq - b.seq));
}

function resultFacts(block) {
  const text = textOf(block.content);
  const lines = text === '' ? 0 : text.split('\n').length;
  const m = /^Exit code (-?\d+)/.exec(text);
  return { lines, is_error: block.is_error === true, exit: m ? Number(m[1]) : null };
}

function targetOf(use) {
  const i = use.input || {};
  const t = i.command || i.file_path || i.path || i.notebook_path || i.pattern || i.url || '';
  return clip(oneLine(t), TARGET_MAX);
}

// Exit data for a call. The stream's own `Exit code N` first; then the capture data for that exact call (matched
// by tool_use_id, never by command text, so the same command run twice keeps its two codes); then a Bash result
// that is not an error, which ran to exit 0.
function exitOf(use, facts, captured) {
  if (facts && facts.exit !== null) return { code: facts.exit, source: 'reported' };
  if (captured && Number.isInteger(captured.exit_code)) return { code: captured.exit_code, source: captured.exit_code_source || 'reported' };
  if (facts && use.name === 'Bash' && !facts.is_error) return { code: 0, source: 'no-error' };
  return null;
}

function toolLine(use, facts, captured, turnTitle) {
  const target = targetOf(use);
  let head = target ? `${use.name}: ${target}` : use.name;
  const ex = exitOf(use, facts, captured);
  if (ex) head += ` -> exit ${ex.code} (${ex.source})`;
  else if (facts && facts.is_error) head += ' -> error';
  const tail = facts ? `${facts.lines} lines` : 'no result';
  let line = `[tool ${head}; ${tail}`;
  // No capture data for this call: the turn's observation title stands in, labelled as generated.
  if (!ex && turnTitle) line += `; turn summary (generated): ${clip(oneLine(turnTitle), TARGET_MAX)}`;
  return line + ']';
}

function capturedCommands(observations) {
  const byId = new Map(); // tool_use_id -> the captured command entry
  const byTurn = new Map();
  for (const o of observations || []) {
    const body = o && o.body && typeof o.body === 'object' ? o.body : null;
    if (!body) continue;
    if (Number.isInteger(body.turn) && o.title) byTurn.set(body.turn, o.title);
    for (const c of body.commands || []) if (c && typeof c.tool_use_id === 'string' && c.tool_use_id) byId.set(c.tool_use_id, c);
  }
  return { byId, byTurn };
}

const sentEntry = (r, spec) => ({
  kind: 'text', role: 'user', spec,
  text: r.kind === 'wake' || r.kind === 'resume' || r.kind === 'compact' ? `user (generated, ${r.kind}): ${r.text}` : `user: ${r.text}`,
});

function collect(events, observations, sent) {
  const results = new Map();
  for (const e of events) {
    const c = e && e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const b of c) if (b && b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, resultFacts(b));
  }
  const cap = capturedCommands(observations);
  const entries = [];
  const pending = sent ? sent.slice() : [];
  // A stream user-text line that repeats a sent message (a future --replay-user-messages) is the same message.
  const dupes = new Map();
  for (const r of pending) dupes.set(r.text.trim(), (dupes.get(r.text.trim()) || 0) + 1);
  const specSeq = sent && sent.length ? (sent.find((r) => r.kind === 'task') || sent[0]).seq : null;
  let streamUser = 0;
  let turn = 1;
  const emitSent = (through) => {
    while (pending.length && pending[0].turn <= through) {
      const r = pending.shift();
      entries.push(sentEntry(r, r.seq === specSeq));
    }
  };
  emitSent(turn);
  for (const e of events) {
    if (!e) continue;
    if (e.type === 'result') { turn += 1; emitSent(turn); continue; }
    if ((e.type !== 'assistant' && e.type !== 'user') || !e.message || e.parent_tool_use_id) continue;
    const text = textOf(e.message.content);
    if (text.trim()) {
      const left = e.type === 'user' ? dupes.get(text.trim()) : 0;
      if (left > 0) dupes.set(text.trim(), left - 1);
      else {
        if (e.type === 'user') streamUser += 1;
        entries.push({ kind: 'text', role: e.type, spec: false, text: `${e.type}: ${text}` });
      }
    }
    if (e.type !== 'assistant' || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (!b || b.type !== 'tool_use') continue;
      entries.push({ kind: 'tool', text: toolLine(b, results.get(b.id), cap.byId.get(b.id), cap.byTurn.get(turn)) });
    }
  }
  emitSent(Infinity); // sent but not yet answered when the stream ended
  return { entries, streamUser };
}

const failed = (fallback, extra = {}) => ({
  text: '', bytes: 0, messages: 0, tool_calls_replaced: 0, dropped: 0, over_budget: false, user_messages: null, fallback, ...extra,
});

function loadRedact(redact) {
  if (typeof redact === 'function') return redact;
  try { return require('../core/redact.cjs').redact; } catch { return null; }
}

// buildBottle({ streamPath, sent | sentPath, observations, maxBytes, redact }). `redact` has the signature of
// src/core/redact.cjs: redact(text) -> { text, redactions }.
function buildBottle({ streamPath, sent, sentPath, observations = [], maxBytes = DEFAULT_MAX, redact } = {}) {
  const max = Math.min(Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX, CEILING_MAX);
  // No redactor means no bottle: the verbatim render must never go out unredacted.
  const scrub = loadRedact(redact);
  if (!scrub) return failed('E_REDACT_ABSENT');
  let raw;
  try { raw = fs.readFileSync(streamPath, 'utf8'); } catch { return failed('E_STREAM_UNREADABLE'); }

  const sentRows = loadSent(sent, sentPath);
  const { entries, streamUser } = collect(parseJsonl(raw), observations, sentRows);
  if (!entries.some((e) => e.kind === 'text')) return failed('E_EMPTY');
  const userMessages = sentRows ? 'recorded' : (streamUser ? 'stream' : 'unrecorded');

  // Pinned: the task spec (the first sent message, else the first user message in the stream), the last 20
  // messages, the last assistant message.
  const textIdx = entries.map((e, i) => (e.kind === 'text' ? i : -1)).filter((i) => i >= 0);
  const pinned = new Set(textIdx.slice(-KEEP_LAST));
  const spec = textIdx.find((i) => entries[i].spec);
  const firstUser = spec !== undefined ? spec : textIdx.find((i) => entries[i].role === 'user');
  if (firstUser !== undefined) pinned.add(firstUser);
  const lastAssistant = textIdx.filter((i) => entries[i].role === 'assistant').pop();
  if (lastAssistant !== undefined) pinned.add(lastAssistant);

  let redactions = 0;
  const items = [];
  for (let i = 0; i < entries.length; i += 1) {
    const r = scrub(entries[i].text);
    // A redactor that answers in another shape is a failed redaction: nothing unscrubbed goes into a bottle.
    if (!r || typeof r.text !== 'string') return failed('E_REDACT');
    redactions += Array.isArray(r.redactions) ? r.redactions.length : Number(r.redactions) || 0;
    items.push({ id: i, text: r.text, priority: pinned.has(i) ? 1 : 0 });
  }

  // The header states how many items were omitted, and that count changes the header's size, so iterate until
  // the declared count equals the real one. The result carries a trailing newline: fit to one byte under.
  const head = userMessages === 'unrecorded' ? `${HEADER}\n[${UNRECORDED}]` : HEADER;
  let declared = 0;
  let result;
  let converged = false;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const header = declared ? `${head}\n[${declared} earlier items omitted to fit ${max} bytes]` : head;
    result = fit(items, { max_bytes: max - 1, header, drop_order: 'priority-then-oldest' });
    if (result.dropped === declared) { converged = true; break; }
    declared = result.dropped;
  }
  if (!converged || result.over_budget || [...pinned].some((i) => !result.kept.includes(i))) {
    return failed('E_OVER_BUDGET', { dropped: result.dropped, over_budget: true });
  }
  const kept = new Set(result.kept);
  const text = result.text + '\n';
  return {
    text,
    bytes: bytesOf(text),
    messages: entries.filter((e, i) => e.kind === 'text' && kept.has(i)).length,
    tool_calls_replaced: entries.filter((e, i) => e.kind === 'tool' && kept.has(i)).length,
    dropped: result.dropped,
    over_budget: false,
    user_messages: userMessages,
    fallback: null,
    redactions,
  };
}

// A temp file beside the target, then a rename, so a reader sees the old file or the whole new one.
function writeAtomic(file, text) {
  const target = path.resolve(file).replace(/\\/g, '/');
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
  return { path: target, bytes: bytesOf(text) };
}

module.exports = { buildBottle, writeAtomic, DEFAULT_MAX, CEILING_MAX, KEEP_LAST };
