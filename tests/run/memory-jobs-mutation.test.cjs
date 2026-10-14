'use strict';
// memory-jobs-mutation.test.cjs — claims of memory-jobs.cjs that a mutation run showed no other test pins down:
// the run-end bound split (total minus a quarter, capped at 500 ms) and what the give-up names, a wrap-up sent
// once, a wrap-up for a task with no handoff, the summary copy's body, the named row of a refused project
// copy, an uncoded failure becoming E_INTERNAL, and a levers read that fails being named on the worker.

const test = require('node:test');
const assert = require('node:assert');

const MJ = require('../../src/run/memory-jobs.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const lv = (over) => ({ ...DEFAULTS, ...over });
const failing = (code, message) => Object.assign(new Error(message || code), { code });

// A spy core, as tests/run/memory-jobs.test.cjs builds one: a method named in `fail` throws, one in `hang` never answers.
function spyCore({ tasks = {}, workers = [], observations = [], fail = {}, hang = {} } = {}) {
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
  return {
    calls, events, rows, usageRows: usage,
    run: { get: async () => { rec('run.get', {}); await gate('run.get'); return { run: { memory_levers: null } }; } },
    task: {
      get: async (a) => { rec('task.get', a); await gate('task.get'); const t = tasks[a.task_id]; if (!t) throw failing('E_NOT_FOUND'); return t; },
      list: async (a) => { rec('task.list', a); await gate('task.list'); return { tasks: Object.values(tasks) }; },
    },
    worker: { list: async (a) => { rec('worker.list', a); await gate('worker.list'); return { workers }; } },
    memory: {
      store: async (a) => { rec('memory.store', a); await gate('memory.store'); const id = `m${++n}`; rows.set(id, { id, ...a }); return { id, action: 'inserted' }; },
      get: async (a) => { rec('memory.get', a); await gate('memory.get'); const r = rows.get(a.id); if (!r) throw failing('E_NOT_FOUND'); return r; },
      list: async (a) => { rec('memory.list', a); await gate('memory.list'); const off = a.offset || 0; return { rows: observations.slice(off, off + (a.limit || 50)).map((o) => { const { body, ...rest } = o; return rest; }), total: observations.length }; },
      get_many: async (a) => { rec('memory.get_many', a); await gate('memory.get_many'); return { rows: a.ids.map((id) => observations.find((o) => o.id === id) || { id, found: false }) }; },
      recordEvent: async (a) => {
        rec('memory.recordEvent', a); await gate('memory.recordEvent');
        if (a.kind === 'wrapup' && a.ok !== false && events.some((e) => e.kind === 'wrapup' && e.key === a.key && e.ok)) throw failing('E_EXISTS', 'a wrapup event for this key already exists');
        const e = { id: `me${++n}`, ...a, ok: a.ok === false ? 0 : 1 };
        events.push(e);
        return e;
      },
      events: async (a) => {
        rec('memory.events', a); await gate('memory.events');
        let out = events;
        if (a.kinds) out = out.filter((e) => a.kinds.includes(e.kind));
        if (a.task_id) out = out.filter((e) => e.task_id === a.task_id);
        if (a.worker_id) out = out.filter((e) => e.worker_id === a.worker_id);
        return { events: out };
      },
    },
    usage: {
      record: async (a) => { rec('usage.record', a); await gate('usage.record'); usage.push(a); return { id: `us${usage.length}`, ...a }; },
      list: async (a) => { rec('usage.list', a); await gate('usage.list'); return { groups: [], totals: { turns: 0, cost_usd: null } }; },
    },
  };
}
const methodsOf = (core, m) => core.calls.filter((c) => c.method === m);
const worker = (over = {}) => ({ id: 'w1', taskId: 't1', substrate: 'claude-code', turns: 1, costUsd: 0.01, pid: 100, initModel: 'm-x', lastTurnUsage: { input_tokens: 5, output_tokens: 7 }, ...over });
const mkCtx = (core, levers, extra = {}) => ({ core, runId: 'r1', memoryLevers: levers, shutdownFlags: { closed: false }, ...extra });
const flush = async (w) => { await tick(); await w.memoryQueue; };
const releasedTask = (over = {}) => ({ id: 't1', spec: 'build the thing', state: 'released', handoff: { result: { summary: 'built it', verdict: 'holds' } }, ...over });
const OBS = [{ id: 'o1', body: { v: 1, turn: 1, files_read: ['a.cjs'], files_modified: ['b.cjs'], commands: [{ command: 'npm test', exit_code: 0 }], errors: 0 } }];
const RUN_END = lv({ capture: true, observations: true, summaries: 'mechanical', wrapup: true });
const settle = async (n = 5) => { for (let i = 0; i < n; i += 1) await tick(); };

async function hungRunEnd(t, boundMs) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const core = spyCore({ tasks: { t1: releasedTask() }, workers: [{ id: 'w1', task_id: 't1', state: 'dead' }], hang: { 'memory.events': true } });
  const ctx = mkCtx(core, RUN_END, { runEndBoundMs: boundMs });
  let done = false;
  const p = MJ.atRunEnd(ctx).then((r) => { done = true; return r; });
  await settle();
  return { core, ctx, p, isDone: () => done };
}

