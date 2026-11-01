'use strict';
// `belay worker stop` of a worker whose process cannot be proven must not report a stop (sandbox store, built CLI as a subprocess,
// the scaffold of tests/cli/pause.test.cjs).
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

test('worker stop of an adopted row whose pid cannot be proven exits non-zero, says it was not stopped, and gives the manual step', async () => {
  const dir = sandbox(); const dataDir = `${dir}/.belay`; const home = `${dir}/home`; fs.mkdirSync(home);
  let ctx = {}; const s = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    ctx = await setup(dataDir, 'run-unv-stop');
    await ctx.core.worker.write({ id: 'w-p', substrate: 'claude-code', pid: s.pid, state: 'running', session_id: 'sess-1', worktree: wtOf(dir, 'w-p'), started_at: Date.now(), pid_created: null, pid_created_error: 'the process snapshot was unreadable at spawn' });
    const j = await cli(['worker', 'stop', 'w-p'], dataDir, home);
    assert.notStrictEqual(j.status, 0, 'exit code');
    assert.ok(j.receipt, `json receipt: ${j.stdout} ${j.stderr}`);
    assert.strictEqual(j.receipt.stopped, false);
    assert.strictEqual(j.receipt.may_be_live, true);
    assert.strictEqual(j.receipt.kind, 'unverifiable');
    assert.ok(j.receipt.manual && j.receipt.manual.includes(String(s.pid)), 'manual step names the pid');
    assert.strictEqual(j.receipt.row_state, 'running', 'the refused stop restates the prior state');
    const t = await cli(['worker', 'stop', 'w-p'], dataDir, home, false);
    assert.notStrictEqual(t.status, 0);
    const text = t.stdout + t.stderr;
    assert.match(text, /NOT stopped/);
    assert.match(text, /could not be proven/);
    assert.match(text, /its row is running/);
    assert.doesNotMatch(text, /already gone/);
    const row = readStoreCopy(dataDir, (db) => db.prepare('SELECT state FROM worker WHERE id = ? ORDER BY seq DESC LIMIT 1').get('w-p'));
    await sleep(100);
    assert.strictEqual(running(s), true, 'the unproven process was not killed');
    assert.strictEqual(row.state, 'running', 'no stopping row is left behind a stop that did not happen');
    assert.strictEqual(ctx.m._worker('w-p').stopRequested, false, 'a later death is not credited to a stop that never happened');
  } finally { s.kill(); await teardown({ ...ctx, dir }); }
});
