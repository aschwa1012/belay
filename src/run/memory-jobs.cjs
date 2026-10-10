'use strict';
// memory-jobs.cjs — the memory work that follows a turn and the work that closes a run (ADR 0041 decisions
// 4 to 6, ADR 0043 decision 2): a mechanical summary once per (task, worker), project copies, usage rows from
// the turn's own numbers, and a bounded wrap-up per task and per run.
//
// Every entry point reads the lever first and returns before it touches the core when the lever is off, so a
// run with the levers at their defaults makes no call here. Whatever runs is queued on the worker's existing
// `memoryQueue` and never awaited on the turn path. A failed write is a `memory_event` with ok 0 and the
// code, never silence and never a silent retry. Summaries are stored as generated, labelled as such, and
// never as the worker's own words; the wrap-up text goes in `memory_event.message` (`belay notices` shows it).

const crypto = require('node:crypto');
const { fit } = require('../core/fit-budget.cjs');
const { summarise, POLICY } = require('./summarise.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');

const RUN_END_BOUND_MS = 5000; // atRunEnd's whole budget, the give-up record included
const GIVE_UP_MS = 500;
const WRAPUP_MAX = 600;
const LIST_LIMIT = 200;
const SUMMARY_LABEL = "[generated summary (mechanical), not the worker's words]";
const ENDED_TASK = new Set(['released', 'done']);
const ENDED_WORKER = new Set(['stopped', 'dead']);
const NEW_PROCESS = 'delta-of-cumulative (new process)';

const codeOf = (e) => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const note = (w, where, e) => { if (w) w.lastError = { where, code: e && e.code, message: e && e.message }; };
const closed = (ctx) => !!(ctx.shutdownFlags && ctx.shutdownFlags.closed);
const anyJob = (lv) => lv.summaries !== 'off' || lv.project_writes || lv.cost_ledger || lv.wrapup;

// Per-manager bookkeeping: what this manager has already done, so a second trigger does no second write.
const STATE = new WeakMap();
function stateOf(ctx) {
  let s = STATE.get(ctx);
  if (!s) {
    s = { summaryDone: new Set(), summaryFailed: new Set(), wrapDone: new Set(), wrapFailed: new Set(), inflight: new Map(), summaryIds: new Map() };
    STATE.set(ctx, s);
  }
  return s;
}
// One in-flight promise per key: a second caller shares the first's outcome instead of racing it.
function once(s, key, fn) {
  if (s.inflight.has(key)) return s.inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => s.inflight.delete(key));
  s.inflight.set(key, p);
  return p;
}

// ctx.memoryLevers is set by memory-preface's `levers`; a caller that reaches here first asks it to read.
async function leversOf(ctx, w) {
  if (ctx.memoryLevers) return ctx.memoryLevers;
  try { return await require('./memory-preface.cjs').levers(ctx, w); } catch (e) { note(w, 'memory.levers', e); return { ...DEFAULTS }; }
}

// J: the job context. `gate.aborted` is set when atRunEnd gives up, so a step that has not started never does.
function jobCtx(ctx, lv, w, gate) { return { ctx, core: ctx.core, lv, w, gate: gate || { aborted: false }, s: stateOf(ctx) }; }
async function call(J, fn) {
  if (J.gate.aborted) throw Object.assign(new Error('the run-end memory jobs gave up'), { code: 'E_TIMEOUT' });
  return fn();
}
// A receipt. Returns the event row or null; a failure to write the receipt is named on the worker.
async function event(J, fields) {
  try { return await call(J, () => J.core.memory.recordEvent({ ...fields })); } catch (e) {
    if (J.w) note(J.w, 'memory.recordEvent', e);
    return null;
  }
}
const failure = (J, kind, fields, e) => event(J, { kind, ok: false, code: codeOf(e), message: String((e && e.message) || e).slice(0, 300), ...fields });

