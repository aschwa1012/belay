'use strict';
// memory-jobs.test.cjs — ADR 0041 decisions 4 to 6 and ADR 0043 decision 2: the work after a turn and at a
// run's end. A spy core records every call; no process, store or model is involved.

const test = require('node:test');
const assert = require('node:assert');

const MJ = require('../../src/run/memory-jobs.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const lv = (over) => ({ ...DEFAULTS, ...over });
const failing = (code, message) => Object.assign(new Error(message || code), { code });

// A spy core. `rows` are the memory rows by id; `tasks` the task views; `workers` the worker rows. A hook in
// `fail` makes a method throw; a hook in `hang` never answers.
function spyCore({ tasks = {}, workers = [], observations = [], fail = {}, hang = {}, existingSummary = false } = {}) {
  const calls = [];
  const events = [];
  const rows = new Map();
  const usage = [];
  let n = 0;
  const rec = (method, args) => { calls.push({ method, args }); };
  const gate = async (method) => {
    if (hang[method]) await new Promise(() => {});
    const f = fail[method];
    const err = typeof f === 'function' ? f() : (f ? failing(f) : null);
    if (err) throw err;
  };
  const core = {
    calls, events, rows, usageRows: usage,
    run: { get: async () => { rec('run.get', {}); return { run: { memory_levers: null } }; } },
    task: {
      get: async (a) => { rec('task.get', a); await gate('task.get'); const t = tasks[a.task_id]; if (!t) throw failing('E_NOT_FOUND'); return t; },
      list: async (a) => { rec('task.list', a); await gate('task.list'); return { tasks: Object.values(tasks) }; },
    },
    worker: { list: async (a) => { rec('worker.list', a); await gate('worker.list'); return { workers }; } },
    memory: {
      store: async (a) => {
        rec('memory.store', a); await gate('memory.store');
        const id = 'm' + (++n);
        rows.set(id, { id, ...a });
        return { id, action: 'inserted', namespace: a.namespace || 'run/r1' };
      },
      get: async (a) => { rec('memory.get', a); await gate('memory.get'); const r = rows.get(a.id); if (!r) throw failing('E_NOT_FOUND'); return r; },
      list: async (a) => { rec('memory.list', a); await gate('memory.list'); return { rows: observations, total: observations.length }; },
      recordEvent: async (a) => {
        rec('memory.recordEvent', a); await gate('memory.recordEvent');
        if (a.kind === 'wrapup' && a.ok !== false && events.some((e) => e.kind === 'wrapup' && e.key === a.key && e.ok)) {
          throw failing('E_EXISTS', 'a wrapup event for this key already exists');
        }
        const e = { id: 'me' + (++n), ...a, ok: a.ok === false ? 0 : 1 };
        events.push(e);
        return e;
      },
      events: async (a) => {
        rec('memory.events', a); await gate('memory.events');
        let out = events;
        if (a.kinds) out = out.filter((e) => a.kinds.includes(e.kind));
        if (a.task_id) out = out.filter((e) => e.task_id === a.task_id);
        if (a.worker_id) out = out.filter((e) => e.worker_id === a.worker_id);
        if (existingSummary && a.kinds && a.kinds.includes('summary')) out = [...out, { kind: 'summary', ok: 1, newest_row_id: 'old-summary' }];
        return { events: out };
      },
    },
    usage: {
      record: async (a) => { rec('usage.record', a); await gate('usage.record'); usage.push(a); return { id: 'us' + usage.length, ...a }; },
      list: async (a) => {
        rec('usage.list', a); await gate('usage.list');
        const by = {};
        for (const u of usage) { const g = by[u.task_id] || (by[u.task_id] = { key: u.task_id, turns: 0, cost_usd: 0 }); g.turns += 1; g.cost_usd += u.cost_usd || 0; }
        const groups = Object.values(by);
        return { groups, totals: { turns: usage.length, cost_usd: groups.reduce((s, g) => s + g.cost_usd, 0) } };
      },
    },
  };
  return core;
}
const methodsOf = (core, m) => core.calls.filter((c) => c.method === m);

function worker(over = {}) {
  return { id: 'w1', taskId: 't1', substrate: 'claude-code', turns: 1, costUsd: 0.01, pid: 100, initModel: 'm-x', lastTurnUsage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 3 }, ...over };
}
const mkCtx = (core, levers, extra = {}) => ({ core, runId: 'r1', memoryLevers: levers, shutdownFlags: { closed: false }, ...extra });
const flush = async (w) => { await tick(); await w.memoryQueue; };
const releasedTask = (over = {}) => ({ id: 't1', spec: 'build the thing', state: 'released', handoff: { result: { summary: 'built it', verdict: 'holds' } }, ...over });
const OBS = [{ id: 'o1', body: { v: 1, turn: 1, files_read: ['a.cjs'], files_modified: ['b.cjs'], commands: [{ command: 'npm test', exit_code: 0 }], errors: 0 } }];

