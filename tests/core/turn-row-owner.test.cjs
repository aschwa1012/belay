'use strict';
// turn-row-owner.test.cjs — a turn row names the worker it is about as worker_id, but the harness wrote it (written_by
// harness). The worker may not delete or supersede it, and the harness's rows about a worker do not count toward that
// worker's own row quota in its run namespace. A row the worker wrote itself stays its own to delete.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, h, w;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  h = orch.harness();
  await orch.worker.write({ id: 'dw1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-dw1', last_event_at: Date.now() });
  w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'dw1' }), embed: false });
});

after(async () => {
  await w.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

const turnRow = (n) => h.memory.store({ text: `turn ${n} of dw1`, type: 'turn', worker_id: 'dw1', turn: n, embed: false });

test('a worker cannot delete or supersede the harness turn row about itself, and can delete its own row', async () => {
  const t = await turnRow(1);
  assert.strictEqual(t.worker_id, 'dw1');
  assert.strictEqual(t.written_by, 'harness');
  await assert.rejects(w.memory.delete({ id: t.id }), (e) => e.code === 'E_ROLE' && /only its own unverified rows/.test(e.message));
  await assert.rejects(w.memory.store({ text: 'replacing my turn', supersedes: t.id, embed: false }), (e) => e.code === 'E_ROLE');
  const rows = (await orch.memory.list({ namespace: t.namespace, view: 'full', limit: 50 })).rows;
  assert.ok(rows.some((r) => r.id === t.id), 'the turn row stands');
  const mine = await w.memory.store({ text: 'my own note', embed: false });
  assert.strictEqual((await w.memory.delete({ id: mine.id })).deleted, true, 'its own row is still its to delete');
});

test('the harness\'s rows about a worker do not count toward the worker\'s quota', async () => {
  const store = orch.owner.store;
  const ns = (await turnRow(2)).namespace;
  store.tx(() => {
    for (let i = 0; i < 2000; i += 1) store.storeIn({ namespace: ns, worker_id: 'dw1', text: `bulk turn ${i}`, type: 'turn', written_by: 'harness', run_id: 'test-run' });
  });
  const mine = await w.memory.store({ text: 'still room for my own row', embed: false });
  assert.strictEqual(mine.worker_id, 'dw1');
});
