'use strict';
// The ready gate: what has to be true before a worker row is ever written `running`.
//
// Three separate claims, one per contract §5 clause, each with its own way of failing:
//   the pid is alive at the moment `running` is written (ADR 0004 §2);
//   Claude Code showed `belay` connected in its system/init `mcp_servers` (ADR 0001 §8);
//   Codex's worker adapter logged a tools/list to workers/<id>/adapter.log inside the window.
// Each failure is E_NO_READY carrying pid, exit_code, stderr_tail and a reason naming what was
// seen, and the row the store ends up with is `dead` — never `running` (invariant 5).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { openCore } = require('../../src/core/index.cjs');
const P = require('../../src/run/process.cjs');

const fwd = (p) => p.replace(/\\/g, '/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const FAKE_INIT_THEN_EXIT = fwd(path.join(__dirname, 'fakes', 'fake-claude-init-then-exit.cjs'));
const FAKE_CODEX = fwd(path.join(__dirname, 'fakes', 'fake-codex.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, 'fixtures', 'user-settings.json'));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-ready-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { root: d, data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}

function mgr(sb, core, exe) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-ready',
    paths: { claudeExe: exe, codexExe: exe, userSettings: USER_SETTINGS },
  });
}

// Poll for a condition rather than sleeping a guessed interval: the tests below have to act at an
// exact point inside a pending spawn, and a fixed sleep would be the race they exist to remove.
async function until(pred, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out after ' + ms + ' ms waiting for ' + what);
}

const cleanup = (sb) => { try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* temp dir */ } };

// ------------------------------------------------------------------ the pid

// The substrate prints one system/init and exits 7, with the exit established first (the fake says
// how). Whichever liveness channel the manager keys on, the contract fixes one outcome: E_NO_READY
// carrying the exit code, and a `dead` row. The two tests after this one pin the branches
// separately, because this one cannot say which ran.
test('an init followed by exit 7 is E_NO_READY carrying exit_code 7, and the row is dead', async (tcx) => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE_INIT_THEN_EXIT);
  tcx.after(() => Promise.resolve().then(() => m.shutdown()));
  await assert.rejects(
    () => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'wd', startup_timeout_ms: 8000 }),
    (e) => {
      assert.equal(e.code, 'E_NO_READY');
      assert.equal(e.detail.exit_code, 7, 'the substrate exited 7 and the error must say so');
      assert.ok(Number.isInteger(e.detail.pid) && e.detail.pid > 0);
      assert.equal(typeof e.detail.reason, 'string');
      assert.ok(e.detail.reason.length > 0);
      assert.equal(P.pidAlive(e.detail.pid), false);
      return true;
    }
  );
  const states = core.rowsFor('wd').map((r) => r.state);
  assert.ok(!states.includes('running'), 'a worker that died at ready is never written running');
  assert.equal(states[states.length - 1], 'dead');
  assert.equal(core.currentWorker('wd').exit_code, 7);
  await m.shutdown();
  cleanup(sb);
});

// The same substrate against the real core, which refuses `running` with a dead pid itself
// (E_WORKER_NOT_LIVE). The manager owes its caller the documented code and the stderr tail, so that
// refusal must never reach the caller as-is.
test('the same worker against the real core is E_NO_READY too, never E_WORKER_NOT_LIVE', async () => {
  const sb = sandbox();
  const dataDir = fwd(path.join(sb.root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const runId = 'run-ready-real-' + process.pid;
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: false });
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_INIT_THEN_EXIT, userSettings: USER_SETTINGS } });
    await assert.rejects(
      () => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'wr', startup_timeout_ms: 8000 }),
      (e) => {
        assert.equal(e.code, 'E_NO_READY', 'got ' + e.code + ': ' + e.message);
        assert.equal(e.detail.exit_code, 7);
        return true;
      }
    );
    const row = await core.worker.get({ worker_id: 'wr' });
    assert.equal(row.state, 'dead');
    assert.equal(row.pid_alive, false);
    assert.equal(row.exit_code, 7);
  } finally {
    if (m) await m.shutdown().catch(() => {});
    await core.close().catch(() => {});
    cleanup(sb);
  }
});

