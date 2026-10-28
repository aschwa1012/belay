'use strict';
// paused-spawn-gate.test.cjs — the run manager asks the core before an orchestrator's spawn or restart (the core refuses E_PAUSED while the
// run is paused, unless the owner says the orchestrator is not gated); the operator is not asked. Also: a usage row starts ahead of a
// slow memory queue.

const test = require('node:test');
const assert = require('node:assert');
const { refuseSpawnIfPaused } = require('../../src/run/paused-gate.cjs');
const UE = require('../../src/run/usage-early.cjs');

const core = (role, answer) => { const c = { asked: 0, caller: { role }, run: { assertNotPaused: async () => { c.asked += 1; return answer(); } } }; return c; };
const paused = () => { throw Object.assign(new Error('paused'), { code: 'E_PAUSED', detail: { run_id: 'r' } }); };

test('the orchestrator spawn is asked of the core, and the core refusal reaches the caller', async () => {
  await assert.rejects(refuseSpawnIfPaused(core('orchestrator', paused), 'r'), (e) => e.code === 'E_PAUSED');
  const ok = core('orchestrator', async () => ({ paused: false }));
  await refuseSpawnIfPaused(ok, 'r');
  assert.strictEqual(ok.asked, 1);
});

test('the operator spawn is not asked', async () => {
  const c = core('operator', paused);
  await refuseSpawnIfPaused(c, 'r');
  assert.strictEqual(c.asked, 0);
});

test('a core that cannot answer fails the spawn closed, not open', async () => {
  await assert.rejects(refuseSpawnIfPaused(core('orchestrator', () => { throw Object.assign(new Error('no owner'), { code: 'E_NO_OWNER' }); }), 'r'), (e) => e.code === 'E_NO_OWNER');
});

test('the usage row is written while the worker memory queue is still busy, and the queue still waits for it', async () => {
  const records = [];
  let release;
  const slow = new Promise((r) => { release = r; });
  const ctx = { core: { usage: { record: async (a) => { records.push(a); return a; } } }, memoryLevers: { cost_ledger: true }, shutdownFlags: {} };
  const w = { id: 'w1', memoryQueue: slow, memoryJobs: null };
  const snap = { turn: 1, usage: { input_tokens: 1, output_tokens: 1 }, cost: 0.5, pid: 10, substrate: 'claude-code', model: 'm', taskId: null, workerId: 'w1', since: 0, until: 1000 };
  await UE.start(w, ctx, snap);
  assert.strictEqual(records.length, 1, 'written before the slow queued job finished');
  assert.strictEqual(records[0].turn_window.until, 1000);
  let drained = false;
  w.memoryQueue.then(() => { drained = true; });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(drained, false, 'the queue is still held by the slow job');
  release();
  await w.memoryQueue;
  assert.strictEqual(drained, true);
});
