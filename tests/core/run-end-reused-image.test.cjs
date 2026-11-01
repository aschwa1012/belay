'use strict';
// run-end-reused-image.test.cjs — run.end's close of the ending epoch for a row with no creation time but a recorded image.
// The snapshot is the OS's, so this runs on Windows only. A live pid held by another image than the row's has been reused: the row
// closes dead, its reason names the reuse, and the process is never touched. The same image with no creation time stays alive.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const WIN = { skip: process.platform !== 'win32' };

test('run.end: a live pid held by another image than the row recorded (no creation time) ends the row dead, naming the reuse', WIN, async () => {
  const dir = sandbox();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  const exited = new Promise((r) => holder.once('exit', r));
  try {
    await orch.run.attach({ adapter_pid: process.pid });
    const t = Date.now();
    await orch.worker.write({ id: 'w-reused', substrate: 'claude-code', pid: holder.pid, pid_image: 'conhost.exe', state: 'running', turns: 0, started_at: t });
    await orch.worker.write({ id: 'w-same', substrate: 'claude-code', pid: holder.pid, pid_image: path.basename(process.execPath), state: 'running', turns: 0, started_at: t });
    const ended = await orch.run.end({ exit_reason: 'test end' });
    assert.deepStrictEqual(ended.workers_marked_dead.map((m) => m.worker_id), ['w-reused'], JSON.stringify(ended.workers_marked_dead));
    const reused = await orch.worker.get({ worker_id: 'w-reused' });
    assert.strictEqual(reused.state, 'dead');
    assert.match(reused.death_established_by, /held by another image than the conhost\.exe the row recorded.*pid was reused/);
    assert.strictEqual((await orch.worker.get({ worker_id: 'w-same' })).state, 'running', 'the same image with no creation time is unverifiable, so it is taken as alive');
    assert.strictEqual(holder.exitCode, null, 'run.end never touches a process');
  } finally {
    holder.kill();
    await exited;
    await orch.shutdownOwner();
    await orch.close();
    cleanup(dir);
  }
});