test('run end: the work is bounded at the total minus 500 ms, the give-up record gets the 500 ms, and the give-up names what did not run', async (t) => {
  const h = await hungRunEnd(t, 6000);
  t.mock.timers.tick(5499);
  await settle();
  assert.strictEqual(h.isDone(), false, 'still working 1 ms before the bound');
  t.mock.timers.tick(1);
  const out = await h.p;
  assert.strictEqual(out.outcome, 'timeout');
  assert.deepStrictEqual(out.unfinished, ['summary:t1/w1', 'wrapup:task:t1', 'wrapup:run']);
  const gave = h.core.events.find((e) => e.key === 'run:gave-up');
  assert.strictEqual(gave.message, 'run-end memory jobs stopped after 5500 ms; not done: summary:t1/w1, wrapup:task:t1, wrapup:run');
  assert.deepStrictEqual(h.ctx.runEndError, { where: 'memory-jobs.atRunEnd', code: 'E_TIMEOUT', message: 'gave up', unfinished: ['summary:t1/w1', 'wrapup:task:t1', 'wrapup:run'] });
});

test('run end: a small total gives the give-up record a quarter of it', async (t) => {
  const h = await hungRunEnd(t, 1000);
  t.mock.timers.tick(749);
  await settle();
  assert.strictEqual(h.isDone(), false);
  t.mock.timers.tick(1);
  await h.p;
  assert.match(h.core.events.find((e) => e.key === 'run:gave-up').message, /stopped after 750 ms/);
});

test('run end: a read that fails names the stage, the plain message and E_INTERNAL for an uncoded error', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() }, fail: { 'task.list': () => new Error('store gone') } });
  const ctx = mkCtx(core, RUN_END);
  const out = await MJ.atRunEnd(ctx);
  assert.deepStrictEqual(out, { outcome: 'error', unfinished: ['plan'] });
  assert.deepStrictEqual(ctx.runEndError, { where: 'memory-jobs.atRunEnd', code: 'E_INTERNAL', message: 'failed at plan: store gone', unfinished: ['plan'] });
  const gave = core.events.find((e) => e.key === 'run:gave-up');
  assert.strictEqual(gave.code, 'E_INTERNAL');
  assert.strictEqual(gave.message, 'run-end memory jobs failed at plan: store gone; not done: plan');
  const viaJobs = await MJ.runEndJobs({ core: spyCore({ fail: { 'task.list': 'E_OWNER_LOST' } }), runId: 'r1', levers: RUN_END });
  assert.strictEqual(viaJobs.outcome, 'error');
  assert.strictEqual(viaJobs.error.message, 'failed at plan: E_OWNER_LOST');
  const ranOff = await MJ.runEndJobs({ core: spyCore(), runId: 'r1', levers: lv({}) });
  assert.deepStrictEqual(ranOff, { outcome: 'off' });
});

test('wrap-up: a second turn after the first wrap-up sends nothing, and a failed one is not sent again by a turn', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() }, observations: OBS });
  const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical', wrapup: true }));
  const w = worker();
  MJ.afterTurn(w, ctx, {}); await flush(w);
  Object.assign(w, { turns: 2 });
  MJ.afterTurn(w, ctx, {}); await flush(w);
  MJ.afterTurn(w, ctx, {}); await flush(w);
  assert.strictEqual(methodsOf(core, 'memory.recordEvent').filter((c) => c.args.kind === 'wrapup').length, 1, 'one wrap-up was sent, not one per turn');

  let down = true;
  const bad = spyCore({ tasks: { t1: releasedTask() }, observations: OBS, fail: { 'memory.recordEvent': () => (down ? failing('E_TIMEOUT', 'ledger down') : null) } });
  const ctx2 = mkCtx(bad, lv({ capture: true, observations: true, wrapup: true }));
  const w2 = worker();
  MJ.afterTurn(w2, ctx2, {}); await flush(w2);
  down = false;
  const sent = methodsOf(bad, 'memory.recordEvent').filter((c) => c.args.kind === 'wrapup').length;
  Object.assign(w2, { turns: 2 });
  MJ.afterTurn(w2, ctx2, {}); await flush(w2);
  assert.strictEqual(methodsOf(bad, 'memory.recordEvent').filter((c) => c.args.kind === 'wrapup').length, sent, 'a turn never retries a failed wrap-up');
});

