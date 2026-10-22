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

// The adapter is another process, so the per-Core E_SHUTDOWN guard (ADR 0051) cannot see that the owner was shut down. After run.end
// a late orchestrator-role process must neither write into the run nor be elected the store owner. The child process is the late adapter.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const CHILD = require('node:path').join(__dirname, 'attach-after-end-child.cjs');
const { readStoreCopy } = require('../cli/stop-helpers.cjs');

function lateAdapter(dataDir) { // async: the owner may live in this process, and a blocking spawn would stop it answering
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CHILD, dataDir, 'test-run'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`child failed: ${out} ${err}`));
      resolve(JSON.parse(out.trim().split('\n').pop()));
    });
  });
}
const counts = (dataDir) => readStoreCopy(dataDir, (db) => ({ runs: db.prepare('SELECT COUNT(*) AS n FROM run').get().n, workers: db.prepare('SELECT COUNT(*) AS n FROM worker').get().n }));

test('a late orchestrator process after the owner shut down is not elected owner and writes nothing into the ended run', async (tcx) => {
  const d = sandbox();
  const op = await openCore({ dataDir: d, caller: callerFor('operator'), embed: false });
  tcx.after(() => Promise.resolve().then(() => op.shutdownOwner()));
  tcx.after(() => Promise.resolve().then(() => op.close()));
  try {
    await op.run.attach({ adapter_pid: process.pid });
    await op.run.end({ exit_reason: 'test' });
    const before = counts(d);
    await op.shutdownOwner();
    await op.close();
    assert.ok(!fs.existsSync(`${d}/owner.lock`), 'the owner is gone before the late adapter arrives');
    const out = await lateAdapter(d);
    assert.strictEqual(out.worker, 'E_SHUTDOWN');
    assert.strictEqual(out.attach, 'E_SHUTDOWN');
    assert.strictEqual(out.isOwner, false);
    assert.ok(!fs.existsSync(`${d}/owner.lock`), 'no stray owner was left behind');
    assert.deepStrictEqual(counts(d), before, 'nothing was written into the ended run');
  } finally { try { await op.close(); } catch { /* closed */ } cleanup(d); }
});

test('a late orchestrator process that reaches a live owner is refused a worker write and an attach on the ended run', async () => {
  const d = sandbox();
  const op = await openCore({ dataDir: d, caller: callerFor('operator'), embed: false });
  try {
    await op.run.attach({ adapter_pid: process.pid });
    await op.run.end({ exit_reason: 'test' });
    const before = counts(d);
    const out = await lateAdapter(d);
    assert.strictEqual(out.worker, 'E_ARGS');
    assert.strictEqual(out.attach, 'E_ARGS');
    assert.strictEqual(out.isOwner, false);
    assert.deepStrictEqual(counts(d), before);
  } finally { try { if (op.isOwner()) await op.shutdownOwner(); } finally { await op.close(); cleanup(d); } }
});
