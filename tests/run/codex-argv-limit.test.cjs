'use strict';
// codex-argv-limit.test.cjs — a Codex worker's message is in argv, and Windows caps a command line at 32,767 characters. Node THROWS
// (it does not emit an error event) when libuv cannot start the process for that reason. Before the fix the spawn then left its
// `starting` row with no pid and the task leased to a worker that never existed. Now: an oversized command line is refused up front with
// E_ARGS naming the limit, and any synchronous spawn throw writes the first launch's row `dead`, which releases the lease.
// Uses the fake Codex from tests/run/fakes; no real Codex, no sleeps.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const P = require('../../src/run/process.cjs');
const AL = require('../../src/run/argv-limit.cjs');

const FAKE_CODEX = require('node:path').resolve(__dirname, 'fakes/fake-codex.cjs').replace(/\\/g, '/');
const USER_SETTINGS = require('node:path').resolve(__dirname, 'fixtures/user-settings.json').replace(/\\/g, '/');
const RUN = 'argv-limit-run';

test('checkCommandLine refuses a command line over the Windows limit and names it', () => {
  const big = ['exec', '--', 'x'.repeat(40000)];
  assert.throws(() => AL.checkCommandLine('codex', big, { workerId: 'c1', windows: true }), (e) => {
    assert.strictEqual(e.code, 'E_ARGS');
    assert.strictEqual(e.detail.reason, 'argv_too_long');
    assert.strictEqual(e.detail.limit, 32767);
    assert.match(e.message, /32767/);
    assert.match(e.message, /no process was started/);
    assert.match(e.message, /spawn again with a new worker id/);
    assert.match(e.message, /about \d+ characters by belay's conservative count, over belay's cap of 32000 \(Windows allows 32767\)/);
    assert.strictEqual(e.detail.belay_cap, 32000);
    assert.strictEqual(e.detail.path, 'spawn');
    return true;
  });
  // the advice follows the path that built the line
  assert.throws(() => AL.checkCommandLine('codex', big, { workerId: 'c1', windows: true, path: 'message' }), (e) => /shorten the message/.test(e.message) && !/spawn again/.test(e.message));
  assert.throws(() => AL.checkCommandLine('codex', big, { workerId: 'c1', windows: true, path: 'restart' }), (e) => /still running/.test(e.message) && e.detail.path === 'restart');
  AL.checkCommandLine('codex', ['exec', '--', 'x'.repeat(1000)], { windows: true }); // short: fine
  AL.checkCommandLine('codex', big, { windows: false }); // the limit is Windows'
  // a quote or backslash is escaped on the command line, so it counts twice
  assert.ok(AL.commandLineLength('c', ['\\\\']) > AL.commandLineLength('c', ['ab']));
});

async function withRun(fn, { wrapCore = (c) => c } = {}) {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const wt = `${dir}/wt`; fs.mkdirSync(wt, { recursive: true });
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    m = createRunManager({ core: wrapCore(core.harness()), dataDir: dir, runId: RUN, paths: { claudeExe: FAKE_CODEX, codexExe: FAKE_CODEX, userSettings: USER_SETTINGS } });
    await fn({ core, m, wt });
  } finally {
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
}

async function assertClean(core, taskId, workerId) {
  const w = await core.worker.get({ worker_id: workerId });
  assert.strictEqual(w.state, 'dead', 'the starting row is written dead: no process exists');
  const t = await core.task.get({ task_id: taskId });
  assert.notStrictEqual(t.lease && t.lease.holder, workerId, 'the dead worker does not keep the lease');
  assert.strictEqual(t.state, 'open', 'the task goes back to open');
}

