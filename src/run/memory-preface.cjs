'use strict';
// memory-preface.cjs — what the run manager puts in front of a worker's first message, and the thin memory
// hooks the manager calls (ADR 0042 decisions 2 and 3, ADR 0041 decision 2). manager.cjs is at its line
// budget, so the opening-message assembly lives here and the manager keeps one-line calls.
//
// Every memory behaviour reads its lever first and returns before doing any work when the lever is off, so a
// run with the levers at their defaults sends the same bytes it sent before this file existed. A memory
// failure never refuses a spawn: the spawn goes ahead exactly as it would with the lever off, and the failure
// is a `memory_event` with ok 0 (and `w.lastError`), never silence.

const { fail } = require('./errors.cjs');
const { DEFAULTS, leversFor } = require('./memory-levers.cjs');

const codeOf = (e) => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');
const noteError = (w, where, e) => { w.lastError = { where, code: e && e.code, message: e && e.message }; };

// The run's levers, read once and kept on ctx so a launch can ask for them without waiting. A core without
// `run.get` is a test double and has the defaults. A failed read is not cached and is named on the worker:
// the run then proceeds with every lever off for this call, which is the only safe reading of an unknown.
async function levers(ctx, w, { receipt = false } = {}) {
  if (ctx.memoryLevers) return ctx.memoryLevers;
  if (!ctx.core || !ctx.core.run || typeof ctx.core.run.get !== 'function') return { ...DEFAULTS };
  try {
    ctx.memoryLevers = await leversFor(ctx.core, ctx.runId);
    return ctx.memoryLevers;
  } catch (e) {
    // Never silence: a failed read is named on the worker, and at a worker's launch (`receipt`) it is also a receipt (ok 0,
    // with the code). That receipt is how the core knows this worker was launched without --notes and the contract (ADR 0047).
    if (receipt && w && !w.leversUnreadRecorded) {
      w.leversUnreadRecorded = true;
      await record(ctx, w, { kind: 'levers_unread', ok: false, code: codeOf(e), message: String((e && e.message) || e).slice(0, 300) });
    }
    if (w) noteError(w, 'memory.levers', e);
    return { ...DEFAULTS };
  }
}

// createParser's second argument. Sync: it reads what `levers` stored, so a launch before any levers read
// (the defaults) captures nothing.
const parserOpts = (ctx) => {
  const lv = ctx.memoryLevers || {};
  if (!lv.capture) return { capture: false };
  // ADR 0041 decision 2: captured heads, tails and commands are redacted before they leave the parser; with the
  // redact lever off they are kept as written, which the store records as redactions { disabled: 1 }.
  return lv.redact === false ? { capture: true, redact: (t) => ({ text: t, redactions: {} }) } : { capture: true, redact: require('../core/redact.cjs').redact };
};

async function record(ctx, w, fields) {
  try {
    await ctx.core.memory.recordEvent({ worker_id: w.id, task_id: w.taskId || undefined, ...fields });
    return true;
  } catch (e) {
    noteError(w, 'memory.recordEvent', e);
    return false;
  }
}

// The ids this worker was already shown: the union of its earlier `index_injected` events (ADR 0042 decision 3).
// Scoped to this run: a worker id is unique only within its run, so coder-1 of an earlier run is another worker.
async function shownBefore(ctx, w) {
  const got = await ctx.core.memory.events({ run_id: ctx.runId, worker_id: w.id, kinds: ['index_injected'] });
  const ids = new Set();
  for (const ev of (got && got.events) || []) {
    if (ev.ok === 0 || ev.ok === false || !Array.isArray(ev.row_ids)) continue;
    for (const id of ev.row_ids) ids.add(id);
  }
  return [...ids];
}

// The prompt as the index's relevance query: the core weighs at most 128 distinct terms and accepts 64 KB,
// so 16,384 characters (at most 64 KB in UTF-8) is all of any prompt that could matter.
const QUERY_CHARS = 16384;
const queryOf = (prompt) => (typeof prompt === 'string' && prompt.trim() ? prompt.slice(0, QUERY_CHARS) : undefined);

