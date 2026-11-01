'use strict';
require('../helpers/tmp.cjs');
// The manager's refusal of another live run's worker, end to end over a REAL core with two live runs (the unit test in
// other-run-worker.test.cjs stubs run.list). Run A's worker X holds A's task; run B's manager is asked to restart it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../../src/run/process.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const FAKE_CODEX = fwd(path.join(__dirname, 'fakes', 'fake-codex.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, 'fixtures', 'user-settings.json'));

test('a real core: run B\'s restart of run A\'s live worker is refused with nothing killed, moved or rewritten', async (t) => {
  const dir = sandbox();
  const cores = [];
  const kills = [];
  const killProcess = P.killProcess;
  P.killProcess = async (...a) => { kills.push(a); return { tree: null, refused: { refused: 'test' } }; }; // never calls through
  let m = null;
  t.after(async () => {
    P.killProcess = killProcess;
    if (m) await m.shutdown().catch(() => {});
    for (const c of cores.slice(1)) await c.close().catch(() => {});
    await cores[0].shutdownOwner().catch(() => {});
    await cores[0].close().catch(() => {});
    cleanup(dir);
  });
  const live = async (runId) => { const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: runId }), embed: false }); cores.push(c); await c.run.attach({ adapter_pid: process.pid }); return c; };
  const a = await live('ra');
  const b = await live('rb');
  await a.task.create({ id: 'T', spec: 's', files_owned: ['t.txt'], acceptance: { files_within_owned: true } });
  fs.mkdirSync(path.join(dir, 'wt'), { recursive: true });
  await a.worker.write({ id: 'X', substrate: 'claude-code', worktree: fwd(path.join(dir, 'wt')), pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  await a.task.assign({ task_id: 'T', worker_id: 'X' });
  const w0 = await a.worker.get({ worker_id: 'X' });
  const t0 = await a.task.get({ task_id: 'T' });

  m = createRunManager({ core: b.harness(), dataDir: fwd(dir), runId: 'rb', paths: { claudeExe: FAKE, codexExe: FAKE_CODEX, userSettings: USER_SETTINGS } });
  await assert.rejects(m.restart({ worker_id: 'X', first_turn_timeout_ms: 5000 }), (e) => { assert.strictEqual(e.code, 'E_ROLE', e.message); assert.strictEqual(e.detail.worker_run_id, 'ra'); return true; });

  assert.deepStrictEqual(kills, [], 'nothing was killed');
  assert.strictEqual((await a.worker.get({ worker_id: 'X' })).seq, w0.seq, 'no worker row was written');
  const t1 = await a.task.get({ task_id: 'T' });
  assert.strictEqual(t1.run_id, 'ra');
  assert.strictEqual(t1.seq, t0.seq, 'the task was not moved');
  assert.ok(!fs.existsSync(path.join(dir, 'workers', 'X', 'mcp.json')), 'mcp.json was not written');
  assert.ok(!fs.existsSync(path.join(dir, 'workers', 'X', 'settings.json')), 'settings.json was not written');
});