test('a Codex spawn whose spec is 40,000 characters is refused with E_ARGS and leaves no starting row or lease', { skip: process.platform !== 'win32' }, async () => {
  await withRun(async ({ core, m, wt }) => {
    const task = await core.task.create({ spec: 'x'.repeat(40000), files_owned: ['src/a.js'] });
    await assert.rejects(m.spawn({ substrate: 'codex', worktree: wt, worker_id: 'c1', task_id: task.id }), (e) => {
      assert.strictEqual(e.code, 'E_ARGS');
      assert.strictEqual(e.detail.reason, 'argv_too_long');
      assert.match(e.message, /32767/);
      return true;
    });
    await assertClean(core, task.id, 'c1');
  });
});

test('a synchronous spawn throw (E2BIG) writes the first launch dead and releases the lease', async () => {
  await withRun(async ({ core, m, wt }) => {
    const task = await core.task.create({ spec: 'small spec', files_owned: ['src/a.js'] });
    const orig = P.spawnWorker;
    P.spawnWorker = (o) => { if (o.args.includes('exec')) throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG', errno: -7, syscall: 'spawn' }); return orig(o); };
    try {
      await assert.rejects(m.spawn({ substrate: 'codex', worktree: wt, worker_id: 'c1', task_id: task.id }), (e) => e.code === 'E2BIG' && e.detail.reason === 'spawn_throw');
    } finally { P.spawnWorker = orig; }
    await assertClean(core, task.id, 'c1');
  });
});

// A restart stops the old process, then builds its text from the worker's final state. Belay's own text here (the resume line, read from
// the core) is oversized, so the relaunch is refused after the stop with advice that says so, not the "still running" advice of a
// refusal before the stop. (A caller's appended message, checked before any stop, comes only from a resume, and Codex has no pause.)
test('a restart whose own relaunch text is oversized is refused with advice that the old process was stopped', { skip: process.platform !== 'win32' }, async () => {
  const big = { on: false }; // the spawn's own text must stay small; the stub grows only for the restart
  const wrapCore = (h) => Object.create(h, { continuity: { value: { ...h.continuity, resumeLine: async (a) => (big.on ? { text: 'y'.repeat(40000) } : h.continuity.resumeLine(a)) } } }); // h's continuity is frozen, so a Proxy may not replace it; a child object can
  const gate = `${sandbox()}/codex-turn.gate`; // never written: the fake's turn stays open, so the process is alive for the whole test
  process.env.FAKE_CODEX_GATE_FILE = gate;
  try {
    await withRun(async ({ core, m, wt }) => {
      // a task, so the resume branch (a fresh worker's usual one) reads the resume line; without one only the replace branch does
      const task = await core.task.create({ spec: 'small spec', files_owned: ['src/a.js'] });
      await m.spawn({ substrate: 'codex', worktree: wt, worker_id: 'c1', task_id: task.id });
      const pid = (await core.worker.get({ worker_id: 'c1' })).pid;
      assert.ok(pid && P.pidAlive(pid), 'the worker runs before the restart');
      big.on = true;
      await assert.rejects(m.restart({ worker_id: 'c1', first_turn_timeout_ms: 5000 }), (e) => {
        assert.strictEqual(e.code, 'E_ARGS');
        assert.strictEqual(e.detail.reason, 'argv_too_long');
        assert.strictEqual(e.detail.path, 'restart-stopped');
        assert.match(e.message, /about \d+ characters/);
        assert.match(e.message, /already stopped/);
        assert.doesNotMatch(e.message, /still running/);
        return true;
      });
      assert.ok(!P.pidAlive(pid), 'the old process was stopped before the text was built');
      assert.strictEqual((await core.worker.get({ worker_id: 'c1' })).state, 'stopped', 'the graceful stop wrote the row stopped');
    }, { wrapCore });
  } finally { delete process.env.FAKE_CODEX_GATE_FILE; }
});

test('the advice for a relaunch refused after the stop is distinct from the one before it', () => {
  const big = ['exec', '--', 'x'.repeat(40000)];
  assert.throws(() => AL.checkCommandLine('codex', big, { workerId: 'c1', windows: true, path: 'restart-stopped' }), (e) => /already stopped/.test(e.message) && !/still running/.test(e.message));
});