test('wrap-up: a task with no handoff, or a verdict that is not text, still gets its wrap-up without a verdict line', async () => {
  for (const handoff of [undefined, null, { result: { summary: 'x' } }, { result: { verdict: 7 } }]) {
    const core = spyCore({ tasks: { t1: releasedTask({ handoff }) }, observations: OBS });
    const ctx = mkCtx(core, lv({ capture: true, observations: true, wrapup: true }));
    const w = worker();
    MJ.afterTurn(w, ctx, {}); await flush(w);
    const wrap = core.events.filter((e) => e.kind === 'wrapup');
    assert.strictEqual(wrap.length, 1, JSON.stringify(handoff));
    assert.strictEqual(wrap[0].ok, 1, JSON.stringify(handoff));
    assert.ok(!/verdict/.test(wrap[0].message), wrap[0].message);
    assert.match(wrap[0].message, /state: released/);
  }
  const core = spyCore({ tasks: { t1: releasedTask() }, observations: OBS });
  const w = worker();
  MJ.afterTurn(w, mkCtx(core, lv({ capture: true, observations: true, wrapup: true })), {}); await flush(w);
  assert.match(core.events.find((e) => e.kind === 'wrapup').message, /worker-stated verdict: holds/);
});

test('project copy of a summary carries the summary\'s own body, version 1 included, and the copy of a non-observation names the row', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() }, observations: OBS });
  core.rows.set('t9', { id: 't9', type: 'turn', text: 'x' });
  const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical', project: 'demo', project_writes: true }));
  const w = worker();
  MJ.afterTurn(w, ctx, { observationId: 't9' }); await flush(w);
  const stores = methodsOf(core, 'memory.store').map((c) => c.args);
  const summary = stores.find((a) => a.type === 'summary' && !a.namespace);
  const copy = stores.find((a) => a.namespace === 'project/demo');
  assert.strictEqual(summary.body.v, 1);
  assert.deepStrictEqual(copy.body, summary.body);
  assert.strictEqual(copy.title, summary.title);
  assert.strictEqual(copy.text, summary.text);
  const refused = core.events.find((e) => e.kind === 'project_write' && e.ok === 0);
  assert.deepStrictEqual(refused.row_ids, ['t9']);
  assert.strictEqual(refused.code, 'E_ARGS');
  assert.match(refused.message, /row t9 is not an observation/);
});

test('a failing usage write is an ok 0 usage event with E_INTERNAL for an uncoded error and the turn in its message', async () => {
  const core = spyCore({ fail: { 'usage.record': () => new Error('disk full') } });
  const ctx = mkCtx(core, lv({ cost_ledger: true }));
  const w = worker({ taskId: null });
  MJ.afterTurn(w, ctx, {}); await flush(w);
  const ev = core.events.find((e) => e.kind === 'usage');
  assert.strictEqual(ev.ok, 0);
  assert.strictEqual(ev.code, 'E_INTERNAL');
  assert.strictEqual(ev.message, 'usage row for turn 1 not written: disk full');
  assert.strictEqual(ev.worker_id, 'w1');
});

test('a levers read that fails is named on the worker and the turn does nothing', async () => {
  const core = spyCore({ fail: { 'run.get': () => failing('E_OWNER_LOST', 'no owner') } });
  const ctx = { core, runId: 'r1', shutdownFlags: { closed: false } };
  const w = worker();
  MJ.afterTurn(w, ctx, {}); await flush(w);
  assert.deepStrictEqual(w.lastError, { where: 'memory.levers', code: 'E_OWNER_LOST', message: 'no owner' });
  assert.deepStrictEqual(core.events, []);
  assert.strictEqual(methodsOf(core, 'usage.record').length, 0);
  // and with no worker (the run's end) the same failure is not an error of its own
  const out = await MJ.atRunEnd({ core, runId: 'r1' });
  assert.deepStrictEqual(out, { outcome: 'off' });
});

test('a receipt that cannot be written is named on the worker with the plain message', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() }, observations: OBS, fail: { 'memory.recordEvent': () => failing('E_TIMEOUT', 'ledger down') } });
  const ctx = mkCtx(core, lv({ capture: true, observations: true, summaries: 'mechanical' }));
  const w = worker();
  MJ.afterTurn(w, ctx, {}); await flush(w);
  assert.deepStrictEqual(w.lastError, { where: 'memory.recordEvent', code: 'E_TIMEOUT', message: 'ledger down' });
});

test('a task read that fails on the turn path is named on the worker as memory-jobs.afterTurn', async () => {
  const core = spyCore({ tasks: { t1: releasedTask() }, fail: { 'task.get': () => failing('E_OWNER_LOST', 'no owner') } });
  const w = worker();
  MJ.afterTurn(w, mkCtx(core, lv({ wrapup: true })), {}); await flush(w);
  assert.deepStrictEqual(w.lastError, { where: 'memory-jobs.afterTurn', code: 'E_OWNER_LOST', message: 'no owner' });
});
