'use strict';
// Audit 0.3.1, run R1. A stop of a worker the store already records as dead, whose pid number now
// names another live process (pid reuse), must write nothing over the terminal row: the death is a
// fact, and a bare signal-0 check cannot tell the reused pid from the worker (ADR 0039). The reused
// pid is stood in for by a sleeper this test spawns and ends by its own handle.
// Run: node --test tests/audit-0-3-1/stop-reused-pid.audit.cjs (npm test does not glob *.audit.cjs).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('../run/fake-core.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, '..', 'run', 'fakes', 'fake-claude.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, '..', 'run', 'fixtures', 'user-settings.json'));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-audit-reuse-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { root: d, data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}

function sleeper() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  return new Promise((res) => c.once('spawn', () => res(c)));
}

async function plantDead(core, sb, id, pid, identity) {
  await core.worker.write({
    id, run_id: 'run-old', substrate: 'claude-code', pid, session_id: 's-old', adapter_pid: 1, state: 'dead',
    worktree: sb.worktree, task_id: null, started_at: Date.now() - 60000, exited_at: Date.now() - 30000,
    exit_code: 1, exit_signal: null, death_established_by: 'exit-event', turns: 1, ...identity,
  });
}

for (const [name, identity] of [
  ['a recorded creation time that does not match (mismatch)', { pid_created: 1000, pid_created_error: null, pid_image: 'node.exe' }],
  ['no recorded creation time (unverifiable)', { pid_created: null, pid_created_error: 'never read: the worker exited before its creation time was read (1 try)', pid_image: 'node.exe' }],
]) {
  test(`stop of a dead worker whose pid was reused, ${name}, leaves the dead row as it was`, async (t) => {
    const sb = sandbox();
    const core = createFakeCore();
    const other = await sleeper();
    t.after(() => { try { other.kill(); } catch { /* gone */ } try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* tmp */ } });
    const id = 'w-reuse-' + (identity.pid_created ? 'm' : 'u');
    await plantDead(core, sb, id, other.pid, identity);
    const m = createRunManager({ core, dataDir: sb.data, runId: 'run-new', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
    t.after(() => m.shutdown().catch(() => {}));

    const r = await m.stop({ worker_id: id, mode: 'kill', timeout_ms: 2000 });
    const states = core.rowsFor(id).map((x) => x.state);
    const cur = core.currentWorker(id);
    // Evidence for the report, whatever the assertions below find.
    console.log(JSON.stringify({ case: name, states, last: { run_id: cur.run_id, state: cur.state, pid_alive_now: core.currentWorker(id) && require("../../src/run/process.cjs").pidAlive(cur.pid) }, receipt: { killed: r.killed, refused: r.refused, kind: r.kind, ms_to_exit: r.ms_to_exit } }));
    assert.equal(other.exitCode, null, 'the unrelated process must not have been killed');
    assert.deepEqual(states, ['dead'], 'nothing may be written over a terminal row for a process that died long ago');
    assert.equal(cur.state, 'dead');
  });
}
