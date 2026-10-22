'use strict';
// control.test.cjs — build step 6c, item 7 first bullet.
// A real createRunManager over tests/run/fakes/fake-claude.cjs in this process, exactly as
// tests/run/manager.test.cjs builds one, with createWorkerControl over it. The client is
// src/core/client.cjs with `pipe` overriding the owner's own name.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createRunManager, createWorkerControl } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');
const { Client } = require('../../src/core/client.cjs');
const { adapterPipeName } = require('../../src/core/lock.cjs');
const P = require('../../src/run/process.cjs');
const PI = require('../../src/run/pid-identity.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const CALLER_OPERATOR = { role: 'operator', run_id: 'cli', pid: process.pid };

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-control-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}

function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-control-test',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

async function teardown({ client, control, m, sb }) {
  if (client) { try { await client.close(); } catch { /* best effort */ } }
  if (control) { try { await control.close(); } catch { /* best effort */ } }
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  if (sb) cleanup(sb.data);
}

test('worker control: the pipe is named by the data dir hash and the adapter pid, refuses a caller that is not operator, refuses a method it does not serve naming the five, and answers nothing once closed', async (tcx) => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  let control = null; let client = null;
  tcx.after(() => Promise.resolve().then(() => control && control.close()));
  try {
    control = createWorkerControl({ dataDir: sb.data, manager: m });
    await control.listen();
    assert.strictEqual(control.pipe, adapterPipeName(sb.data, process.pid));

    client = new Client(sb.data, { pipe: control.pipe, elect: false });
    await client.connect();

    await assert.rejects(
      client.call('worker.stop', { worker_id: 'x', mode: 'graceful', timeout_ms: 1000, caller: { role: 'orchestrator', run_id: 'r', pid: 1 } }),
      (e) => { assert.strictEqual(e.code, 'E_ROLE'); return true; },
    );
    await assert.rejects(
      client.call('worker.stop', { worker_id: 'x', mode: 'graceful', timeout_ms: 1000, caller: { role: 'worker', worker_id: 'w', run_id: 'r', pid: 1 } }),
      (e) => { assert.strictEqual(e.code, 'E_ROLE'); return true; },
    );

    await assert.rejects(
      client.call('ping', { caller: CALLER_OPERATOR }),
      (e) => {
        assert.strictEqual(e.code, 'E_NOT_FOUND');
        assert.deepStrictEqual(e.detail.methods, ['worker.message', 'worker.stop', 'worker.restart', 'worker.pause', 'worker.resume']);
        return true;
      },
    );
    await assert.rejects(
      client.call('run.stop', { caller: CALLER_OPERATOR }),
      (e) => {
        assert.strictEqual(e.code, 'E_NOT_FOUND');
        assert.deepStrictEqual(e.detail.methods, ['worker.message', 'worker.stop', 'worker.restart', 'worker.pause', 'worker.resume']);
        return true;
      },
    );

    await client.close();
    client = null;
    await control.close();
    const dead = new Client(sb.data, { pipe: control.pipe, elect: false, dialTimeoutMs: 500 });
    await assert.rejects(dead.connect());
    control = null;
  } finally { await teardown({ client, control, m, sb }); }
});

test('worker control: a stop over the pipe and the orchestrator\'s own stop of the same worker in flight together produce one receipt and at most one kill', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  let control = null; let client = null;
  process.env.FAKE_IGNORE_STDIN_END = '1';
  // doStop is counted where it acts, not by its rows: in this case (a live claude-code child, graceful mode) each
  // doStop closes stdin exactly once and, the close never landing, kills exactly once. A row count cannot tell:
  // the pid creation-time read (a process snapshot, slow on a loaded host) may land mid-stop and restate the
  // current state, a second `stopping` row from one doStop.
  const saved = { gracefulStop: P.gracefulStop, killWorker: PI.killWorker };
  let closes = 0; let kills = 0;
  P.gracefulStop = (...a) => { closes += 1; return saved.gracefulStop(...a); };
  PI.killWorker = (...a) => { kills += 1; return saved.killWorker(...a); };
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    control = createWorkerControl({ dataDir: sb.data, manager: m });
    await control.listen();
    client = new Client(sb.data, { pipe: control.pipe, elect: false });
    await client.connect();

    const [direct, viaPipe] = await Promise.all([
      m.stop({ worker_id: 'w1', mode: 'graceful', timeout_ms: 2000 }),
      client.call('worker.stop', { worker_id: 'w1', mode: 'graceful', timeout_ms: 2000, caller: CALLER_OPERATOR }),
    ]);
    assert.deepStrictEqual(direct, viaPipe, 'the two callers must share one receipt, not race to two');
    assert.strictEqual(direct.killed, true, 'FAKE_IGNORE_STDIN_END means the graceful close never lands, so the kill happened');

    assert.strictEqual(closes, 1, 'coalescing means doStop ran exactly once: one stdin close');
    assert.strictEqual(kills, 1, 'and one kill');
    const states = core.rowsFor('w1').map((r) => r.state);
    const entries = states.filter((st, i) => st === 'stopping' && states[i - 1] !== 'stopping');
    assert.strictEqual(entries.length, 1, `one move into stopping: ${states.join(', ')}`);
    assert.ok(!states.slice(states.indexOf('stopping')).includes('running'), `no running row over a stop in flight: ${states.join(', ')}`);
    assert.strictEqual(core.currentWorker('w1').state, 'stopped');
  } finally {
    P.gracefulStop = saved.gracefulStop; PI.killWorker = saved.killWorker;
    delete process.env.FAKE_IGNORE_STDIN_END;
    await teardown({ client, control, m, sb });
  }
});