// ---- usage (ADR 0041 decision 6) -------------------------------------------------------------------------
// The turn's numbers are snapshotted when afterTurn is called: the queued job may run after a later turn_end
// has moved the worker's counters. Claude Code's cost is cumulative per process, so the row carries the delta
// from the previous row of the same process; a new process (or a counter that went down) restarts from zero.
function snapshotOf(w) {
  const u = w.lastTurnUsage || null;
  return { turn: w.turns, usage: u, cost: w.costUsd, pid: w.pid, substrate: w.substrate, model: w.initModel || w.model || null, taskId: w.taskId || null, workerId: w.id };
}
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
function tokensOf(snap) {
  const u = snap.usage;
  if (!u) return {};
  if (snap.substrate === 'codex') {
    return { input_tokens: Math.max(0, num(u.input_tokens) - num(u.cached_input_tokens)), output_tokens: num(u.output_tokens), cache_read_tokens: num(u.cached_input_tokens), cache_creation_tokens: 0 };
  }
  return { input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cache_read_tokens: num(u.cache_read_input_tokens), cache_creation_tokens: num(u.cache_creation_input_tokens) };
}
function costOf(w, snap) {
  if (snap.substrate !== 'claude-code' || typeof snap.cost !== 'number' || !Number.isFinite(snap.cost)) return { cost_usd: null, cost_basis: 'none' };
  const t = w.memoryJobs || (w.memoryJobs = { pid: null, lastCost: 0, seen: false, lastTurn: 0 });
  const fresh = !t.seen ? snap.turn > 1 : t.pid !== snap.pid; // a first row seen late means the counter was not watched from zero
  const reset = fresh || snap.cost < t.lastCost;
  const base = reset ? 0 : t.lastCost;
  const cost_basis = reset && (t.seen || snap.turn > 1) ? NEW_PROCESS : 'delta-of-cumulative';
  return { cost_usd: Math.max(0, snap.cost - base), cost_basis, advance: () => { t.pid = snap.pid; t.lastCost = snap.cost; t.seen = true; } };
}
async function usageJob(J, snap) {
  const w = J.w;
  const t = w.memoryJobs || (w.memoryJobs = { pid: null, lastCost: 0, seen: false, lastTurn: 0 });
  if (snap.turn <= t.lastTurn) return; // one row per turn
  const c = costOf(w, snap);
  try {
    await call(J, () => J.core.usage.record({
      worker_id: snap.workerId, task_id: snap.taskId || undefined, turn: snap.turn, substrate: snap.substrate,
      model: snap.model || undefined, ...tokensOf(snap), cost_usd: c.cost_usd, cost_basis: c.cost_basis,
    }));
    t.lastTurn = snap.turn;
    if (c.advance) c.advance();
  } catch (e) {
    await failure(J, 'usage', { worker_id: snap.workerId, task_id: snap.taskId || undefined, message: `usage row for turn ${snap.turn} not written: ${(e && e.message) || e}`.slice(0, 300) }, e);
  }
}

// ---- project copies (ADR 0041 decision 5) ---------------------------------------------------------------
async function copyToProject(J, row, workerId, taskId) {
  const ns = `project/${J.lv.project}`;
  try {
    const out = await call(J, () => J.core.memory.store({
      namespace: ns, type: row.type, title: row.title, text: row.text, body: row.body, embed: false, source: 'harness',
      task_id: taskId || undefined, provenance: `copy-of:${row.id}`,
    }));
    await event(J, { kind: 'project_write', ok: true, worker_id: workerId, task_id: taskId || undefined, row_ids: [out.id], newest_row_id: out.id, key: `copy-of:${row.id}`, message: `copied ${row.id} to ${ns}` });
  } catch (e) {
    await failure(J, 'project_write', { worker_id: workerId, task_id: taskId || undefined, key: `copy-of:${row.id}`, row_ids: [row.id] }, e);
  }
}
async function projectCopyOfTurn(J, snap, turnRowId) {
  if (!turnRowId) return; // no observation row for this turn (the observation lever is off, or its store failed and was recorded)
  try {
    const row = await call(J, () => J.core.memory.get({ id: turnRowId, view: 'full' }));
    if (!row || row.type !== 'observation') {
      await event(J, { kind: 'project_write', ok: false, code: 'E_ARGS', worker_id: snap.workerId, task_id: snap.taskId || undefined, row_ids: [turnRowId], message: `row ${turnRowId} is not an observation, so it was not copied` });
      return;
    }
    await copyToProject(J, row, snap.workerId, snap.taskId);
  } catch (e) {
    await failure(J, 'project_write', { worker_id: snap.workerId, task_id: snap.taskId || undefined, row_ids: [turnRowId] }, e);
  }
}