test('every lever off: a spy core sees zero calls, and no queue is made', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() } });
  const ctx = mkCtx(core, lv({}));
  const w = worker();
  MJ.afterTurn(w, ctx, { turnEvents: [], checkpointId: 'c1', observationId: 'o1' });
  await tick();
  await MJ.atRunEnd(ctx);
  assert.deepStrictEqual(core.calls, []);
  assert.strictEqual(w.memoryQueue, undefined);
  assert.strictEqual(w.memoryJobs, undefined);
});

test('levers not yet loaded: one run.get read, then nothing when they are all off', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() } });
  const ctx = { core, runId: 'r1', shutdownFlags: { closed: false } };
  const w = worker();
  MJ.afterTurn(w, ctx, {});
  await flush(w);
  assert.deepStrictEqual(core.calls.map((c) => c.method), ['run.get']);
});

test('usage: a delta across turns, a new row per turn, and a fresh delta for a new process', async () => {
  const core = spyCore();
  const ctx = mkCtx(core, lv({ cost_ledger: true }));
  const w = worker();
  const turn = async (over) => { Object.assign(w, over); MJ.afterTurn(w, ctx, {}); await flush(w); };
  await turn({ turns: 1, costUsd: 0.010 });
  await turn({ turns: 2, costUsd: 0.025 });
  await turn({ turns: 3, costUsd: 0.026 });
  await turn({ turns: 4, costUsd: 0.004, pid: 200 }); // a relaunched process: its counter restarts
  await turn({ turns: 5, costUsd: 0.010, pid: 200 });
  const rows = core.usageRows;
  assert.strictEqual(rows.length, 5);
  assert.deepStrictEqual(rows.map((r) => r.turn), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(rows.map((r) => Number(r.cost_usd.toFixed(4))), [0.01, 0.015, 0.001, 0.004, 0.006]);
  assert.deepStrictEqual(rows.map((r) => r.cost_basis), ['delta-of-cumulative', 'delta-of-cumulative', 'delta-of-cumulative', MJ.NEW_PROCESS, 'delta-of-cumulative']);
  assert.strictEqual(rows[0].worker_id, 'w1');
  assert.strictEqual(rows[0].task_id, 't1');
  assert.strictEqual(rows[0].model, 'm-x');
  assert.deepStrictEqual([rows[0].input_tokens, rows[0].output_tokens, rows[0].cache_read_tokens, rows[0].cache_creation_tokens], [5, 7, 11, 3]);
  // the same turn twice is one row
  MJ.afterTurn(w, ctx, {}); await flush(w);
  assert.strictEqual(core.usageRows.length, 5);
});

test('usage: a snapshot is taken when the turn ends, so a later turn_end does not change the row', async () => {
  const core = spyCore();
  const ctx = mkCtx(core, lv({ cost_ledger: true }));
  const w = worker({ turns: 1, costUsd: 0.5 });
  MJ.afterTurn(w, ctx, {});
  Object.assign(w, { turns: 2, costUsd: 9 }); // the next turn ends before the first job runs
  await flush(w);
  assert.strictEqual(core.usageRows[0].turn, 1);
  assert.strictEqual(core.usageRows[0].cost_usd, 0.5);
});

test('usage: Codex rows carry no dollars and the cached subset moves to cache_read; a first row seen late is a new process', async () => {
  const core = spyCore();
  const ctx = mkCtx(core, lv({ cost_ledger: true }));
  const cx = worker({ id: 'cx', substrate: 'codex', turns: 1, costUsd: 0, lastTurnUsage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9 } });
  MJ.afterTurn(cx, ctx, {}); await flush(cx);
  assert.strictEqual(core.usageRows[0].cost_usd, null);
  assert.strictEqual(core.usageRows[0].cost_basis, 'none');
  assert.deepStrictEqual([core.usageRows[0].input_tokens, core.usageRows[0].cache_read_tokens, core.usageRows[0].cache_creation_tokens], [60, 40, 0]);
  const late = worker({ id: 'late', turns: 4, costUsd: 0.2 });
  MJ.afterTurn(late, ctx, {}); await flush(late);
  assert.strictEqual(core.usageRows[1].cost_basis, MJ.NEW_PROCESS);
  assert.strictEqual(core.usageRows[1].cost_usd, 0.2);
});

