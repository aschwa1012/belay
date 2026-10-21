'use strict';
// attach-memory-default.test.cjs — a re-run over a run that never ended must not inherit that run's memory levers (audit D55).
// run.attach carries an absent field forward from an unended epoch; `belay run` therefore sends every memory column, null for a
// default block.

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { attachMemory } = require('../../src/cli/run-levers.cjs');
const { parseLevers } = require('../../src/cli/run-levers.cjs');

const { openCore } = core('index.cjs');

test('a default block sends nulls, and a block without a project sends a null project', () => {
  assert.deepStrictEqual(attachMemory(parseLevers({}, {})), { memory_levers: null, project: null });
  assert.deepStrictEqual(attachMemory({}), { memory_levers: null, project: null });
  const noProject = attachMemory({ memory_levers: { notes: true } });
  assert.strictEqual(noProject.project, null);
  assert.strictEqual(noProject.memory_levers, '{"notes":true}');
  assert.deepStrictEqual(attachMemory({ memory_levers: { notes: true, project: 'p' } }).project, 'p');
});

test('a re-run with no memory block over a never-ended epoch gets the defaults, not the old levers or project', async () => {
  const dir = sandbox();
  const op = await openCore({ dataDir: dir, caller: callerFor('operator', { run_id: 'rr' }), embed: false });
  try {
    const first = await op.run.attach({ adapter_pid: process.pid, ...attachMemory({ memory_levers: { notes: true, project: 'p' } }) });
    assert.strictEqual(JSON.parse(first.run.memory_levers).notes, true);
    assert.strictEqual(first.run.project, 'p');
    // no run.end: the previous epoch is unended, exactly the case the carry rule covers
    const second = await op.run.attach({ adapter_pid: process.pid, ...attachMemory(parseLevers({}, {})) });
    assert.strictEqual(second.reattached, true);
    assert.strictEqual(second.run.memory_levers, null, 'the old levers were not inherited');
    assert.strictEqual(second.run.project, null, 'the old project was not inherited');
    // the orchestrator adapter sends neither and still carries them: its attach does not decide the levers
    const third = await op.run.attach({ adapter_pid: process.pid, ...attachMemory({ memory_levers: { capture: true } }) });
    const adapter = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'rr' }), embed: false });
    try {
      const carried = await adapter.run.attach({ adapter_pid: process.pid });
      assert.strictEqual(carried.run.memory_levers, third.run.memory_levers, 'an adapter attach carries the run process\'s levers');
    } finally { await adapter.close(); }
  } finally {
    await op.shutdownOwner();
    await op.close();
    cleanup(dir);
  }
});