// ---- summaries (ADR 0041 decision 4) --------------------------------------------------------------------
async function gather(J, taskId, taskRow) {
  const task = taskRow || await call(J, () => J.core.task.get({ task_id: taskId }));
  let observations = [];
  try {
    const got = await call(J, () => J.core.memory.list({ filter: { types: ['observation'], task_id: taskId }, view: 'full', order: 'oldest', limit: LIST_LIMIT }));
    observations = (got && got.rows) || [];
  } catch (_) { observations = []; } // a summary without observations says so; the failed read is not the summary's failure
  return { task, observations };
}
const verdictOf = (task) => (task && task.state === 'done' ? 'accepted (task.evaluate)' : undefined);
function render(fields, generator) {
  const files = fields.done.files_modified;
  const cmds = fields.done.commands;
  const failed = cmds.filter((c) => c.exit_code !== null && c.exit_code !== 0).length;
  return [
    SUMMARY_LABEL,
    `asked: ${fields.asked || '(not stated)'}`,
    `looked at: ${fields.looked_at.length ? fields.looked_at.join(', ') : '(none captured)'}`,
    `learned: ${fields.learned}`,
    `done: ${files.length ? 'modified ' + files.join(', ') : 'no files modified'}; ran ${cmds.length} command${cmds.length === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}; task ${fields.done.task_state || 'state unknown'}`,
    `next: ${fields.next || '(not stated)'}`,
    `notes: ${fields.notes.errors} error${fields.notes.errors === 1 ? '' : 's'}${fields.notes.verdict ? '; verdict ' + fields.notes.verdict : ''}`,
    `generator: ${generator.kind} v${generator.version}`,
  ].join('\n');
}
async function alreadySummarised(J, taskId, workerId) {
  const got = await call(J, () => J.core.memory.events({ task_id: taskId, worker_id: workerId, kinds: ['summary'] }));
  const hit = ((got && got.events) || []).find((ev) => ev.ok === 1 || ev.ok === true);
  return hit ? hit : null;
}
// Once per (task, worker): the store's `summary` event with ok 1 is the record of it. `retry` lets the run's
// end try again a summary that failed earlier in this run; a per-turn trigger never does.
function ensureSummary(J, taskId, workerId, { taskRow, retry } = {}) {
  const { s } = J;
  const key = `${taskId}|${workerId}`;
  if (s.summaryDone.has(key) || (s.summaryFailed.has(key) && !retry)) return Promise.resolve(s.summaryIds.get(key) || null);
  return once(s, 'summary:' + key, async () => {
    if (s.summaryDone.has(key)) return s.summaryIds.get(key) || null;
    try {
      const prior = await alreadySummarised(J, taskId, workerId);
      if (prior) { s.summaryDone.add(key); if (prior.newest_row_id) s.summaryIds.set(key, prior.newest_row_id); return prior.newest_row_id || null; }
      const { task, observations } = await gather(J, taskId, taskRow);
      const handoff = task && task.handoff && task.handoff.result;
      const input = { task: { spec: task && task.spec, state: task && task.state, verdict: verdictOf(task) }, observations, checkpoints: [], handoff: handoff || {} };
      const summariser = (J.ctx.modules && J.ctx.modules.summarise) || summarise;
      const result = await summariser(input, { kind: 'mechanical' });
      const cls = result.output_class;
      const policy = POLICY[cls] || POLICY.malformed;
      if (!policy.store) {
        s.summaryFailed.add(key);
        await event(J, { kind: 'summary', ok: false, code: policy.code, worker_id: workerId, task_id: taskId, message: `no summary row: the summariser's output was ${cls}` });
        return null;
      }
      const text = render(result.fields, result.generator);
      const stored = await call(J, () => J.core.memory.store({
        type: 'summary', title: `summary: task ${taskId} (mechanical)`, text, body: { v: 1, ...result.fields, generator: result.generator },
        embed: false, source: 'summariser', task_id: taskId, tags: [taskId, workerId],
      }));
      s.summaryDone.add(key); s.summaryFailed.delete(key); s.summaryIds.set(key, stored.id);
      await event(J, { kind: 'summary', ok: true, worker_id: workerId, task_id: taskId, row_ids: [stored.id], newest_row_id: stored.id, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha(text) });
      if (J.lv.project_writes && J.lv.project) {
        await copyToProject(J, { id: stored.id, type: 'summary', title: `summary: task ${taskId} (mechanical)`, text, body: { v: 1, ...result.fields, generator: result.generator } }, workerId, taskId);
      }
      return stored.id;
    } catch (e) {
      s.summaryFailed.add(key);
      await failure(J, 'summary', { worker_id: workerId, task_id: taskId }, e);
      return null;
    }
  });
}