// Fix round, blocking finding: the coalescing hole covered a worker this manager launched, but not
// one it only adopted — forWorker's own W.adopt was not coalesced, so two concurrent stops each built
// a separate `w` and each ran doStop. This plants a worker row this manager never spawned (a real
// hung process for its pid) and races a direct stop against a pipe stop, exactly the reviewer's own
// scratch scenario, now against the fix in forWorker.
test('worker control: two concurrent stops of a worker this manager never launched (adopted) share one receipt and at most one kill', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  let control = null; let client = null; let child = null;
  try {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    await core.worker.write({
      id: 'w-adopted', run_id: 'run-control-test', substrate: 'claude-code', pid: child.pid,
      state: 'running', worktree: sb.worktree, session_id: 'sess-adopted', turns: 0, started_at: Date.now(),
    });
    control = createWorkerControl({ dataDir: sb.data, manager: m });
    await control.listen();
    client = new Client(sb.data, { pipe: control.pipe, elect: false });
    await client.connect();

    const [direct, viaPipe] = await Promise.all([
      m.stop({ worker_id: 'w-adopted', mode: 'graceful', timeout_ms: 2000 }),
      client.call('worker.stop', { worker_id: 'w-adopted', mode: 'graceful', timeout_ms: 2000, caller: CALLER_OPERATOR }),
    ]);
    assert.deepStrictEqual(direct, viaPipe, 'the two callers of an adopted worker must share one receipt, not race to two');

    const stoppingRows = core.rowsFor('w-adopted').filter((r) => r.state === 'stopping');
    assert.strictEqual(stoppingRows.length, 1, 'coalescing must hold for a worker this manager only adopted');
  } finally {
    if (child && child.exitCode === null) { try { require('../crash.cjs').crash(child); } catch { /* best effort */ } }
    await teardown({ client, control, m, sb });
  }
});

test('worker control: worker.message over the pipe writes the worker\'s stdin and the fake answers the turn', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  let control = null; let client = null;
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    control = createWorkerControl({ dataDir: sb.data, manager: m });
    await control.listen();
    client = new Client(sb.data, { pipe: control.pipe, elect: false });
    await client.connect();

    const tp = m._waitTurn('w1', 8000); // registered before the message: a waiter only sees turns that end after it
    const r = await client.call('worker.message', { worker_id: 'w1', text: 'two', caller: CALLER_OPERATOR });
    assert.strictEqual(r.channel, 'stdin');
    assert.strictEqual(r.bytes, Buffer.byteLength('two', 'utf8'));
    assert.strictEqual(r.turn, 2);

    const turn = await tp;
    assert.ok(turn, 'the fake never answered the turn the message started');
  } finally { await teardown({ client, control, m, sb }); }
});

test('worker control: worker.restart over the pipe relaunches the worker with this process as its parent, the receipt is the manager\'s own, and the pipe still answers after', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  let control = null; let client = null;
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    control = createWorkerControl({ dataDir: sb.data, manager: m });
    await control.listen();
    client = new Client(sb.data, { pipe: control.pipe, elect: false });
    await client.connect();

    const r = await client.call('worker.restart', { worker_id: 'w1', first_turn_timeout_ms: 8000, caller: CALLER_OPERATOR });
    assert.strictEqual(r.old_pid, row.pid);
    assert.notStrictEqual(r.new_pid, r.old_pid);
    assert.strictEqual(P.pidAlive(r.new_pid), true);
    assert.strictEqual(r.branch, 'resume');

    const kids = await P.childPids(process.pid);
    assert.ok(kids.includes(r.new_pid), `the new pid ${r.new_pid} must be this process's own child: ${JSON.stringify(kids)}`);

    const stopReceipt = await client.call('worker.stop', { worker_id: 'w1', mode: 'kill', timeout_ms: 2000, caller: CALLER_OPERATOR });
    assert.strictEqual(stopReceipt.worker_id, 'w1');
    assert.strictEqual(stopReceipt.killed, true);
  } finally { await teardown({ client, control, m, sb }); }
});
