'use strict';
// compaction.cjs — ADR 0007 decision 3 and 7, build 12 wave 3: the harness-driven compaction trigger, behind the
// run lever `compact_at_tokens` (null by default). Claude Code workers only; Codex has no stdin message to send.
//
// With the lever null nothing here runs: no hook in the settings file, no stdin write, no file, no row. With it
// set, a worker's per-call context (the last call's input + cache tokens, keyed by message.id in the parser) is
// read at every turn end; at or above the lever, and with no turn running, `/compact <instructions>` goes to its
// stdin as its own turn. Every compaction the substrate reports (`compact_boundary`), the harness's own or
// Claude Code's automatic one (headless -p compacts on its own near 967k on 2.1.288, REPORT.md autocompaction-2),
// is recorded in <worker dir>/compactions.jsonl with the bytes the hooks injected (invariant 9: <= 400 per event).
//
// Three hooks sit in the worker's --settings file (compact-hook.cjs): PreCompact prints the steering text,
// PostCompact only records, SessionStart `compact` injects the resume line the harness wrote to
// <worker dir>/compact-resume.txt (derived from the store, refreshed at every turn end while the lever is set: one
// core.continuity.resumeLine read per turn end of a worker that holds a task, no write, no embedder).
//
// The harness's own /compact turn is invisible as a worker turn (swallow): it adds no turn, answers no waiter, writes no
// turn count, so neither the wake nor worker_wait reports it as work. A message sent while it is in flight is refused
// E_BUSY (refuseIfCompacting), never held: a held message would be stranded by a pause or park. The inflight flag clears
// on the compaction turn's end, on a relaunch, or after INFLIGHT_MAX_MS.

const fs = require('node:fs');
const path = require('node:path');

const INFLIGHT_MAX_MS = 300000; // the probe measured 7 to 28 s; five minutes is a stuck compaction
const HOOK_MAX_BYTES = 400; // invariant 9, ADR 0007 decision 7
const HOOKS_LOG = 'compact-hooks.jsonl'; // written by the hook processes
const RECORDS_LOG = 'compactions.jsonl'; // written by the harness
const RESUME_FILE = 'compact-resume.txt';
// The steering text the PreCompact hook prints: generic task state, no probe-specific words (<= 400 bytes, invariant 9).
const STEER = 'Preserve verbatim, under a heading TASK-STATE: the task id and goal, decisions made and why, open findings and questions, files touched, and the exact next step. Keep everything else short.';
const INSTRUCTIONS = 'Keep the task id, the task state, the files touched and the exact next step verbatim.';
const fwd = (p) => String(p).split('\\').join('/');

// A positive safe integer, or null/undefined for off. Returns { value } or { error }.
function parseCompactAt(v) {
  if (v === undefined || v === null) return { value: null };
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return { error: 'compact_at_tokens must be null or a positive integer' };
  return { value: v };
}

// The SessionStart `compact` hook's whole stdout for a resume line, truncated so the emitted JSON (wrapper and
// escapes included) is at most HOOK_MAX_BYTES. Returns '' for an empty line.
function startOutput(line) {
  let s = String(line || '').trim();
  const wrap = (t) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: t } });
  while (s && Buffer.byteLength(wrap(s), 'utf8') > HOOK_MAX_BYTES) s = s.slice(0, Math.max(0, s.length - Math.max(1, Math.ceil(s.length / 20))));
  return s ? wrap(s) : '';
}

// The hooks block for a worker's settings file, or null when the lever is off.
function hooksBlock({ dir, compactAt }) {
  if (compactAt == null) return null;
  const cmd = (label) => ({ type: 'command', command: `"${fwd(process.execPath)}" "${fwd(path.join(__dirname, 'compact-hook.cjs'))}" ${label} "${fwd(dir)}"`, timeout: 30 });
  return {
    PreCompact: [{ matcher: 'auto', hooks: [cmd('pre')] }, { matcher: 'manual', hooks: [cmd('pre')] }],
    PostCompact: [{ hooks: [cmd('post')] }],
    SessionStart: [{ matcher: 'compact', hooks: [cmd('start')] }],
  };
}

function state(w) {
  if (!w.cp) w.cp = { inflight: null, pending: null, hookLines: 0, sent: 0, records: [], sentIdx: new Set() };
  if (!w.cp.sentIdx) w.cp.sentIdx = new Set();
  return w.cp;
}

const resumeFallback = (w) => `[belay resume] worker=${w.id}${w.taskId ? ` task=${w.taskId}` : ''}; continue with the conversation.`;

function writeResume(w, line) {
  try { fs.writeFileSync(path.join(w.dir, RESUME_FILE), String(line).slice(0, 2000)); } catch (e) { w.lastError = { where: 'compaction.resume', message: e && e.message }; }
}

// Per launch: forget a previous process's in-flight request, and seed the resume line so a compaction that
// happens before the first turn ends (an automatic one) still has a line to inject.
function onAttach(w, ctx) {
  if (ctx.compactAt == null || w.substrate !== 'claude-code') return;
  const s = state(w);
  s.inflight = null; s.pending = null; s.sentIdx.clear(); // write indices restart with the process
  writeResume(w, resumeFallback(w));
}

