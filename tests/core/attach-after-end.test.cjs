'use strict';
// attach-after-end.test.cjs — ADR 0029 amendment 4 (proposed): an ended run stays ended. The orchestrator adapter's first
// core call is its attach, and it can land after the run closed; it is refused and writes nothing. The run process
// (role operator) is the one that opens a new epoch over an ended run, as a re-run does.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, operator;

before(async () => {
  dir = sandbox();
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
});

after(async () => {
  try { await orch.close(); if (operator.isOwner()) await operator.shutdownOwner(); } finally { await operator.close(); cleanup(dir); }
});

test('run.attach: an orchestrator attach over an ended run is refused with E_ARGS and writes no row; an operator attach opens the next epoch', async () => {
  await operator.run.attach({ adapter_pid: process.pid });
  assert.strictEqual((await orch.run.attach({ adapter_pid: process.pid })).epoch, 2, 'an attach over a run still open is a reattach');
  const ended = await operator.run.end({ exit_reason: 'test' });
  assert.notStrictEqual(ended.ended_at, null);
  const before = (await operator.run.get()).epochs.length;

  await assert.rejects(() => orch.run.attach({ adapter_pid: process.pid }), (e) => e.code === 'E_ARGS' && /already ended/.test(e.message) && e.detail && e.detail.ended_at === ended.ended_at);

  const now = await operator.run.get();
  assert.strictEqual(now.epochs.length, before, 'no row was appended');
  assert.notStrictEqual(now.run.ended_at, null, 'the run is still ended');

  const next = await operator.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(next.epoch, ended.epoch + 1, 'the run process may open the next epoch');
  assert.strictEqual(next.run.ended_at, null);
  await operator.run.end({ exit_reason: 'test' });
});