// A worker that reaches ready and dies before the `running` row is written. The kill lands while
// spawn is inside the Codex ready check, so the order is fixed rather than raced: ready first, then
// death, then the write. Contract §5 makes this E_NO_READY; before the pid check it produced a
// `running` row for a dead process, which is the row ADR 0004 §2 exists to forbid.
test('a worker that dies between its ready event and the running write is E_NO_READY', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE_CODEX);
  process.env.FAKE_CODEX_NO_TOOLS_LIST = '1'; // the test writes the adapter's line itself, after the kill
  process.env.FAKE_CODEX_HANG = '1';
  try {
    const pending = m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'go', worker_id: 'cz', startup_timeout_ms: 20000 });
    await until(() => m._worker('cz'), 8000, 'the spawn to register the worker'); // the id check reads the store first, so the record is not there on the same tick
    const w = m._worker('cz');
    await until(() => w.readyAt && w.pid, 8000, 'the worker to report thread.started');

    require('../crash.cjs').crash(w.child);
    assert.equal(await P.waitPidGone(w.pid, { timeoutMs: 5000 }) !== null, true, 'the worker is gone before the write');
    // Its adapter had connected and listed its tools before the worker died, so the ADR 0001 §8
    // check passes and the only thing left standing between a dead worker and a `running` row is
    // the pid check.
    fs.appendFileSync(path.join(sb.data, 'workers', 'cz', 'adapter.log'), JSON.stringify({ method: 'tools/list' }) + '\n');

    await assert.rejects(() => pending, (e) => {
      assert.equal(e.code, 'E_NO_READY');
      assert.match(e.detail.reason, /no longer alive when the running row would have been written/);
      assert.equal(e.detail.pid, w.pid);
      return true;
    });
    const states = core.rowsFor('cz').map((r) => r.state);
    assert.ok(!states.includes('running'), 'the row a dead process must never get: ' + states.join(','));
    assert.equal(states[states.length - 1], 'dead');
  } finally {
    delete process.env.FAKE_CODEX_NO_TOOLS_LIST;
    delete process.env.FAKE_CODEX_HANG;
    await m.shutdown();
    cleanup(sb);
  }
});

// The other half of the same finding: the manager's own pid check passed, and the core refused the
// write. The caller is owed the documented code and the stderr tail, not the core's internal
// refusal leaking out of spawn.
test('a core that refuses running with E_WORKER_NOT_LIVE still reaches the caller as E_NO_READY', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE);
  const realWrite = core.worker.write.bind(core.worker);
  core.worker.write = async (r) => {
    // The worker dies inside the write itself, after the manager checked its pid.
    if (r.state === 'running') {
      require('../crash.cjs').crash(m._worker(r.id).child);
      await P.waitPidGone(r.pid, { timeoutMs: 5000 });
    }
    return realWrite(r);
  };
  try {
    await assert.rejects(
      () => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'wl', startup_timeout_ms: 8000 }),
      (e) => {
        assert.equal(e.code, 'E_NO_READY', 'E_WORKER_NOT_LIVE is the core talking to the manager, not to the caller');
        assert.equal(typeof e.detail.stderr_tail, 'string');
        assert.match(e.detail.death_established_by, /core-refused-running/);
        return true;
      }
    );
    const states = core.rowsFor('wl').map((r) => r.state);
    assert.ok(!states.includes('running'));
    assert.equal(states[states.length - 1], 'dead');
  } finally {
    await m.shutdown();
    cleanup(sb);
  }
});

// ------------------------------------------------------- Claude Code: mcp_servers

test('an init whose mcp_servers lack belay connected is E_NO_READY naming what was seen', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE);
  process.env.FAKE_MCP = 'failed';
  try {
    await assert.rejects(
      () => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'wm', startup_timeout_ms: 8000 }),
      (e) => {
        assert.equal(e.code, 'E_NO_READY');
        assert.match(e.detail.reason, /mcp_servers/);
        assert.match(e.detail.reason, /"status":"failed"/, 'the reason names the status it saw: ' + e.detail.reason);
        assert.match(e.detail.reason, /connected/);
        return true;
      }
    );
    const states = core.rowsFor('wm').map((r) => r.state);
    assert.ok(!states.includes('running'), 'a worker whose MCP server did not connect is not running');
    assert.equal(states[states.length - 1], 'dead');
    assert.equal(P.pidAlive(core.currentWorker('wm').pid), false, 'the worker is killed, not left behind');
  } finally {
    delete process.env.FAKE_MCP;
    await m.shutdown();
    cleanup(sb);
  }
});

test('an init with no mcp_servers list at all is E_NO_READY, not a silent pass', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE);
  process.env.FAKE_MCP = 'absent';
  try {
    await assert.rejects(
      () => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'wa', startup_timeout_ms: 8000 }),
      (e) => {
        assert.equal(e.code, 'E_NO_READY');
        assert.match(e.detail.reason, /no mcp_servers list/);
        return true;
      }
    );
  } finally {
    delete process.env.FAKE_MCP;
    await m.shutdown();
    cleanup(sb);
  }
});

test('the ordinary fake, which reports belay connected, passes the same gate', async (tcx) => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE);
  tcx.after(() => Promise.resolve().then(() => m.shutdown()));
  const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'wok' });
  assert.equal(row.state, 'running');
  // ADR 0024, build step S2: the gate now also names the surface it verified (checkSurface's own
  // evidence), merged in beside mcp_servers.
  const ev = m._worker('wok').readyEvidence;
  assert.deepEqual(ev.mcp_servers, [{ name: 'belay', status: 'connected' }]);
  assert.match(ev.tools_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(ev.builtins, ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  assert.deepEqual(ev.belay_tools, ['mcp__belay__memory_store']);
  await m.shutdown();
  cleanup(sb);
});

