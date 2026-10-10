'use strict';
// run-end-jobs.test.cjs — ADR 0043 decision 2: the run-end memory jobs as `belay run` runs them, after the
// orchestrator's adapter has closed, against the store `belay run` owns (memory-jobs.cjs runEndJobs, called from
// src/cli/run-memory-end.cjs). On a real store: the jobs need nothing but the store's rows; they are idempotent
// with a partial run the adapter got through before Claude Code ended it; a failure leaves a `run:gave-up` event
// on the ledger; and with every job lever off nothing is loaded or called.

const test = require('node:test');
const assert = require('node:assert');

const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { openCore } = core('index.cjs');
const MJ = require('../../src/run/memory-jobs.cjs');
const { memoryRunEnd } = require('../../src/cli/run-memory-end.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');

const RUN = 'run-end-1';
const LEVERS = { ...DEFAULTS, capture: true, observations: true, summaries: 'mechanical', wrapup: true };

// A store with one released task held by a worker that is now dead: the run's end has a summary and two wrap-ups to write.
async function setup() {
  const dir = sandbox();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, memory_levers: JSON.stringify(LEVERS) });
  const t = await orch.task.create({ spec: 'build the parser' });
  await orch.worker.write({ id: 'coder-1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's1', last_event_at: Date.now(), task_id: t.id });
  const a = await orch.task.assign({ task_id: t.id, worker_id: 'coder-1' });
  const w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'coder-1', run_id: RUN }), embed: false });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { summary: 'parser built', verdict: 'holds' } });
  await w.close();
  await orch.worker.write({ id: 'coder-1', substrate: 'claude-code', pid: process.pid, state: 'dead', session_id: 's1', task_id: t.id });
  // `belay run`'s own core: the operator, bound to the run.
  const op = await openCore({ dataDir: dir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
  return { dir, orch, op, taskId: t.id };
}
async function teardown(s) {
  await s.op.close();
  await s.orch.shutdownOwner();
  await s.orch.close();
  cleanup(s.dir);
}
const ledger = async (c, kinds) => (await c.memory.events({ run_id: RUN, kinds })).events;

test('belay run\'s run-end, store only: the summary and both wrap-ups land, from the rows alone', async () => {
  const s = await setup();
  try {
    const out = await MJ.runEndJobs({ core: s.op, runId: RUN, levers: LEVERS });
    assert.deepStrictEqual(out, { outcome: 'done' });
    const summaries = await ledger(s.op, ['summary']);
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0].ok, 1);
    assert.strictEqual(summaries[0].task_id, s.taskId);
    const wraps = await ledger(s.op, ['wrapup']);
    assert.deepStrictEqual(wraps.map((e) => e.key).sort(), ['run', `task:${s.taskId}`]);
    assert.ok(wraps.every((e) => e.ok === 1));
  } finally { await teardown(s); }
});

test('after a partial adapter-side run (summary written, wrap-ups cut off), belay run finishes it with no duplicate', async () => {
  const s = await setup();
  try {
    // The adapter's own run-end, cut short after the summaries: emulated by the same jobs with the wrap-up lever off.
    const adapter = await MJ.runEndJobs({ core: s.orch, runId: RUN, levers: { ...LEVERS, wrapup: false } });
    assert.strictEqual(adapter.outcome, 'done');
    const first = await MJ.runEndJobs({ core: s.op, runId: RUN, levers: LEVERS });
    const again = await MJ.runEndJobs({ core: s.op, runId: RUN, levers: LEVERS });
    assert.strictEqual(first.outcome, 'done');
    assert.strictEqual(again.outcome, 'done', 'a second run-end is a no-op, not a failure');
    assert.strictEqual((await ledger(s.op, ['summary'])).length, 1, 'the summary is not written twice');
    const rows = (await s.op.memory.list({ filter: { types: ['summary'] }, view: 'index' })).rows;
    assert.strictEqual(rows.length, 1, 'one summary row');
    const wraps = await ledger(s.op, ['wrapup']);
    assert.deepStrictEqual(wraps.map((e) => e.key).sort(), ['run', `task:${s.taskId}`], 'each wrap-up once');
    const taskWrap = wraps.find((e) => e.key === `task:${s.taskId}`);
    assert.deepStrictEqual(taskWrap.row_ids, [rows[0].id], 'the wrap-up names the summary the adapter wrote');
  } finally { await teardown(s); }
});

test('a run-end that cannot read the run\'s rows leaves run:gave-up on the ledger, naming the code and what did not run', async () => {
  const s = await setup();
  try {
    const broken = { ...s.op, task: { ...s.op.task, list: async () => { throw Object.assign(new Error('store gone'), { code: 'E_OWNER_LOST' }); } } };
    const out = await MJ.runEndJobs({ core: broken, runId: RUN, levers: LEVERS });
    assert.strictEqual(out.outcome, 'error');
    assert.strictEqual(out.error.code, 'E_OWNER_LOST');
    const gave = (await ledger(s.op, ['wrapup'])).filter((e) => e.key === 'run:gave-up');
    assert.strictEqual(gave.length, 1);
    assert.strictEqual(gave[0].ok, 0);
    assert.strictEqual(gave[0].code, 'E_OWNER_LOST');
    assert.match(gave[0].message, /store gone; not done: plan/);
  } finally { await teardown(s); }
});

test('memoryRunEnd with every job lever off loads nothing and calls nothing', async () => {
  const jobs = { runEndJobs: () => { throw new Error('must not be called'); } };
  const spy = new Proxy({}, { get: () => { throw new Error('the core must not be touched'); } });
  assert.strictEqual(await memoryRunEnd({ core: spy, runId: RUN, levers: { max_fix_rounds: 2 }, jobs }), null, 'no memory block at all');
  assert.strictEqual(await memoryRunEnd({ core: spy, runId: RUN, levers: { memory_levers: { ...DEFAULTS, capture: true, first_message_index: true } }, jobs }), null, 'levers on that feed no run-end job');
  let got = null;
  const r = await memoryRunEnd({ core: spy, runId: RUN, levers: { memory_levers: { ...DEFAULTS, wrapup: true } }, jobs: { runEndJobs: async (a) => { got = a; return { outcome: 'done' }; } } });
  assert.deepStrictEqual(r, { outcome: 'done' });
  assert.strictEqual(got.runId, RUN);
  assert.strictEqual(got.levers.wrapup, true);
});