test('usage: a failed row is an ok:0 event naming the code, and the next row carries the cost the failed one lost', async () => {
  let failNext = true;
  const core = spyCore({ fail: { 'usage.record': () => { if (failNext) { failNext = false; return failing('E_TIMEOUT', 'owner slow'); } return null; } } });
  const ctx = mkCtx(core, lv({ cost_ledger: true }));
  const w = worker({ turns: 1, costUsd: 0.01 });
  MJ.afterTurn(w, ctx, {}); await flush(w);
  assert.strictEqual(core.usageRows.length, 0);
  const ev = core.events.find((e) => e.kind === 'usage');
  assert.ok(ev && ev.ok === 0 && ev.code === 'E_TIMEOUT');
  Object.assign(w, { turns: 2, costUsd: 0.03 });
  MJ.afterTurn(w, ctx, {}); await flush(w);
  assert.strictEqual(core.usageRows.length, 1);
  assert.strictEqual(core.usageRows[0].cost_usd, 0.03);
});

test('summary: written once per (task, worker) under concurrent turns, labelled, never the worker\'s words', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() }, observations: OBS });
  const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical' }));
  const a = worker({ turns: 3 });
  const b = worker({ turns: 4 });
  MJ.afterTurn(a, ctx, {}); MJ.afterTurn(b, ctx, {}); // the same worker id, two near-simultaneous turn jobs
  a.memoryQueue = Promise.all([a.memoryQueue, b.memoryQueue]);
  await flush(a);
  const stores = methodsOf(core, 'memory.store').filter((c) => c.args.type === 'summary');
  assert.strictEqual(stores.length, 1);
  const s = stores[0].args;
  assert.strictEqual(s.source, 'summariser');
  assert.strictEqual(s.title, 'summary: task t1 (mechanical)');
  assert.strictEqual(s.embed, false);
  assert.strictEqual(s.task_id, 't1');
  assert.strictEqual(s.worker_id, 'w1', 'the summary names the worker it is about');
  assert.ok(s.text.startsWith(MJ.SUMMARY_LABEL));
  assert.match(s.text, /learned: worker-stated: built it/);
  assert.match(s.text, /modified b\.cjs/);
  assert.strictEqual(s.body.v, 1);
  assert.strictEqual(s.body.generator.kind, 'mechanical');
  const evs = core.events.filter((e) => e.kind === 'summary');
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].ok, 1);
  assert.deepStrictEqual(evs[0].row_ids, [evs[0].newest_row_id]);
  // a later turn and the run's end add none
  core.calls.length = 0;
  Object.assign(a, { turns: 5 });
  MJ.afterTurn(a, ctx, {}); await flush(a);
  assert.strictEqual(methodsOf(core, 'memory.store').length, 0);
});

test('summary: a task still running writes none; a prior ok event from an earlier manager stops a second', async () => {
  const running = spyCore({ tasks: { t1: releasedTask({ state: 'assigned' }) } });
  const ctx = mkCtx(running, lv({ capture: true, observations: true, summaries: 'mechanical' }));
  const w = worker();
  MJ.afterTurn(w, ctx, {}); await flush(w);
  assert.strictEqual(methodsOf(running, 'memory.store').length, 0);
  const prior = spyCore({ tasks: { t1: releasedTask() }, existingSummary: true });
  const ctx2 = mkCtx(prior, lv({ capture: true, observations: true, summaries: 'mechanical' }));
  const w2 = worker();
  MJ.afterTurn(w2, ctx2, {}); await flush(w2);
  assert.strictEqual(methodsOf(prior, 'memory.store').length, 0);
});