// ------------------------------------------------------------- Codex: adapter.log

test('a Codex worker is ready only once its adapter log shows tools/list', async (tcx) => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE_CODEX);
  tcx.after(() => Promise.resolve().then(() => m.shutdown()));
  const row = await m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'do it', worker_id: 'cx', startup_timeout_ms: 8000 });
  assert.equal(row.state, 'running');
  assert.equal(row.substrate, 'codex');
  assert.match(row.session_id, /^fake-thread/);

  // The adapter really was launched with --log pointing beside the worker, and that file is the
  // evidence the gate used.
  const logPath = path.join(sb.data, 'workers', 'cx', 'adapter.log');
  assert.ok(fs.existsSync(logPath), 'the adapter log is written beside the worker');
  assert.match(fs.readFileSync(logPath, 'utf8'), /tools\/list/);
  const argv = JSON.parse(fs.readFileSync(path.join(sb.data, 'workers', 'cx', 'argv.json'), 'utf8'));
  const adapterArgs = JSON.parse(argv.spec.args.find((a) => a.startsWith('mcp_servers.belay.args=')).slice('mcp_servers.belay.args='.length));
  assert.deepEqual(adapterArgs.slice(-2), ['--log', fwd(logPath)]);
  assert.equal(m._worker('cx').readyEvidence.adapter_log, fwd(logPath));

  // One process per turn: it completes and settles idle, which is not a death.
  await m._waitTurn('cx', 8000);
  await m._waitExit('cx', 8000);
  await m._worker('cx').queue;
  assert.equal(core.currentWorker('cx').state, 'idle');
  await m.shutdown();
  cleanup(sb);
});

test('a Codex worker whose adapter never lists tools is E_NO_READY naming the log', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE_CODEX);
  process.env.FAKE_CODEX_NO_TOOLS_LIST = '1';
  process.env.FAKE_CODEX_HANG = '1';
  try {
    await assert.rejects(
      () => m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'do it', worker_id: 'cy', startup_timeout_ms: 1200 }),
      (e) => {
        assert.equal(e.code, 'E_NO_READY');
        assert.match(e.detail.reason, /tools\/list/);
        assert.match(e.detail.reason, /adapter\.log/);
        return true;
      }
    );
    const states = core.rowsFor('cy').map((r) => r.state);
    assert.ok(!states.includes('running'), 'no running row for a worker whose MCP server never answered');
    assert.equal(states[states.length - 1], 'dead');
    assert.equal(P.pidAlive(core.currentWorker('cy').pid), false, 'the hung worker is killed by its exact pid');
  } finally {
    delete process.env.FAKE_CODEX_NO_TOOLS_LIST;
    delete process.env.FAKE_CODEX_HANG;
    await m.shutdown();
    cleanup(sb);
  }
});

// ------------------------------------------------------------------- hygiene

test('an unreadable user settings file fails the launch with E_ARGS naming the file', async (tcx) => {
  const sb = sandbox();
  const core = createFakeCore();
  const broken = fwd(path.join(sb.root, 'broken-settings.json'));
  fs.writeFileSync(broken, '{ "enabledPlugins": { not json');
  const m = createRunManager({
    core, dataDir: sb.data, runId: 'run-ready', paths: { claudeExe: FAKE, userSettings: broken },
  });
  tcx.after(() => Promise.resolve().then(() => m.shutdown()));
  // ADR 0007 §6 never degrades quietly: a settings file that cannot be parsed names no plugins, and
  // a worker settings file that disables nothing is the hygiene rule silently not applying.
  await assert.rejects(
    () => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'wp' }),
    (e) => {
      assert.equal(e.code, 'E_ARGS');
      assert.ok(e.message.includes(broken), 'the message names the file: ' + e.message);
      assert.equal(e.detail.settings_path, broken);
      return true;
    }
  );
  assert.equal(core.calls.length, 0, 'nothing was written and nothing was launched');
  assert.equal((await m.list()).workers.filter((w) => w.pid).length, 0);

  // A file that simply does not exist names no plugin to disable and is not a failure.
  const m2 = createRunManager({
    core, dataDir: sb.data, runId: 'run-ready',
    paths: { claudeExe: FAKE, userSettings: fwd(path.join(sb.root, 'no-such-settings.json')) },
  });
  tcx.after(() => Promise.resolve().then(() => m2.shutdown()));
  const row = await m2.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'wq' });
  assert.equal(row.state, 'running');
  // ADR 0024, build step S2: writeFilesFor passes the worker's own cwd, so settings.json also carries
  // the hygiene block, computed the same way here.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.data, 'workers', 'wq', 'settings.json'), 'utf8')), {
    enabledPlugins: {}, ...require('../../src/run/surface.cjs').hygieneSettings(sb.worktree),
  });
  await m2.shutdown();
  await m.shutdown();
  cleanup(sb);
});
