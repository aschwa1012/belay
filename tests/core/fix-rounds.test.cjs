'use strict';
// fix-rounds.test.cjs — ADR 0031 decision 6 (build 12 wave 2): `task.create { repairs }` names the work a
// fix task repairs, and core refuses a fix task past the run's `max_fix_rounds`, writing nothing.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch;
before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
});
after(async () => {
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

const count = async () => (await orch.task.list({})).tasks.length;

test('max_fix_rounds 2: two fix tasks per repaired task, the third is refused and nothing is written', async () => {
  await orch.run.attach({ adapter_pid: process.pid, max_fix_rounds: 2 });
  const work = await orch.task.create({ spec: 'work' });
  const other = await orch.task.create({ spec: 'other work' });
  const f1 = await orch.task.create({ spec: 'fix 1', repairs: work.id, depends_on: [work.id] });
  assert.strictEqual(f1.repairs, work.id);
  await orch.task.create({ spec: 'fix 2', repairs: work.id });
  const before = await count();
  assert.ok(before >= 4, `the count is a real number of rows, got ${before}`);
  await assert.rejects(orch.task.create({ spec: 'fix 3', repairs: work.id, id: 'fix-3' }), (e) => {
    assert.strictEqual(e.code, 'E_FIX_ROUNDS');
    assert.match(e.message, /max_fix_rounds is 2/);
    assert.strictEqual(e.detail.fix_rounds_used, 2);
    return true;
  });
  assert.strictEqual(await count(), before, 'a refused fix task wrote no row');
  // counted per repaired task: another work task still has its own rounds
  await orch.task.create({ spec: 'fix of other', repairs: other.id });
});

test('max_fix_rounds 0 refuses the first fix task', async () => {
  const d2 = sandbox();
  const c = await openCore({ dataDir: d2, caller: callerFor('orchestrator', { run_id: 'zero' }), embed: false });
  try {
    await c.run.attach({ adapter_pid: process.pid, max_fix_rounds: 0 });
    const w = await c.task.create({ spec: 'w' });
    await assert.rejects(c.task.create({ spec: 'f', repairs: w.id }), (e) => e.code === 'E_FIX_ROUNDS');
  } finally { try { await c.shutdownOwner(); } finally { await c.close(); cleanup(d2); } }
});

test('a reattach without the lever keeps the cap; null lifts it', async () => {
  await orch.run.attach({ adapter_pid: process.pid });
  const w = await orch.task.create({ spec: 'w3' });
  await orch.task.create({ spec: 'a', repairs: w.id });
  await orch.task.create({ spec: 'b', repairs: w.id });
  await assert.rejects(orch.task.create({ spec: 'c', repairs: w.id }), (e) => e.code === 'E_FIX_ROUNDS');
  await orch.run.attach({ adapter_pid: process.pid, max_fix_rounds: null });
  await orch.task.create({ spec: 'c', repairs: w.id });
});

test('repairs is optional and validated', async () => {
  const plain = await orch.task.create({ spec: 'no field' });
  assert.strictEqual(plain.repairs, null);
  await assert.rejects(orch.task.create({ spec: 'x', repairs: 'nope' }), (e) => e.code === 'E_NOT_FOUND');
  await assert.rejects(orch.task.create({ spec: 'x', repairs: 7 }), (e) => e.code === 'E_ARGS');
  await assert.rejects(orch.run.attach({ adapter_pid: process.pid, max_fix_rounds: -1 }), (e) => e.code === 'E_ARGS');
});