function readHookLines(w) {
  try { return fs.readFileSync(path.join(w.dir, HOOKS_LOG), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

function finalize(w, ctx) {
  const s = state(w);
  const p = s.pending;
  if (!p) return;
  s.pending = null;
  const lines = readHookLines(w);
  const mine = lines.slice(s.hookLines);
  s.hookLines = lines.length;
  const sum = (label) => mine.filter((h) => h.label === label).reduce((a, h) => a + (h.emitted_bytes || 0), 0);
  const rec = {
    at: p.at, worker_id: w.id, trigger: p.trigger, requested_by: p.inflight ? 'harness' : 'substrate',
    threshold: ctx.compactAt, pre_tokens: p.pre_tokens != null ? p.pre_tokens : (p.inflight ? p.inflight.pre_ctx : null),
    post_tokens: p.post_tokens, post_from: p.post_from, duration_ms: p.duration_ms,
    wall_ms: p.inflight ? p.at - p.inflight.at : null,
    steer_bytes: sum('pre'), resume_bytes: sum('start'), summary_payload_bytes: mine.filter((h) => h.label === 'post').reduce((a, h) => a + (h.payload_bytes || 0), 0),
    max_hook_bytes: mine.reduce((a, h) => Math.max(a, h.emitted_bytes || 0), 0),
  };
  s.records.push(rec);
  try { fs.appendFileSync(path.join(w.dir, RECORDS_LOG), JSON.stringify(rec) + '\n'); } catch (e) { w.lastError = { where: 'compaction.record', message: e && e.message }; }
}

// The pending boundary becomes a record once its post context is known (or one turn later without it).
function settlePending(w, ctx) {
  const s = state(w);
  if (!s.pending) return;
  if (s.pending.post_tokens != null || s.pending.waited) finalize(w, ctx); else s.pending.waited = true;
}

// Called for every parsed event of a lever-on worker (worker.cjs ingest).
function note(w, e, ctx) {
  if (ctx.compactAt == null) return;
  if (e.kind === 'compact_boundary') {
    const s = state(w);
    s.pending = {
      at: e.at, trigger: e.trigger, pre_tokens: e.pre_tokens, post_tokens: e.post_tokens, duration_ms: e.duration_ms,
      post_from: e.post_tokens != null ? 'compact_metadata.post_tokens' : null, inflight: s.inflight, waited: false,
    };
    if (s.inflight) s.inflight.boundary = true;
  } else if (e.kind === 'call_context') {
    const s = state(w);
    if (s.pending && s.pending.post_tokens == null) {
      s.pending.post_tokens = e.context_tokens; s.pending.post_from = 'first_post_call_ctx (fallback)';
      finalize(w, ctx);
    }
  }
}

const expired = (s) => !!(s.inflight && Date.now() - s.inflight.at > INFLIGHT_MAX_MS);

// First thing in onTurnEnd (worker.cjs). True when `e` is the end of the harness's own /compact turn, which is then
// accounted without being a turn: tokens and cost are added, `turns`, the waiters and the checkpoint are not touched.
// Not while a park is under way (the pause reads that turn's result), and not for an end that answers another write.
function swallow(w, e, ctx) {
  if (ctx.compactAt == null || w.substrate !== 'claude-code') return false;
  const s = state(w);
  // A turn end answering a /compact the harness wrote is that compaction's, however late (past INFLIGHT_MAX_MS) and
  // whether or not a park is under way: the write index is the mark, the inflight flag alone is not.
  const known = e.answers_write != null && s.sentIdx.has(e.answers_write);
  if (!known) {
    if (!s.inflight || w.parkRequested) return false;
    const mine = e.answers_write === s.inflight.idx || s.inflight.boundary || e.answers_write == null || expired(s);
    if (!mine) return false;
  }
  const u = e.usage || {};
  const n = (x) => (typeof x === 'number' ? x : 0);
  w.inputTokens += n(u.input_tokens); w.outputTokens += n(u.output_tokens);
  w.cacheReadTokens += n(u.cache_read_input_tokens); w.cacheCreationTokens += n(u.cache_creation_input_tokens);
  if (typeof e.cost_usd === 'number') w.costUsd = e.cost_usd;
  w.turnEnded = true; w.lastTurnEndAt = Date.now(); w.pendingTurnEnd = null;
  // A park reads the results after its interrupt (pause.cjs doPause): a compaction cut short is one of them.
  const afterInterrupt = !!(w.parkRequested && e.at >= w.parkRequested.interruptAt);
  if (afterInterrupt) w.parkRequested.resultsSeen.push(e.subtype);
  if (known) { s.sentIdx.delete(e.answers_write); if (s.inflight && s.inflight.idx === e.answers_write) s.inflight = null; } else s.inflight = null;
  settlePending(w, ctx);
  // A waiter registered during the compaction on an idle worker is answered with the last real turn, as it would have
  // been had it come a moment earlier. Not when a message was written after the compaction's own write (accepted past the
  // expiry): the waiter is that message's, and only its own reply answers it.
  const laterWrite = e.answers_write != null && !!w.parser && w.parser.writeIndex > e.answers_write;
  if (!laterWrite) for (const r of w.turnWaiters.splice(0)) r({ usage: w.lastTurnUsage, checkpoint_id: w.lastCheckpointId, is_error: false, paused: afterInterrupt });
  return true;
}

function sendRaw(w, text) {
  w.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
  return w.parser.noteStdinWrite();
}
const live = (w, ctx) => w.child && w.child.stdin && !w.child.stdin.destroyed && !w.settled && !w.stopRequested
  && !w.parkRequested && !w.paused && !(ctx.shutdownFlags && ctx.shutdownFlags.closed);

// After a swallowed compaction turn: the row says the worker is no longer mid-turn.
async function afterCompact(w, ctx) {
  if (w.parkRequested) return; // as onTurnEnd: a park's own exit handler writes the only row it produces (6e-5 item 3)
  try { await ctx.writeRow(w, 'running'); } catch (err) { w.lastError = { where: 'compaction.write', code: err && err.code, message: err && err.message }; }
}

// manager.message, before it writes: while the harness's /compact is in flight the message is refused E_BUSY (nothing is
// written, nothing held); the caller retries once the compaction's turn ends. No-op when nothing is in flight.
function refuseIfCompacting(w, fail) {
  const s = w.cp;
  if (!s || !s.inflight) return;
  if (expired(s)) { s.inflight = null; return; }
  const since = new Date(s.inflight.at).toISOString();
  fail('E_BUSY', `worker ${w.id} is compacting its context (started ${since}); retry when it ends`, { worker_id: w.id, op: 'compact', compaction_started_at: since });
}

// The store's resume line, into the file the SessionStart hook reads. A failure leaves the previous line and is recorded.
async function refreshResume(w, ctx) {
  if (!w.taskId || !ctx.core || !ctx.core.continuity || !ctx.core.continuity.resumeLine) return;
  try {
    const rl = await ctx.core.continuity.resumeLine({ task_id: w.taskId });
    if (rl && rl.text) writeResume(w, rl.text);
  } catch (err) { w.lastError = { where: 'compaction.resumeLine', code: err && err.code, message: err && err.message }; }
}

// Called at the end of onTurnEnd (worker.cjs), after the waiters and the row: the worker is between turns.
// `turnStarted` is worker.cjs's own; it is not awaited, because this runs inside the worker's queue.
async function afterTurn(w, e, ctx, turnStarted) {
  if (ctx.compactAt == null || w.substrate !== 'claude-code') return;
  if (ctx.shutdownFlags && ctx.shutdownFlags.closed) return; // a late turn end elects no store owner and starts no turn
  const s = state(w);
  settlePending(w, ctx);
  if (s.inflight) { // only reached for a turn end swallow() did not take (a park, or an end answering another write)
    if (e.answers_write === s.inflight.idx || s.inflight.boundary || expired(s)) s.inflight = null;
    return;
  }
  await refreshResume(w, ctx); // every turn end, so an automatic compaction injects a current line (ADR 0007 decision 2)
  const tokens = e.context_tokens;
  if (e.is_error || typeof tokens !== 'number' || tokens < ctx.compactAt) return;
  if (!live(w, ctx) || !w.turnEnded || s.inflight) return; // a message or a stop arrived while the store answered
  turnStarted(w, ctx, () => {
    const text = `/compact ${INSTRUCTIONS}`;
    s.sent += 1;
    const idx = sendRaw(w, text);
    s.sentIdx.add(idx);
    s.inflight = { at: Date.now(), idx, pre_ctx: tokens, boundary: false };
    return Buffer.byteLength(text, 'utf8');
  });
}

// For `belay receipts`: a plain read of a worker's compactions.jsonl, or null when it has none. Writes nothing.
function summarize(dataDir, workerId) {
  let rows;
  try {
    rows = fs.readFileSync(path.join(dataDir, 'workers', workerId, RECORDS_LOG), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && typeof r === 'object'); // a torn line is skipped
  } catch { return null; }
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  return {
    count: rows.length, harness: rows.filter((r) => r.requested_by === 'harness').length, auto: rows.filter((r) => r.trigger === 'auto').length,
    last_pre_tokens: last.pre_tokens, last_post_tokens: last.post_tokens, max_hook_bytes: rows.reduce((a, r) => Math.max(a, r.max_hook_bytes || 0), 0),
  };
}

module.exports = { parseCompactAt, hooksBlock, startOutput, onAttach, note, swallow, afterCompact, refuseIfCompacting, afterTurn, summarize, state, HOOK_MAX_BYTES, HOOKS_LOG, RECORDS_LOG, RESUME_FILE, STEER, INSTRUCTIONS };
