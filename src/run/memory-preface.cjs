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

// The spawn's own bound for embedding the index queries (a slow embedder must not hold a spawn): past it the index is
// built from keywords alone and the receipt names the failure. The core enforces it (memory.embedQuery timeout_ms).
const { SPAWN_EMBED_MS } = require('../core/spawn-bounds.cjs');
const NO_EMBED = Object.freeze({ attempted: false, embeddings: [], queries: [], failure: null, stop: false, off: false, ms: 0 });

// The query vectors of this worker's index, made by the store owner's embedder (memory.embedQuery: the path memory.search
// uses; this process never loads the model). The queries are the task's own text, which the core reads from the task row
// (so a relaunch embeds the same text a spawn did), plus the worker's `indexQueries` (the orchestrator's memory_queries from worker_spawn, kept on the worker row; each is sent as
// "Task: <line>", the shape the task query has). Only for a run with a project, and only when there is a task or an extra query. Resolves
// { attempted, embeddings: [{ vector, model, label }], queries: [{ label, ms, ok, code?, message?, embedder?, timed_out? }],
// failure: the first failed query's { code, message } or null, stop: whether a failure of the model itself must stop this
// launch (the run's mode is `required`), off: whether the run's memory is off (mode `off` after a failure), ms }. A core without memory.embedQuery is a test double and gets none. Never throws.
async function embedForIndex(ctx, w, lv) {
  const extra = (Array.isArray(w.indexQueries) ? w.indexQueries : []).map((q) => (typeof q === 'string' ? `Task: ${q}` : { ...q, text: `Task: ${q.text}` }));
  if (!lv.project || !ctx.core.memory || typeof ctx.core.memory.embedQuery !== 'function' || (!w.taskId && !extra.length)) return NO_EMBED;
  const t0 = Date.now();
  let r;
  try {
    r = await ctx.core.memory.embedQuery({ ...(w.taskId ? { task_id: w.taskId } : {}), ...(extra.length ? { extra_texts: extra } : {}), worker_id: w.id, timeout_ms: SPAWN_EMBED_MS });
  } catch (e) {
    // E_ROLE here is the run manager holding no harness view: a wiring fault, named as one and never taken for an embedder failure.
    const wiring = e && e.code === 'E_ROLE';
    const message = wiring ? `the run manager's core has no harness view, so memory.embedQuery was refused (a wiring fault, not an embedder failure): ${(e && e.message) || e}` : String((e && e.message) || e);
    return { attempted: true, embeddings: [], queries: [], failure: { code: codeOf(e), message: message.slice(0, 200) }, stop: false, ms: Date.now() - t0 };
  }
  const queries = ((r && r.queries) || []).map((q) => ({ label: q.label, ms: q.ms, ok: !!q.ok, ...(q.ok ? {} : { code: q.code, message: q.message, cause: q.cause || null, embedder: !!q.embedder, timed_out: !!q.timed_out }) }));
  const embeddings = ((r && r.queries) || []).filter((q) => q.ok).map((q) => ({ vector: q.query_embedding, model: q.embedding_model, label: q.label }));
  const bad = queries.find((q) => !q.ok);
  const failedModel = queries.some((q) => !q.ok && q.embedder);
  return {
    attempted: true, embeddings, queries, ms: Number.isInteger(r && r.embed_ms) ? r.embed_ms : Date.now() - t0,
    failure: bad ? { code: bad.code || 'E_INTERNAL', message: String(bad.message || '').slice(0, 200), cause: bad.cause || null } : null,
    stop: !!(r && r.on_embedder_failure === 'required' && failedModel),
    run_ending: r && typeof r.run_ending === 'boolean' ? r.run_ending : null, // null: the core did not say
    off: !!(r && (r.memory_off || (r.on_embedder_failure === 'off' && failedModel))),
  };
}

// The receipt's detail, one JSON text in the event's `message` (the store has no scalar columns for it):
// { hybrid, queries: [{ label, ms, ok }], failure?: { code, message } }. `hybrid` is true only when a semantic ranking
// contributed to the index's order; `failure` is why a query or the semantic signal did not.
function receiptDetail(emb, hybrid, failure) {
  const f = failure || emb.failure;
  return JSON.stringify({ hybrid, queries: emb.queries.map(({ label, ms, ok }) => ({ label, ms, ok })), ...(f ? { failure: { code: f.code, message: String(f.message || '').slice(0, 160) } } : {}) });
}

