'use strict';
// path-ids.test.cjs — an id that becomes a path segment takes one rule (src/core/path-ids.cjs). The core refuses a new worker,
// run or task id that breaks it before any row is written; a row that already exists can still be written. Real core, sandbox store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { isPathId, checkPathId } = core('path-ids.cjs');

const BAD = ['../../escaped', '..', 'a/b', 'a\\b', 'C:x', '.hidden', 'trail.', 'CON', 'nul.txt', 'com1', 'a b', '', 'x'.repeat(129)];
const GOOD = ['w1', 'peer', 'knowledge-3f1c2a9e-1111-4c4c-8888-0123456789ab', 'archreview-run-1-mhx2k3', 'a..b', 'console', 'x'.repeat(128)];

test('the rule: path-shaped, device and over-long ids are refused; uuids, job ids and plain names pass', () => {
  for (const id of BAD) assert.strictEqual(isPathId(id), false, `accepted ${JSON.stringify(id)}`);
  for (const id of GOOD) assert.strictEqual(isPathId(id), true, `refused ${JSON.stringify(id)}`);
  for (const v of [null, undefined, 7, {}, ['w1']]) assert.strictEqual(isPathId(v), false);
  assert.throws(() => checkPathId('worker_id', '../x'), (e) => e.code === 'E_ARGS' && /worker_id must be/.test(e.message) && e.detail.reason === 'id_shape');
});

let dir, orch;
before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});
after(async () => { try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); } });

test('worker.write refuses a new worker whose id is a path, and writes no row', async () => {
  for (const id of ['../../escaped', 'a/b', 'CON']) {
    await assert.rejects(orch.worker.write({ id, substrate: 'claude-code', state: 'starting' }), (e) => e.code === 'E_ARGS' && e.detail.reason === 'id_shape');
  }
  const { workers } = await orch.worker.list({});
  assert.deepStrictEqual(workers.map((w) => w.id), []);
  await orch.worker.write({ id: 'w-ok', substrate: 'claude-code', state: 'starting' });
  assert.strictEqual((await orch.worker.get({ worker_id: 'w-ok' })).id, 'w-ok');
});

test('task.create refuses a chosen task id that is a path, and still generates one when none is given', async () => {
  await assert.rejects(orch.task.create({ id: '../t', spec: 't' }), (e) => { assert.match(e.message, /task id must be/); return e.code === 'E_ARGS'; });
  const made = await orch.task.create({ spec: 't' });
  assert.ok(isPathId(made.id), made.id);
});

test('run.attach refuses a new run whose id is a path', async () => {
  const bad = await openCore({ dataDir: dir, caller: { ...callerFor('orchestrator'), run_id: '../run' }, embed: false });
  try {
    await assert.rejects(bad.run.attach({ adapter_pid: process.pid }), (e) => e.code === 'E_ARGS' && e.detail.reason === 'id_shape');
  } finally { await bad.close(); }
});