// ---- wrap-ups (ADR 0043 decision 2) ---------------------------------------------------------------------
const money = (n) => (typeof n === 'number' ? '$' + n.toFixed(4) : 'n/a');
async function taskCost(J, taskId) {
  if (!J.lv.cost_ledger) return null;
  try {
    const got = await call(J, () => J.core.usage.list({ group_by: 'task' }));
    const g = ((got && got.groups) || []).find((x) => x.key === taskId);
    return g ? { turns: g.turns, cost_usd: g.cost_usd } : null;
  } catch (_) { return null; }
}
async function recordWrapup(J, key, taskId, built, rowIds) {
  const { s } = J;
  const fields = { kind: 'wrapup', key, task_id: taskId || undefined, message: built.text, bytes: built.bytes, sha256: sha(built.text), dropped: built.dropped > 0, over_budget: built.over_budget, row_ids: rowIds };
  try {
    await call(J, () => J.core.memory.recordEvent({ ok: true, ...fields }));
    s.wrapDone.add(key);
  } catch (e) {
    if (e && e.code === 'E_EXISTS') { s.wrapDone.add(key); return; } // the store already holds this key's wrap-up: nothing is sent twice
    s.wrapFailed.add(key);
    await failure(J, 'wrapup', { key, task_id: taskId || undefined, message: String((e && e.message) || e).slice(0, 300) }, e);
  }
}
function ensureWrapup(J, taskId, { taskRow, retry } = {}) {
  const { s } = J;
  const key = `task:${taskId}`;
  if (s.wrapDone.has(key) || (s.wrapFailed.has(key) && !retry)) return Promise.resolve();
  return once(s, 'wrapup:' + key, async () => {
    if (s.wrapDone.has(key)) return;
    try {
      const { task, observations } = await gather(J, taskId, taskRow);
      const files = [...new Set(observations.flatMap((o) => { const b = typeof o.body === 'string' ? safeParse(o.body) : o.body; return (b && Array.isArray(b.files_modified)) ? b.files_modified : []; }))];
      const cost = await taskCost(J, taskId);
      const summaryId = [...s.summaryIds.entries()].find(([k]) => k.startsWith(taskId + '|'));
      const handoff = task && task.handoff && task.handoff.result;
      const items = [
        { id: 'state', text: `state: ${task.state}`, priority: 9 },
        summaryId ? { id: 'summary', text: `summary: ${summaryId[1]}`, priority: 8 } : null,
        handoff && typeof handoff.verdict === 'string' ? { id: 'verdict', text: `worker-stated verdict: ${handoff.verdict}`, priority: 7 } : null,
        files.length ? { id: 'files', text: `files modified (${files.length}): ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}`, priority: 5 } : null,
        cost ? { id: 'cost', text: `cost: ${money(cost.cost_usd)} over ${cost.turns} turn${cost.turns === 1 ? '' : 's'} (ledger)`, priority: 3 } : null,
      ].filter(Boolean);
      const built = fit(items, { max_bytes: WRAPUP_MAX, header: `wrap-up task ${taskId}`, drop_order: 'priority-then-oldest' });
      await recordWrapup(J, key, taskId, built, summaryId ? [summaryId[1]] : []);
    } catch (e) {
      s.wrapFailed.add(key);
      await failure(J, 'wrapup', { key, task_id: taskId }, e);
    }
  });
}
function safeParse(t) { try { return JSON.parse(t); } catch (_) { return null; } }