// ADR 0034 decision 2 under `required`: the owner's hook has paused the run, so this launch injects no index. The receipt is
// ok 0 with the failure's code (a resume relaunches the worker, and its index is built again, since an ok 0 receipt shows no rows).
async function stopReceipt(ctx, w, emb) {
  w.lastError = { where: 'memory.embedQuery', code: emb.failure.code, message: emb.failure.message };
  await record(ctx, w, { kind: 'index_injected', ok: 0, code: emb.failure.code, message: receiptDetail(emb, false) });
}

// on_embedder_failure `off`: the run's memory is off, so this launch gets no index. Recorded, never silent.
async function offReceipt(ctx, w, emb) {
  await record(ctx, w, { kind: 'index_injected', ok: 1, row_ids: [], bytes: 0, dropped: 0, over_budget: 0, message: JSON.stringify({ hybrid: false, memory: 'off', queries: emb.queries.map(({ label, ms, ok }) => ({ label, ms, ok })), ...(emb.failure ? { failure: { code: emb.failure.code, message: String(emb.failure.message || '').slice(0, 160) } } : {}) }) });
}

// What a worker is told when its first-message index was refused (E_INDEX_BOUND, E_SEMANTIC_REQUIRED): belay's own words, no note text.
function noIndexNotice(e) {
  return `NO MEMORY INDEX WAS INJECTED into this message: the index was refused (${codeOf(e)}: ${String((e && e.message) || e).slice(0, 240)}). This is not a pause and your task is unchanged. Use the memory_search tool to look for what the task may touch before you start, and do not assume that the project has no memory on it.`;
}

// The index text for this worker's launch, or '' (lever off, no rows, or a failed call). The event is the
// receipt either way once the lever is on. `prompt`, when the caller has it, is the keyword query (the core adds the task's
// spec on its own); the vectors come from the task's text (embedForIndex), the same at a spawn and at a relaunch.
//
// A failure to embed is never silent. Under `stop` the launch injects nothing (stopReceipt; a spawn is refused before it gets
// here, see `preface`). Under `continue`, after the spawn's own bound, or when the call itself failed and the run's mode is not
// known, the index is built from keywords alone and the receipt (ok 1, hybrid false) names the failure.
async function indexBlock(w, ctx, prompt, given, { excludeShown = true } = {}) {
  const lv = await levers(ctx, w);
  if (!lv.first_message_index) return '';
  const emb = given || await embedForIndex(ctx, w, lv);
  if (emb.stop) { await stopReceipt(ctx, w, emb); return ''; }
  if (emb.off) { await offReceipt(ctx, w, emb); return ''; }
  let got;
  try {
    const exclude = excludeShown ? await shownBefore(ctx, w) : [];
    const query = queryOf(prompt);
    got = await ctx.core.memory.index({
      task_id: w.taskId || undefined, worker_id: w.id, max_bytes: lv.index_bytes, exclude_ids: exclude,
      ...(query ? { query } : {}),
      ...(emb.embeddings.length ? { query_embeddings: emb.embeddings } : {}),
    });
  } catch (e) {
    noteError(w, 'memory.index', e);
    const refusal = codeOf(e) === 'E_INDEX_BOUND' || codeOf(e) === 'E_SEMANTIC_REQUIRED';
    if (refusal) await record(ctx, w, { kind: 'index_bound', ok: 0, code: codeOf(e), message: JSON.stringify({ refused: true, message: String((e && e.message) || e).slice(0, 300) }) });
    await record(ctx, w, { kind: 'index_injected', ok: 0, code: codeOf(e), message: JSON.stringify({ hybrid: false, queries: emb.queries.map(({ label, ms, ok }) => ({ label, ms, ok })), failure: { code: codeOf(e), message: String((e && e.message) || e).slice(0, 160) } }) });
    // A refusal under `required` is not fixed by a pause, so the worker still starts. It is told plainly that it has no index and why.
    return refusal ? noIndexNotice(e) : '';
  }
  if (got.candidates && got.candidates.degraded) await record(ctx, w, { kind: 'index_bound', ok: 0, code: 'E_INDEX_BOUND', message: JSON.stringify({ refused: false, ...got.candidates.degraded }) });
  const rel = got.relevance || {};
  const hybrid = rel.semantic_contributed === true;
  const semFailure = emb.embeddings.length && !hybrid && rel.semantic && typeof rel.semantic === 'object' ? rel.semantic : null;
  await record(ctx, w, {
    kind: 'index_injected', ok: 1, row_ids: got.row_ids, bytes: got.bytes, sha256: got.sha256,
    dropped: got.dropped > 0 ? 1 : 0, over_budget: got.over_budget ? 1 : 0, message: receiptDetail(emb, hybrid, semFailure),
  });
  return got.bytes > 0 ? got.text : '';
}