test('summary: a store failure is an ok:0 event, the turn trigger does not retry it, the run end does', async () => {
  let down = true;
  const core = spyCore({ tasks: { t1: releasedTask() }, observations: OBS, fail: { 'memory.store': () => (down ? failing('E_TIMEOUT', 'store down') : null) } });
  const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical' }));
  const w = worker();
  MJ.afterTurn(w, ctx, {}); await flush(w);
  const bad = core.events.filter((e) => e.kind === 'summary');
  assert.strictEqual(bad.length, 1);
  assert.strictEqual(bad[0].ok, 0);
  assert.strictEqual(bad[0].code, 'E_TIMEOUT');
  Object.assign(w, { turns: 2 });
  MJ.afterTurn(w, ctx, {}); await flush(w);
  assert.strictEqual(core.events.filter((e) => e.kind === 'summary').length, 1);
  down = false;
  core.worker.list = async () => ({ workers: [{ id: 'w1', task_id: 't1', state: 'stopped' }] });
  await MJ.atRunEnd(ctx);
  assert.strictEqual(core.events.filter((e) => e.kind === 'summary' && e.ok === 1).length, 1);
});

test('summary: an empty, refused or malformed result stores no row and records its class code', async () => {
  for (const [cls, code] of [['empty', 'E_SUMMARY_EMPTY'], ['refused', 'E_SUMMARY_REFUSED'], ['malformed', 'E_SUMMARY_MALFORMED'], ['over_budget', 'E_SUMMARY_OVER_BUDGET']]) {
    const core = spyCore({ tasks: { t1: releasedTask() } });
    const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical' }), { modules: { summarise: async () => ({ fields: {}, generator: { kind: 'x', version: 1 }, output_class: cls }) } });
    const w = worker();
    MJ.afterTurn(w, ctx, {}); await flush(w);
    assert.strictEqual(methodsOf(core, 'memory.store').length, 0, cls);
    const ev = core.events.find((e) => e.kind === 'summary');
    assert.ok(ev && ev.ok === 0 && ev.code === code, cls);
  }
});

test('project writes: an observation and a summary are copied with copy-of, each with a project_write event', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() }, observations: OBS });
  core.rows.set('obs9', { id: 'obs9', type: 'observation', title: 'turn 1: modified b.cjs', text: 'obs text', body: { v: 1 } });
  const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical', project: 'demo', project_writes: true }));
  const w = worker();
  MJ.afterTurn(w, ctx, { observationId: 'obs9' }); await flush(w);
  const copies = methodsOf(core, 'memory.store').filter((c) => c.args.namespace === 'project/demo');
  assert.strictEqual(copies.length, 2);
  assert.strictEqual(copies[0].args.provenance, 'copy-of:obs9');
  assert.strictEqual(copies[0].args.type, 'observation');
  assert.strictEqual(copies[0].args.embed, false);
  assert.strictEqual(copies[0].args.source, 'harness');
  assert.ok(copies.every((c) => c.args.worker_id === 'w1'), 'each copy names the worker it is about');
  assert.match(copies[1].args.provenance, /^copy-of:m\d+$/);
  assert.strictEqual(copies[1].args.type, 'summary');
  const writes = core.events.filter((e) => e.kind === 'project_write');
  assert.strictEqual(writes.length, 2);
  assert.ok(writes.every((e) => e.ok === 1 && e.row_ids.length === 1));
});

test('project writes: a row that is not an observation, and a failed copy, are ok:0 events', async () => {
  const core = spyCore({ fail: { 'memory.store': 'E_NAMESPACE_TOO_LARGE' } });
  core.rows.set('t9', { id: 't9', type: 'turn', text: 'x' });
  core.rows.set('o9', { id: 'o9', type: 'observation', title: 't', text: 'x', body: {} });
  const ctx = mkCtx(core, lv({ capture: true, observations: true, project: 'demo', project_writes: true }));
  const w = worker();
  MJ.afterTurn(w, ctx, { observationId: 't9' }); await flush(w);
  MJ.afterTurn(Object.assign(w, { turns: 2 }), ctx, { observationId: 'o9' }); await flush(w);
  const evs = core.events.filter((e) => e.kind === 'project_write');
  assert.deepStrictEqual(evs.map((e) => [e.ok, e.code]), [[0, 'E_ARGS'], [0, 'E_NAMESPACE_TOO_LARGE']]);
});