async function runWrapup(J, tasks) {
  const { s } = J;
  if (s.wrapDone.has('run')) return;
  try {
    const by = {};
    for (const t of tasks) by[t.state] = (by[t.state] || 0) + 1;
    let totals = null;
    if (J.lv.cost_ledger) { try { totals = (await call(J, () => J.core.usage.list({}))).totals; } catch (_) { totals = null; } }
    const states = Object.keys(by).sort().map((k) => `${k} ${by[k]}`).join(', ');
    const items = [
      { id: 'tasks', text: `tasks: ${tasks.length}${states ? ` (${states})` : ''}`, priority: 9 },
      totals ? { id: 'cost', text: `cost: ${money(totals.cost_usd)} over ${totals.turns} turn${totals.turns === 1 ? '' : 's'} (ledger)`, priority: 5 } : null,
    ].filter(Boolean);
    const built = fit(items, { max_bytes: WRAPUP_MAX, header: 'wrap-up run', drop_order: 'priority-then-oldest' });
    await recordWrapup(J, 'run', null, built, []);
  } catch (e) {
    s.wrapFailed.add('run');
    await failure(J, 'wrapup', { key: 'run' }, e);
  }
}

// ---- entry points ---------------------------------------------------------------------------------------
// Queues this turn's jobs on the worker's memory queue and returns at once. `turnRowId` is the observation
// row the capture step stored for this turn (null when there is none).
function afterTurn(w, ctx, { turnEvents, checkpointId, turnRowId } = {}) {
  void turnEvents; void checkpointId; // the observation already carries what the events held
  if (closed(ctx)) return;
  if (ctx.memoryLevers && !anyJob(ctx.memoryLevers)) return;
  const snap = snapshotOf(w);
  w.memoryQueue = (w.memoryQueue || Promise.resolve()).then(async () => {
    if (closed(ctx)) { w.lastError = { where: 'after-shutdown', state: 'turn-memory-jobs' }; return; }
    try {
      const lv = await leversOf(ctx, w);
      if (!anyJob(lv)) return;
      const J = jobCtx(ctx, lv, w);
      if (lv.cost_ledger) await usageJob(J, snap);
      if (lv.project_writes && lv.project) await projectCopyOfTurn(J, snap, turnRowId);
      const wantSummary = lv.summaries !== 'off';
      if (!snap.taskId || !(wantSummary || lv.wrapup)) return;
      const s = J.s;
      const sKey = `${snap.taskId}|${snap.workerId}`;
      const needSummary = wantSummary && !s.summaryDone.has(sKey) && !s.summaryFailed.has(sKey);
      const needWrap = lv.wrapup && !s.wrapDone.has(`task:${snap.taskId}`) && !s.wrapFailed.has(`task:${snap.taskId}`);
      if (!needSummary && !needWrap) return;
      const task = await call(J, () => J.core.task.get({ task_id: snap.taskId }));
      if (!task || !ENDED_TASK.has(task.state)) return;
      if (wantSummary) await ensureSummary(J, snap.taskId, snap.workerId, { taskRow: task });
      if (lv.wrapup) await ensureWrapup(J, snap.taskId, { taskRow: task });
    } catch (e) {
      note(w, 'memory-jobs.afterTurn', e);
    }
  });
}

