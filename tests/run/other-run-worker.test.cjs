'use strict';
require('../helpers/tmp.cjs');
// A run manager does not act on a worker of another LIVE run. The refusal (E_ROLE) comes before any effect: no kill, no
// hold (task move), no rewrite of the worker's mcp.json or settings.json, no launch, no row write. Before the fix the core's
// own-run guard refused only the first row write, after the manager had killed the worker, rehomed its task, rewritten its
// files and started a process on its session. A worker of a run that has ended is still adopted.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = require('../../src/run/process.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const FAKE_CODEX = fwd(path.join(__dirname, 'fakes', 'fake-codex.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, 'fixtures', 'user-settings.json'));

// The manager of run 'rb' over a fake core that holds worker X as a row of run 'ra'. `runA` is run A's row: live (this
// process is its adapter) or ended. `kills` records every kill the manager attempts.
function setup(t, { substrate, state, runA }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-otherrun-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const recvFile = fwd(path.join(d, 'recv.jsonl'));
  process.env.FAKE_RECV_FILE = recvFile;
  const core = createFakeCore({ runId: 'rb' });
  core.run = { async list() { return { runs: [{ id: 'ra', ...runA }, { id: 'rb', ended_at: null, alive: true }] }; } };
  const kills = [];
  const killProcess = P.killProcess; // never calls through: a regressed manager must not kill this process
  P.killProcess = async (...a) => { kills.push(a); return { tree: null, refused: { refused: 'test' } }; };
  const m = createRunManager({ core, dataDir: fwd(d), runId: 'rb', paths: { claudeExe: FAKE, codexExe: FAKE_CODEX, userSettings: USER_SETTINGS } });
  t.after(async () => { P.killProcess = killProcess; await m.shutdown().catch(() => {}); delete process.env.FAKE_RECV_FILE; try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* tmp */ } });
  return {
    core, m, kills, dir: d,
    seed: () => core.worker.write({ id: 'X', run_id: 'ra', substrate, state, pid: process.pid, session_id: 's', worktree: fwd(path.join(d, 'wt')), task_id: 'T', last_event_at: Date.now() }),
    // Everything a refused call must leave alone.
    untouched: (before) => {
      assert.deepStrictEqual(kills, [], 'nothing was killed');
      assert.strictEqual(core.callsTo('task.ensureHold').length, 0, 'no task was held (moved)');
      assert.strictEqual(core.rowsFor('X').length, before, 'no row was written');
      assert.strictEqual(core.currentWorker('X').run_id, 'ra');
      assert.ok(!fs.existsSync(path.join(d, 'workers', 'X', 'mcp.json')), 'mcp.json was not rewritten');
      assert.ok(!fs.existsSync(path.join(d, 'workers', 'X', 'settings.json')), 'settings.json was not rewritten');
      assert.ok(!fs.existsSync(recvFile), 'nothing was launched');
    },
  };
}

const LIVE = { ended_at: null, alive: true };
const refused = (e) => { assert.strictEqual(e.code, 'E_ROLE', e.message); assert.strictEqual(e.detail.worker_run_id, 'ra'); return true; };

test('restart of a Claude Code worker of another live run is refused before any effect', async (t) => {
  const s = setup(t, { substrate: 'claude-code', state: 'running', runA: LIVE });
  await s.seed();
  await assert.rejects(s.m.restart({ worker_id: 'X', first_turn_timeout_ms: 5000 }), refused);
  s.untouched(1);
});

test('message to a Codex worker of another live run is refused before any effect', async (t) => {
  const s = setup(t, { substrate: 'codex', state: 'idle', runA: LIVE });
  await s.seed();
  await assert.rejects(s.m.message({ worker_id: 'X', text: 'from run B' }), refused);
  s.untouched(1);
});

test('stop, pause and resume of a worker of another live run are refused before any effect', async (t) => {
  const s = setup(t, { substrate: 'claude-code', state: 'running', runA: LIVE });
  await s.seed();
  for (const verb of ['stop', 'pause', 'resume']) {
    if (typeof s.m[verb] !== 'function') continue;
    await assert.rejects(s.m[verb]({ worker_id: 'X', by: 'operator' }), refused, verb);
  }
  s.untouched(1);
});

test('a worker of a run that has ended is still adopted', async (t) => {
  const s = setup(t, { substrate: 'codex', state: 'idle', runA: { ended_at: Date.now(), alive: false } });
  await s.seed();
  const out = await s.m.message({ worker_id: 'X', text: 'adopt me' });
  assert.strictEqual(out.channel, 'codex-resume');
  assert.strictEqual(s.core.callsTo('task.ensureHold').length, 1, 'its task is held for run B');
});
