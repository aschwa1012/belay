'use strict';
// effort.test.cjs — build step S6b, ADR 0028 decisions 3 and 5: the requested effort is a column of the
// worker row and of the run row, null when not asked. Fix round 1: an attach states the value (null
// included), an absent key inherits only inside an unended epoch chain, and the core refuses a bad value.

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
  try { if (orch.isOwner()) await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

test('effort: the run row records orch_effort_requested, an absent key keeps it inside the unended chain, and an ended epoch never passes it on', async () => {
  const first = await orch.run.attach({ adapter_pid: process.pid, orch_effort_requested: 'high' });
  assert.strictEqual(first.run.orch_effort_requested, 'high');
  const second = await orch.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(second.run.orch_effort_requested, 'high', 'the orchestrator adapter names none and inherits');
  const ended = await orch.run.end({ exit_reason: 'test' });
  assert.strictEqual(ended.orch_effort_requested, 'high');
  // MF1: the next epoch of the same run id.
  const third = await orch.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(third.run.orch_effort_requested, null, 'an absent key over an ended epoch is null');
  const fourth = await orch.run.attach({ adapter_pid: process.pid, orch_effort_requested: 'max' });
  assert.strictEqual(fourth.run.orch_effort_requested, 'max');
  const fifth = await orch.run.attach({ adapter_pid: process.pid, orch_effort_requested: null });
  assert.strictEqual(fifth.run.orch_effort_requested, null, 'a present null is written as null even over an unended epoch');
  await orch.run.end({ exit_reason: 'test' });
});

test('effort: run.attach refuses a value that is neither null nor a level, E_ARGS, writing nothing', async () => {
  const before = (await orch.run.get()).epochs.length;
  for (const bad of ['ultra', '', 'HIGH', 3, { a: 1 }]) {
    await assert.rejects(() => orch.run.attach({ adapter_pid: process.pid, orch_effort_requested: bad }),
      (e) => e.code === 'E_ARGS' && /orch_effort_requested/.test(e.message), JSON.stringify(bad));
  }
  assert.strictEqual((await orch.run.get()).epochs.length, before, 'no run row was appended');
});

test('effort: the core level list equals the launch table list', () => {
  assert.deepStrictEqual(core('effort-levels.cjs').EFFORT_LEVELS, require('../../src/run/launch.cjs').EFFORT_LEVELS);
});

test('effort: the worker row carries effort_requested and inherits it across a restating write', async () => {
  await orch.run.attach({ adapter_pid: process.pid });
  const w = await orch.worker.write({ id: 'w-eff', substrate: 'claude-code', pid: process.pid, state: 'running', effort_requested: 'xhigh' });
  assert.strictEqual(w.effort_requested, 'xhigh');
  const idle = await orch.worker.write({ id: 'w-eff', state: 'idle' });
  assert.strictEqual(idle.effort_requested, 'xhigh');
  const none = await orch.worker.write({ id: 'w-none', substrate: 'claude-code', pid: process.pid, state: 'running' });
  assert.strictEqual(none.effort_requested, null);
});