test('wrap-up: at most 600 bytes, keyed task:<id>, in the event message, once', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() }, observations: [{ id: 'o', body: { files_modified: Array.from({ length: 40 }, (_, i) => `src/some/long/path/number-${i}.cjs`) } }] });
  const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical', cost_ledger: true, wrapup: true }));
  const w = worker();
  MJ.afterTurn(w, ctx, {}); await flush(w);
  Object.assign(w, { turns: 2, costUsd: 0.02 });
  MJ.afterTurn(w, ctx, {}); await flush(w);
  const wraps = core.events.filter((e) => e.kind === 'wrapup');
  assert.strictEqual(wraps.length, 1);
  const wu = wraps[0];
  assert.strictEqual(wu.key, 'task:t1');
  assert.strictEqual(wu.task_id, 't1');
  assert.ok(Buffer.byteLength(wu.message) <= MJ.WRAPUP_MAX);
  assert.strictEqual(wu.bytes, Buffer.byteLength(wu.message));
  assert.match(wu.message, /^wrap-up task t1/);
  assert.match(wu.message, /state: released/);
  assert.match(wu.message, /summary: m\d+/);
  assert.match(wu.message, /cost: \$0\.0100 over 1 turn \(ledger\)/);
  assert.strictEqual(wu.row_ids.length, 1);
  assert.strictEqual(wu.sha256.length, 64);
});

test('wrap-up: with the summary lever off it still goes out, without a summary line; E_EXISTS is not an error', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() } });
  core.events.push({ kind: 'wrapup', key: 'task:t1', ok: 1 });
  const ctx = mkCtx(core, lv({ wrapup: true }));
  const w = worker();
  MJ.afterTurn(w, ctx, {}); await flush(w);
  assert.strictEqual(core.events.filter((e) => e.kind === 'wrapup').length, 1); // the store refused the second
  assert.strictEqual(core.events.filter((e) => e.ok === 0).length, 0);
  assert.strictEqual(w.lastError, undefined);
  const core2 = spyCore({ tasks: { t1: releasedTask() } });
  const w2 = worker();
  MJ.afterTurn(w2, mkCtx(core2, lv({ wrapup: true })), {}); await flush(w2);
  assert.ok(!/summary:/.test(core2.events[0].message));
});

test('wrap-up: a failed event write is an ok:0 wrapup event with its key', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() } });
  const orig = core.memory.recordEvent;
  let first = true;
  core.memory.recordEvent = async (a) => { if (a.kind === 'wrapup' && a.ok !== false && first) { first = false; throw failing('E_TIMEOUT', 'slow'); } return orig(a); };
  const w = worker();
  MJ.afterTurn(w, mkCtx(core, lv({ wrapup: true })), {}); await flush(w);
  const ev = core.events.find((e) => e.kind === 'wrapup');
  assert.ok(ev && ev.ok === 0 && ev.code === 'E_TIMEOUT' && ev.key === 'task:t1');
});

test('run end: a stopped worker holding a task gets its summary and wrap-up, then the run wrap-up once', async () => {
  const tasks = { t1: releasedTask({ state: 'assigned' }), t2: releasedTask({ id: 't2', state: 'done' }) };
  const core = spyCore({ tasks, observations: OBS, workers: [{ id: 'w1', task_id: 't1', state: 'dead' }, { id: 'w2', task_id: 't2', state: 'idle' }] });
  const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical', wrapup: true }));
  await MJ.atRunEnd(ctx);
  const sums = core.events.filter((e) => e.kind === 'summary');
  assert.deepStrictEqual(sums.map((e) => `${e.task_id}/${e.worker_id}`).sort(), ['t1/w1', 't2/w2']);
  assert.deepStrictEqual(core.events.filter((e) => e.kind === 'wrapup').map((e) => e.key).sort(), ['run', 'task:t1', 'task:t2']);
  const run = core.events.find((e) => e.key === 'run');
  assert.match(run.message, /tasks: 2 \(assigned 1, done 1\)/);
  assert.ok(Buffer.byteLength(run.message) <= MJ.WRAPUP_MAX);
  const before = core.events.length;
  await MJ.atRunEnd(ctx);
  assert.strictEqual(core.events.length, before);
});