// ADR 0042 decision 2: after the resume line, before the prompt; the block and a blank line, or ''.
async function memoryPreface(w, ctx, prompt, emb) {
  const text = await indexBlock(w, ctx, prompt, emb);
  return text ? `${text}\n\n` : '';
}

// ADR 0047 decision 3: with the run's notes lever on, the end-of-task question and the note rules close the opening
// message (a worker reads what it must do last); '' with the lever off, so the message is the one it always was.
async function contractTail(ctx, w) {
  if (!w || !w.notesOn) return ''; // decided with the adapter's argv (manager writeFilesFor), never re-read here
  return `\n\n${require('./notes-contract.cjs').contract(ctx.memoryLevers, await projectSubjects(ctx, w))}`;
}

// The project's most used note subjects, for the hand-back question to offer (memory.noteSubjects: at most about 20, inside a
// byte cap, chosen by the core). Best effort: a core without the call, or one that fails, offers none and the worker states its own.
async function projectSubjects(ctx, w) {
  const project = ctx.memoryLevers && ctx.memoryLevers.project;
  const memory = ctx.core && ctx.core.memory;
  if (!project || !memory || typeof memory.noteSubjects !== 'function') return [];
  try {
    const r = await memory.noteSubjects({ project });
    return Array.isArray(r && r.subjects) ? r.subjects.map((s) => s.subject) : [];
  } catch (e) {
    // Named on the worker, as the other best-effort calls are: the worker then states its own subjects, and the receipt says why.
    if (w) w.lastError = { where: 'memory.noteSubjects', code: e && e.code, message: String((e && e.message) || e).slice(0, 200) };
    return [];
  }
}

// A relaunch: the same index, after the relaunch's own text. `excludeShown` (default true) leaves out the rows the worker was already
// shown, which is right only when the conversation still holds them: a resumed session, or a replacement whose bottle carries the
// first message. A fresh session that carries nothing of the old one (bottle off or failed, a Codex worker) gets the whole index.
async function relaunch(w, ctx, firstText, { excludeShown = true } = {}) {
  const text = await indexBlock(w, ctx, undefined, undefined, { excludeShown });
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
  // The index's vectors are made first, before the task is assigned: under `required` a failure of the model refuses this spawn
  // with nothing assigned and nothing sent (the caller writes the `starting` row dead), so the orchestrator spawns again after
  // the resume and the worker is never launched into a paused run without its index. The time spent is `w.indexEmbedMs`, which
  // the manager keeps out of the worker's readiness clock.
  const lv = await levers(ctx, w);
  const emb = lv.first_message_index ? await embedForIndex(ctx, w, lv) : NO_EMBED;
  w.indexEmbedMs = emb.ms;
  if (emb.off) await offReceipt(ctx, w, emb);
  if (emb.stop) {
    await stopReceipt(ctx, w, emb);
    // The guard ENDS the run, instead of pausing it, for a failure no resume can fix (embedder-guard.cjs isFatal: the store's model is not
    // the one in use). The message says which, so the orchestrator does not wait for a resume that will not come.
    const fatal = emb.run_ending !== null ? emb.run_ending : (emb.failure.code === 'E_MODEL_CHANGED' || emb.failure.cause === 'canary'); // the run's guard said it is ENDING this run (never an interactive run: that pauses)
    const what = `${emb.failure.code}: ${emb.failure.message}`;
    fail('E_PAUSED', fatal
      ? `worker ${w.id} was not launched: the embedder failed while embedding its index query (${what}), which no resume can fix, so on_embedder_failure required is ENDING the run, not pausing it. Do not spawn again; end your work and report it.`
      : `worker ${w.id} was not launched: the embedder failed while embedding its index query (${what}), and on_embedder_failure is required, so the run is pausing. ${require('../core/embedder-mode.cjs').pauseAdvice(ctx.runId)} After the resume, spawn the task again with a NEW worker id (${w.id} is now a dead row).`,
    { cause: 'embedder_failure', code: emb.failure.code, worker_id: w.id, run_ending: fatal });
  }
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
  return head + (emb.off ? '' : await memoryPreface(w, ctx, prompt, emb));
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

module.exports = { SPAWN_EMBED_MS, memoryPreface, relaunch, preface, contractTail, parserOpts, levers, ask, runEnd };
