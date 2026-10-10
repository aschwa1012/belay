'use strict';
// bottle.cjs: the replace-branch resume document built from the worker's own stream (ADR 0042 section 4).
// buildBottle is a pure function of the stream file's bytes and the observations: no clock. Every text
// message is kept verbatim and in order, every tool call becomes one line, and all of it passes through
// redaction because the verbatim render is the path that would otherwise bypass it. Any failure returns
// `fallback` (a code) and no text, and the caller uses today's continuity.resumeDoc.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fit } = require('../core/fit-budget.cjs');

const DEFAULT_MAX = 65536;
const CEILING_MAX = 262144;
const KEEP_LAST = 20;
const TARGET_MAX = 120;
const HEADER = 'Conversation so far, replayed from the interrupted session. Text messages are verbatim; each tool call is one line; lines marked (generated) were written by belay.';

const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '...' : s);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// Only complete lines count: a final line without its newline may be half written (the replay rule).
function parseStream(raw) {
  const end = raw.lastIndexOf('\n');
  if (end < 0) return [];
  const events = [];
  for (const line of raw.slice(0, end).split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a damaged line is skipped, as the parsers do */ }
  }
  return events;
}

function resultFacts(block) {
  const text = textOf(block.content);
  const lines = text === '' ? 0 : text.split('\n').length;
  const m = /^Exit code (\d+)/.exec(text);
  return { lines, is_error: block.is_error === true, exit: m ? Number(m[1]) : null };
}

function targetOf(use) {
  const i = use.input || {};
  const t = i.command || i.file_path || i.path || i.notebook_path || i.pattern || i.url || '';
  return clip(oneLine(t), TARGET_MAX);
}

// Exit data for a call: the capture data in the observations first, then the result itself.
function exitOf(use, facts, captured) {
  if (captured && captured.exit_code !== undefined && captured.exit_code !== null) {
    return { code: captured.exit_code, source: captured.exit_code_source || 'reported' };
  }
  if (!facts) return null;
  if (facts.exit !== null) return { code: facts.exit, source: 'reported' };
  if (use.name === 'Bash' && !facts.is_error) return { code: 0, source: 'no-error' };
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
  const map = new Map();
  const byTurn = new Map();
  for (const o of observations || []) {
    const body = o && o.body && typeof o.body === 'object' ? o.body : null;
    if (!body) continue;
    if (Number.isInteger(body.turn) && o.title) byTurn.set(body.turn, o.title);
    for (const c of body.commands || []) if (c && typeof c.command === 'string') map.set(oneLine(c.command), c);
  }
  return { map, byTurn };
}

function collect(events, observations) {
  const results = new Map();
  for (const e of events) {
    const c = e && e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const b of c) if (b && b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, resultFacts(b));
  }
  const cap = capturedCommands(observations);
  const entries = [];
  let turn = 1;
  for (const e of events) {
    if (!e) continue;
    if (e.type === 'result') { turn += 1; continue; }
    if ((e.type !== 'assistant' && e.type !== 'user') || !e.message || e.parent_tool_use_id) continue;
    const text = textOf(e.message.content);
    if (text.trim()) entries.push({ kind: 'text', role: e.type, text: `${e.type}: ${text}` });
    if (e.type !== 'assistant' || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (!b || b.type !== 'tool_use') continue;
      const captured = b.name === 'Bash' && b.input ? cap.map.get(oneLine(b.input.command || '')) : null;
      entries.push({ kind: 'tool', text: toolLine(b, results.get(b.id), captured, cap.byTurn.get(turn)) });
    }
  }
  return entries;
}

const failed = (fallback, extra = {}) => ({
  text: '', bytes: 0, messages: 0, tool_calls_replaced: 0, dropped: 0, over_budget: false, fallback, ...extra,
});

function loadRedact(redact) {
  if (typeof redact === 'function') return redact;
  try { return require('../core/redact.cjs').redact; } catch { return null; }
}

function buildBottle({ streamPath, observations = [], maxBytes = DEFAULT_MAX, redact } = {}) {
  const max = Math.min(Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX, CEILING_MAX);
  // No redactor means no bottle: the verbatim render must never go out unredacted.
  const scrub = loadRedact(redact);
  if (!scrub) return failed('E_REDACT_ABSENT');
  let raw;
  try { raw = fs.readFileSync(streamPath, 'utf8'); } catch { return failed('E_STREAM_UNREADABLE'); }

  const entries = collect(parseStream(raw), observations);
  if (!entries.some((e) => e.kind === 'text')) return failed('E_EMPTY');

  // Pinned: the task spec (the first user message), the last 20 messages, the last assistant message.
  const textIdx = entries.map((e, i) => (e.kind === 'text' ? i : -1)).filter((i) => i >= 0);
  const pinned = new Set(textIdx.slice(-KEEP_LAST));
  const firstUser = textIdx.find((i) => entries[i].role === 'user');
  if (firstUser !== undefined) pinned.add(firstUser);
  const lastAssistant = textIdx.filter((i) => entries[i].role === 'assistant').pop();
  if (lastAssistant !== undefined) pinned.add(lastAssistant);

  let redactions = 0;
  const items = entries.map((e, i) => {
    const r = scrub(e.text);
    redactions += Array.isArray(r.redactions) ? r.redactions.length : Number(r.redactions) || 0;
    return { id: i, text: r.text, priority: pinned.has(i) ? 1 : 0 };
  });

  let result;
  let header = HEADER;
  for (let pass = 0; pass < 4; pass += 1) {
    result = fit(items, { max_bytes: max, header, drop_order: 'priority-then-oldest' });
    const next = result.dropped ? `${HEADER}\n[${result.dropped} earlier items omitted to fit ${max} bytes]` : HEADER;
    if (next === header) break;
    header = next;
  }
  if (result.over_budget || [...pinned].some((i) => !result.kept.includes(i))) {
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