test('run end: bounded; a hung core call is given up on, named, and nothing is thrown or written afterwards', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() }, observations: OBS, workers: [{ id: 'w1', task_id: 't1', state: 'dead' }, { id: 'w2', task_id: 't1', state: 'dead' }], hang: { 'memory.store': true } });
  const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical', wrapup: true }), { runEndBoundMs: 600 });
  const t0 = Date.now();
  await MJ.atRunEnd(ctx);
  const ms = Date.now() - t0;
  // The whole run-end budget is 600 ms here and the default is 5,000 ms (RUN_END_BOUND_MS): a bound that was ignored or a call
  // left unbounded takes 4,500 ms or more, or never returns. 3500 separates those from a slow runner (the call itself took 485 ms in CI).
  assert.ok(ms < 3500, `returned in ${ms} ms`);
  const gave = core.events.find((e) => e.key === 'run:gave-up');
  assert.ok(gave && gave.ok === 0 && gave.code === 'E_TIMEOUT');
  assert.match(gave.message, /summary:t1\/w1/);
  assert.match(gave.message, /wrapup:run/);
  assert.strictEqual(ctx.runEndError.code, 'E_TIMEOUT');
  const settled = core.calls.length;
  await tick();
  assert.strictEqual(core.calls.length, settled);
});

test('run end: the default bound is 5,000 ms', () => {
  assert.strictEqual(MJ.RUN_END_BOUND_MS, 5000);
});

test('run end: a core that throws everywhere never makes atRunEnd throw', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() }, fail: { 'task.list': 'E_OWNER_LOST', 'memory.recordEvent': 'E_OWNER_LOST' } });
  const ctx = mkCtx(core, lv({ summaries: 'mechanical', capture: true, observations: true, wrapup: true, cost_ledger: true }));
  await MJ.atRunEnd(ctx);
  const ctx2 = { core: { run: { get: async () => { throw failing('E_OWNER_LOST'); } } }, runId: 'r1' };
  await MJ.atRunEnd(ctx2);
});

test('after shutdown: afterTurn does nothing, even with every job lever on', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() } });
  const ctx = mkCtx(core, lv({ cost_ledger: true, wrapup: true }));
  ctx.shutdownFlags.closed = true;
  const w = worker();
  MJ.afterTurn(w, ctx, {});
  await tick();
  assert.deepStrictEqual(core.calls, []);
  // a job queued before the flag but starting after it drops itself and says so
  ctx.shutdownFlags.closed = false;
  MJ.afterTurn(w, ctx, {});
  ctx.shutdownFlags.closed = true;
  await flush(w);
  assert.deepStrictEqual(core.calls, []);
  assert.strictEqual(w.lastError.state, 'turn-memory-jobs');
});

test('a worker with no task still gets usage rows and no summary or wrap-up', async () => {
  const core = spyCore();
  const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical', cost_ledger: true, wrapup: true }));
  const w = worker({ taskId: null });
  MJ.afterTurn(w, ctx, {}); await flush(w);
  assert.strictEqual(core.usageRows.length, 1);
  assert.strictEqual(core.usageRows[0].task_id, undefined);
  assert.deepStrictEqual(core.calls.map((c) => c.method), ['usage.record']);
});

test('wrap-up: the rendered text carries no clock, so two Date.now values give identical bytes', async () => {
  const render = async (now) => {
    const real = Date.now;
    Date.now = () => now;
    try {
      const core = spyCore({ tasks: { t1: releasedTask() }, observations: [{ id: 'o', body: { files_modified: ['src/a.cjs'] } }] });
      const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical', cost_ledger: true, wrapup: true }));
      const w = worker();
      MJ.afterTurn(w, ctx, {}); await flush(w);
      Object.assign(w, { turns: 2, costUsd: 0.02 });
      MJ.afterTurn(w, ctx, {}); await flush(w);
      return core.events.filter((e) => e.kind === 'wrapup').map((e) => e.message);
    } finally { Date.now = real; }
  };
  const a = await render(1_700_000_000_000);
  const b = await render(1_900_000_000_000);
  assert.strictEqual(a.length, 1);
  assert.ok(Buffer.from(a[0]).equals(Buffer.from(b[0])), 'same input, same bytes');
  assert.doesNotMatch(a[0], /\d{4}-\d{2}-\d{2}T?\d{2}:\d{2}/, 'no ISO timestamp');
  assert.doesNotMatch(a[0], /\b1[5-9]\d{11}\b|\b1[5-9]\d{8}\b/, 'no epoch value');
  assert.doesNotMatch(a[0], /\b\d+\s*(ms|s|sec|seconds?|minutes?|min|hours?|h|days?)\s+ago\b|\bago\b|\bjust now\b/i, 'no relative time');
});
