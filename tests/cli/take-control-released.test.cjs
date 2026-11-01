'use strict';
// `belay take-control` of a task whose lease was already released must not park the worker, which may now hold another task
// (sandbox store, built CLI as a subprocess, the scaffold of tests/cli/pause.test.cjs).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sandbox, cleanup, readStoreCopy } = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { createRunManager, createWorkerControl } = require('../../src/run/index.cjs');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli', 'belay.cjs');
const FAKE_CLAUDE = path.join(ROOT, 'tests', 'run', 'fakes', 'fake-claude.cjs');
const USER_SETTINGS = path.join(ROOT, 'tests', 'run', 'fixtures', 'user-settings.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = (c) => c.exitCode === null && c.signalCode === null;

function cli(args, dataDir, home, json = true) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args, '--data', dataDir, ...(json ? ['--json'] : [])], { cwd: ROOT, windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home } });
    let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
    let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
    proc.once('exit', (status) => {
      let receipt = null;
      try { receipt = JSON.parse(status === 0 ? stdout : stderr || stdout); } catch { /* left null */ }
      resolve({ status, stdout, stderr, receipt });
    });
  });
}
async function setup(dataDir, runId) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid } });
  await core.run.attach({ adapter_pid: process.pid });
  const m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });
  const control = createWorkerControl({ redeem: null, dataDir, manager: m });
  await control.listen();
  return { core, m, control };
}
async function teardown({ core, m, control, dir }) {
  if (control) { try { await control.close(); } catch { /* */ } }
  if (m) { try { await m.shutdown(); } catch { /* */ } }
  else if (core) { try { if (core.isOwner()) await core.shutdownOwner(); } catch { /* */ } try { await core.close(); } catch { /* */ } }
  if (dir) cleanup(dir);
}
const wtOf = (dir, id) => { const p = `${dir}/${id}-wt`; fs.mkdirSync(p, { recursive: true }); return p; };

test('take-control of a task whose lease was already released parks no worker, even one now on another task', async () => {
  const dir = sandbox(); const dataDir = `${dir}/.belay`; const home = `${dir}/home`; fs.mkdirSync(home);
  let ctx = {};
  try {
    ctx = await setup(dataDir, 'run-unv-tc');
    const { core, m } = ctx;
    await m.spawn({ substrate: 'claude-code', worktree: wtOf(dir, 'w1'), prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const t1 = await core.task.create({ spec: 'T1, handed back' });
    const a1 = await core.task.assign({ task_id: t1.id, worker_id: 'w1' });
    const op = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
    try { await op.lease.release({ lease_id: a1.new_lease.id, reason: 'handed back' }); } finally { await op.close(); }
    const t2 = await core.task.create({ spec: 'T2, now held by w1' });
    await core.task.assign({ task_id: t2.id, worker_id: 'w1' });
    const r = await cli(['take-control', t1.id], dataDir, home);
    assert.strictEqual(r.status, 0, JSON.stringify(r.receipt));
    assert.strictEqual(r.receipt.taken, true);
    assert.strictEqual(r.receipt.paused_worker, null, 'no worker is parked for a released lease');
    assert.match(r.receipt.note, /already released/);
    const row = readStoreCopy(dataDir, (db) => db.prepare('SELECT state FROM worker WHERE id = ? ORDER BY seq DESC LIMIT 1').get('w1'));
    assert.notStrictEqual(row.state, 'paused', 'w1 still works on T2');
  } finally { await teardown({ ...ctx, dir }); }
});
