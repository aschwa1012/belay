'use strict';
// ensure-hold-live-run.test.cjs — task.ensureHold never moves a task, or its lease, out of another LIVE run. A run whose
// adapter has ended is still adopted (ADR 0046 decision 1); a live run's task is that run's.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { openCore } = core('index.cjs');

let dir;
const cores = [];
const open = async (runId) => { const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: runId }), embed: false }); cores.push(c); return c; };
const live = async (runId) => { const c = await open(runId); await c.run.attach({ adapter_pid: process.pid }); return c; };
const taskFor = async (c, id, workerId) => {
  await c.task.create({ id, spec: 's', files_owned: [`${id}.txt`], acceptance: { files_within_owned: true } });
  await c.worker.write({ id: workerId, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  await c.task.assign({ task_id: id, worker_id: workerId });
};

before(() => { dir = sandbox(); });
after(async () => {
  for (const c of cores.slice(1)) await c.close();
  await cores[0].shutdownOwner();
  await cores[0].close();
  cleanup(dir);
});

test('ensureHold from another live run is refused and writes nothing', async () => {
  const a = await live('eh-a');
  const b = await live('eh-b');
  await taskFor(a, 'T-eh1', 'w-eh1');
  const leaseOf = async (id) => ((await a.task.list({})).tasks.find((t) => t.id === id) || {}).lease;
  const t0 = await a.task.get({ task_id: 'T-eh1' }); const l0 = await leaseOf('T-eh1');
  await assert.rejects(b.task.ensureHold({ task_id: 'T-eh1', worker_id: 'w-eh1' }), (e) => { assert.strictEqual(e.code, 'E_ROLE', e.message); assert.strictEqual(e.detail.task_run_id, 'eh-a'); return true; });
  const t1 = await a.task.get({ task_id: 'T-eh1' });
  assert.strictEqual(t1.run_id, 'eh-a');
  assert.strictEqual(t1.seq, t0.seq, 'the task row was not written');
  const l1 = await leaseOf('T-eh1');
  assert.ok(l0 && l0.holder === 'w-eh1', 'the lease is held by the worker');
  assert.deepStrictEqual(l1, l0, 'the lease row was not written');
});

test('ensureHold still rehomes a task of a run that has ended', async () => {
  const old = await live('eh-old');
  await taskFor(old, 'T-eh2', 'w-eh2');
  await old.run.end({ exit_reason: 'test' });
  const now = await live('eh-now');
  const r = await now.task.ensureHold({ task_id: 'T-eh2', worker_id: 'w-eh2' });
  assert.strictEqual(r.reason, 'rehomed');
  assert.strictEqual(r.run_id, 'eh-now');
});
