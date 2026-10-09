'use strict';
// worker-write-started-at.test.cjs — worker.write refuses a started_at that is not an integer of epoch
// milliseconds. In process only: over the pipe JSON turns NaN and Infinity into null.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

test('worker.write refuses a non-numeric started_at with E_ARGS and writes nothing', async () => {
  await orch.worker.write({ id: 'w-s1', substrate: 'claude-code', pid: process.pid, state: 'starting', turns: 0, started_at: Date.now() });
  const seq = (await orch.worker.get({ worker_id: 'w-s1' })).seq;
  const snap = JSON.stringify((await orch.store.diff({ since_ms: 0 })).tables);

  for (const bad of ['soon', '1700000000000', 1.5, NaN, Infinity, true, {}]) {
    await assert.rejects(
      orch.worker.write({ id: 'w-s1', state: 'starting', started_at: bad }),
      (e) => {
        assert.strictEqual(e.code, 'E_ARGS', `started_at ${String(bad)}`);
        assert.match(e.message, /started_at/);
        assert.match(e.message, /w-s1/);
        assert.strictEqual(e.detail.worker_id, 'w-s1');
        return true;
      },
    );
  }

  assert.strictEqual((await orch.worker.get({ worker_id: 'w-s1' })).seq, seq, 'a refused write must not append');
  assert.strictEqual(JSON.stringify((await orch.store.diff({ since_ms: 0 })).tables), snap, 'the store must be unchanged');
});

test('worker.write refuses a bad started_at on a first write and leaves no row', async () => {
  await assert.rejects(
    orch.worker.write({ id: 'w-s2', substrate: 'claude-code', pid: process.pid, state: 'starting', turns: 0, started_at: 'soon' }),
    (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; },
  );
  await assert.rejects(
    orch.worker.get({ worker_id: 'w-s2' }),
    (e) => { assert.strictEqual(e.code, 'E_NOT_FOUND'); return true; },
  );
});

test('worker.write accepts an integer started_at, clears it with null and inherits it when absent', async () => {
  const at = 1700000000000;
  const first = await orch.worker.write({ id: 'w-s3', substrate: 'claude-code', pid: process.pid, state: 'starting', turns: 0, started_at: at });
  assert.strictEqual(first.started_at, at);
  const inherited = await orch.worker.write({ id: 'w-s3', state: 'starting', turns: 1 });
  assert.strictEqual(inherited.started_at, at);
  const cleared = await orch.worker.write({ id: 'w-s3', state: 'starting', started_at: null });
  assert.strictEqual(cleared.started_at, null);
  assert.strictEqual((await orch.worker.get({ worker_id: 'w-s3' })).started_at, null);
});

test('worker.write caps the echoed bad started_at at 80 characters', async () => {
  const long = 'x'.repeat(5000);
  await assert.rejects(
    orch.worker.write({ id: 'w-s4', substrate: 'claude-code', pid: process.pid, state: 'starting', turns: 0, started_at: long }),
    (e) => { assert.strictEqual(e.code, 'E_ARGS'); assert.ok(e.message.length < 300, `message length ${e.message.length}`); return true; },
  );
});

test('worker.write refuses an unsafe integer started_at with E_ARGS and leaves the store readable', async () => {
  await orch.worker.write({ id: 'w-u1', substrate: 'claude-code', pid: process.pid, state: 'starting', turns: 0 });
  const seq = (await orch.worker.get({ worker_id: 'w-u1' })).seq;
  const snap = JSON.stringify((await orch.store.diff({ since_ms: 0 })).tables);

  for (const bad of [2 ** 53, 2 ** 53 + 2, -(2 ** 53 + 2), 1e300, Number.MAX_VALUE]) {
    await assert.rejects(
      orch.worker.write({ id: 'w-u1', state: 'starting', started_at: bad }),
      (e) => {
        assert.strictEqual(e.code, 'E_ARGS', `started_at ${String(bad)}`);
        assert.match(e.message, /started_at/);
        assert.match(e.message, /w-u1/);
        assert.strictEqual(e.detail.worker_id, 'w-u1');
        return true;
      },
    );
  }

  assert.strictEqual((await orch.worker.get({ worker_id: 'w-u1' })).seq, seq, 'a refused write must not append');
  assert.strictEqual(JSON.stringify((await orch.store.diff({ since_ms: 0 })).tables), snap, 'the store must be unchanged');
  assert.ok(Array.isArray((await orch.worker.list({})).workers));
});

test('rowOf leaves out an inherited started_at that is not a safe integer', () => {
  const os = require('node:os');
  const { newWorkerRecord, rowOf } = require('../../src/run/worker.cjs');
  const dir = require('node:fs').mkdtempSync(require('node:path').join(os.tmpdir(), 'belay-wsa-'));
  const w = newWorkerRecord({ id: 'w-u2', substrate: 'claude-code', worktree: dir, dataDir: dir, captureBase: false });
  for (const bad of [1e300, 2 ** 53 + 2]) {
    w.startedAt = bad;
    const row = rowOf(w, 'stopped', { runId: 'run-x', adapterPid: process.pid });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'started_at'), false, `startedAt ${String(bad)}`);
  }
  w.startedAt = 1700000000000;
  assert.strictEqual(rowOf(w, 'stopped', { runId: 'run-x', adapterPid: process.pid }).started_at, 1700000000000);
});

test('worker.write accepts Number.MAX_SAFE_INTEGER as started_at and reads it back exactly', async () => {
  const w = await orch.worker.write({ id: 'w-u3', substrate: 'claude-code', pid: process.pid, state: 'starting', turns: 0, started_at: Number.MAX_SAFE_INTEGER });
  assert.strictEqual(w.started_at, Number.MAX_SAFE_INTEGER);
  assert.strictEqual((await orch.worker.get({ worker_id: 'w-u3' })).started_at, Number.MAX_SAFE_INTEGER);
});