// The run's end: the triggers a turn cannot see (a worker stopped or dead holding a task), then the run's
// wrap-up. Awaited by shutdown before the owner stops, so it bounds itself and never throws.
async function runEndWork(J, progress) {
  const { lv, core } = J;
  progress.stage = 'plan';
  const tasks = ((await call(J, () => core.task.list({}))) || {}).tasks || [];
  const workers = ((await call(J, () => core.worker.list({}))) || {}).workers || [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const endedTasks = new Set(tasks.filter((t) => ENDED_TASK.has(t.state)).map((t) => t.id));
  const pairs = [];
  for (const wk of workers) {
    const t = wk.task_id && byId.get(wk.task_id);
    if (!t) continue;
    if (ENDED_TASK.has(t.state) || ENDED_WORKER.has(wk.state)) { pairs.push([t, wk]); endedTasks.add(t.id); }
  }
  progress.planned = [];
  if (lv.summaries !== 'off') for (const [t, wk] of pairs) progress.planned.push(`summary:${t.id}/${wk.id}`);
  if (lv.wrapup) { for (const id of endedTasks) progress.planned.push(`wrapup:task:${id}`); progress.planned.push('wrapup:run'); }
  progress.done = new Set();
  if (lv.summaries !== 'off') {
    for (const [t, wk] of pairs) {
      progress.stage = `summary:${t.id}/${wk.id}`;
      await ensureSummary(J, t.id, wk.id, { taskRow: t, retry: true });
      progress.done.add(progress.stage);
    }
  }
  if (lv.wrapup) {
    for (const id of endedTasks) {
      progress.stage = `wrapup:task:${id}`;
      await ensureWrapup(J, id, { taskRow: byId.get(id), retry: true });
      progress.done.add(progress.stage);
    }
    progress.stage = 'wrapup:run';
    await runWrapup(J, tasks);
    progress.done.add('wrapup:run');
  }
}

function afterBound(ms, fn) {
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res('timeout'), ms); });
  return Promise.race([fn().then(() => 'done', () => 'error'), timeout]).finally(() => clearTimeout(timer));
}

async function atRunEnd(ctx) {
  try {
    const lv = await leversOf(ctx, null);
    if (!anyJob(lv)) return;
    const total = Number.isInteger(ctx.runEndBoundMs) && ctx.runEndBoundMs > 0 ? ctx.runEndBoundMs : RUN_END_BOUND_MS; // the override is for tests
    const giveUpMs = Math.min(GIVE_UP_MS, Math.floor(total / 4));
    const gate = { aborted: false };
    const J = jobCtx(ctx, lv, null, gate);
    const progress = { stage: 'start', planned: null, done: new Set() };
    const outcome = await afterBound(total - giveUpMs, () => runEndWork(J, progress));
    if (outcome === 'error') { const e = new Error('a run-end memory job failed'); ctx.runEndError = { where: 'memory-jobs.atRunEnd', code: 'E_INTERNAL', message: e.message }; }
    if (outcome !== 'timeout') return;
    gate.aborted = true; // no step that has not started will start
    const left = progress.planned ? progress.planned.filter((x) => !progress.done.has(x)) : ['plan'];
    const record = jobCtx(ctx, lv, null, { aborted: false });
    await afterBound(giveUpMs, () => event(record, { kind: 'wrapup', key: 'run:gave-up', ok: false, code: 'E_TIMEOUT', message: `run-end memory jobs stopped after ${total - giveUpMs} ms; not done: ${(left.length ? left : [progress.stage]).join(', ')}`.slice(0, 600) }));
    ctx.runEndError = { where: 'memory-jobs.atRunEnd', code: 'E_TIMEOUT', message: 'gave up', unfinished: left };
  } catch (e) {
    ctx.runEndError = { where: 'memory-jobs.atRunEnd', code: codeOf(e), message: e && e.message };
  }
}

module.exports = { afterTurn, atRunEnd, RUN_END_BOUND_MS, WRAPUP_MAX, SUMMARY_LABEL, NEW_PROCESS };
