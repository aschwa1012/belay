'use strict';
// paused-spawn-gate.test.cjs — a paused run starts no new work: the orchestrator's worker_spawn is refused E_PAUSED while the run's row
// says paused (any reason), the operator's spawn is not, and a usage row starts ahead of a slow memory queue.

const test = require('node:test');
const assert = require('node:assert');
const { refuseSpawnIfPaused } = require('../../src/run/paused-gate.cjs');
const UE = require('../../src/run/usage-early.cjs');

const core = (role, run) => ({ caller: { role }, run: { get: async () => ({ run }) } });

test('the orchestrator spawn is refused while paused, for a budget pause and for any other', async () => {
  for (const paused_by of ['operator:1 [budget (run, $9.00 of $10.00 est.)]', 'operator:1', 'operator:1 [embedder-failure (w)]']) {
    await assert.rejects(refuseSpawnIfPaused(core('orchestrator', { id: 'r', paused_at: 5, paused_by, ended_at: null }), 'r'), (e) => e.code === 'E_PAUSED' && e.detail.run_id === 'r');
  }
});

test('an unpaused run, an ended run and the operator spawn are not refused', async () => {
  await refuseSpawnIfPaused(core('orchestrator', { id: 'r', paused_at: null, ended_at: null }), 'r');
  await refuseSpawnIfPaused(core('orchestrator', { id: 'r', paused_at: 5, ended_at: 9 }), 'r');
  await refuseSpawnIfPaused(core('operator', { id: 'r', paused_at: 5, paused_by: 'x', ended_at: null }), 'r');
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