// The index text for this worker's launch, or '' (lever off, no rows, or a failed call). The event is the
// receipt either way once the lever is on. `prompt`, when the caller has it, ranks the rows by relevance to
// it; the core adds the task's spec on its own, so a relaunch without the prompt still ranks by the task.
async function indexBlock(w, ctx, prompt) {
  const lv = await levers(ctx, w);
  if (!lv.first_message_index) return '';
  let got;
  try {
    const exclude = await shownBefore(ctx, w);
    const query = queryOf(prompt);
    got = await ctx.core.memory.index({
      task_id: w.taskId || undefined, worker_id: w.id, max_bytes: lv.index_bytes, exclude_ids: exclude,
      ...(query ? { query } : {}),
    });
  } catch (e) {
    noteError(w, 'memory.index', e);
    await record(ctx, w, { kind: 'index_injected', ok: 0, code: codeOf(e), message: String((e && e.message) || e).slice(0, 300) });
    return '';
  }
  await record(ctx, w, {
    kind: 'index_injected', ok: 1, row_ids: got.row_ids, bytes: got.bytes, sha256: got.sha256,
    dropped: got.dropped > 0 ? 1 : 0, over_budget: got.over_budget ? 1 : 0,
  });
  return got.bytes > 0 ? got.text : '';
}

// ADR 0042 decision 2: after the resume line, before the prompt; the block and a blank line, or ''.
async function memoryPreface(w, ctx, prompt) {
  const text = await indexBlock(w, ctx, prompt);
  return text ? `${text}\n\n` : '';
}

// ADR 0047 decision 3: with the run's notes lever on, the end-of-task question and the note rules close the opening
// message (a worker reads what it must do last); '' with the lever off, so the message is the one it always was.
async function contractTail(ctx, w) {
  if (!w || !w.notesOn) return ''; // decided with the adapter's argv (manager writeFilesFor), never re-read here
  return `\n\n${require('./notes-contract.cjs').contract(ctx.memoryLevers)}`;
}

// A relaunch (replace or parked resume): the same index minus the rows already shown, after the relaunch's own text.
async function relaunch(w, ctx, firstText) {
  const text = await indexBlock(w, ctx);
  const out = !text ? firstText : firstText ? `${firstText}\n\n${text}` : text;
  const tail = await contractTail(ctx, w);
  return tail ? (out ? `${out}${tail}` : tail.trimStart()) : out;
}

// The opening message's preface, moved verbatim out of manager.cjs (the 500-line rule): assign the task,
// then the resume line (ADR 0007 decision 2), then the memory index. Assignment errors are the caller's.
// It runs against the `starting` row and cannot wait for ready: Claude Code emits no system/init until a
// message is on stdin (measured, tests/run/receipts/init-timing.json). `prompt` (optional) is the text the
// preface goes in front of; the index ranks rows by relevance to it.
async function preface(w, ctx, prompt) {
  let head = '';
  if (w.taskId) {
    await ctx.core.task.assign({ task_id: w.taskId, worker_id: w.id });
    try {
      const rl = await ctx.core.continuity.resumeLine({ task_id: w.taskId });
      head = rl && rl.text ? rl.text + '\n\n' : '';
    } catch (e) {
      w.lastError = { where: 'continuity.resumeLine', code: e && e.code, message: e && e.message };
    }
  }
  return head + await memoryPreface(w, ctx, prompt);
}

// ADR 0043 decision 1: the knowledge agent, only with its lever on. The module is built apart.
async function ask(manager, ctx, args) {
  const lv = await levers(ctx, null);
  if (!lv.knowledge_agent) fail('E_LEVER_OFF', 'knowledge_ask needs the memory.knowledge_agent lever, and this run has it off', { lever: 'knowledge_agent' });
  const mod = (ctx.modules && ctx.modules.knowledge) || require('./knowledge.cjs');
  return mod.ask(manager, ctx, args || {});
}

// The jobs that finish a run's memory work (summaries, project copies, the ledger, wrap-ups): only when a
// lever that feeds them is on. Called by shutdown once every worker's queue is drained.
const JOB_LEVERS = (lv) => lv.summaries !== 'off' || lv.project_writes || lv.cost_ledger || lv.wrapup;
async function runEnd(ctx) {
  const lv = await levers(ctx, null);
  if (!JOB_LEVERS(lv)) return;
  try {
    const mod = (ctx.modules && ctx.modules.jobs) || require('./memory-jobs.cjs');
    await mod.atRunEnd(ctx);
  } catch (e) {
    ctx.runEndError = { where: 'memory.atRunEnd', code: e && e.code, message: e && e.message }; // a failure here never blocks the shutdown
  }
}

module.exports = { memoryPreface, relaunch, preface, contractTail, parserOpts, levers, ask, runEnd };
