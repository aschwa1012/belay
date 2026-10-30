'use strict';
// orchestrator-leftovers.test.cjs — ADR 0054 amendment 2: what a headless orchestrator's shell left running is ended once the run's
// own close is done, by exact pid after its identity is checked again. The orchestrator's MCP adapter, the workers belay spawned
// (the spawn register) and their subtrees are belay's own and are never taken.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createLeftovers } = require('../../src/run/orchestrator-leftovers.cjs');
const SR = require('../../src/core/spawn-register.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');
const P = require('../../src/run/process.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const HELPER = path.join(__dirname, 'fakes', 'helper-sleeper.cjs');

// Waits on the real event: the helper has written its pid file.
async function pidFrom(file, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const n = Number(fs.readFileSync(file, 'utf8')); if (Number.isInteger(n) && n > 0) return n; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no pid in ${file}`);
}

const KNOBS = ['BELAY_CLAUDE_EXE', 'BELAY_SPAWN_REGISTRY', 'FAKE_ORPHAN_CHILD', 'FAKE_CHILD_PID_FILE', 'FAKE_ADAPTER_CHILD', 'FAKE_ADAPTER_PIDFILE', 'FAKE_WORKER_PIDFILE', 'FAKE_SIBLING_CHILD'];

test("at the close the shell's stray process is ended; the adapter, a spawned worker and their subtrees are not", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-leftovers-'));
  fs.mkdirSync(path.join(d, 'wt'));
  const dataDir = fwd(path.join(d, '.belay'));
  fs.mkdirSync(dataDir, { recursive: true });
  const f = (n) => path.join(d, n);
  const saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    BELAY_CLAUDE_EXE: FAKE, BELAY_SPAWN_REGISTRY: f('registry'),
    FAKE_ORPHAN_CHILD: '1', FAKE_CHILD_PID_FILE: f('stray.pid'), // the shell's own background process
    FAKE_ADAPTER_CHILD: '1', FAKE_ADAPTER_PIDFILE: f('adapter.pid'), FAKE_WORKER_PIDFILE: f('adapters-worker.pid'), // the adapter, and the worker it spawned
    FAKE_SIBLING_CHILD: f('registered.pid'), // a worker the spawn register names, outside the adapter's subtree
  });
  const kids = [];
  const other = spawn(process.execPath, [HELPER], { stdio: 'ignore', windowsHide: true, env: { ...process.env, FAKE_HELPER_PIDFILE: f('other.pid') } });
  try {
    const core = createFakeCore();
    core.worker = { ...core.worker, list: async () => ({ workers: [] }) };
    // The run row names the adapter the way the real one attaches: its pid and creation time, read when the close asks.
    core.run = { ...core.run, list: async () => {
      const pid = await pidFrom(f('adapter.pid'));
      const c = await P.createdOf(pid);
      return { runs: [{ id: 'run-leftovers', adapter_pid: pid, adapter_pid_created: c && c.created }] };
    } };
    // The register names the sibling once its pid is known, as the adapter's spawn would; reading the register is what the close does.
    const registerSibling = async () => { const pid = await pidFrom(f('registered.pid')); SR.register({ pid, kind: 'worker', dataDir, workerId: 'w-registered', created: (await P.createdOf(pid)).created }); };
    const listRuns = core.run.list;
    core.run.list = async () => { await registerSibling(); return listRuns(); };
    const result = await runOrchestrator({
      core, runId: 'run-leftovers', dataDir,
      spec: { worktree: fwd(path.join(d, 'wt')), promptText: 'hello', orchestratorDir: fwd(path.join(d, 'orch')), model: 'claude-sonnet-5', allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 0, mcpToolTimeoutMs: 60000, pollMs: 100, closeGraceMs: 3000 },
      onAttached: async () => ({ ok: true }),
    });
    const stray = await pidFrom(f('stray.pid'));
    const adapter = await pidFrom(f('adapter.pid'));
    const adaptersWorker = await pidFrom(f('adapters-worker.pid'));
    const registered = await pidFrom(f('registered.pid'));
    kids.push(stray, adapter, adaptersWorker, registered);
    assert.strictEqual(P.pidAlive(stray), true, "nothing is ended before the run's own close is done");
    assert.strictEqual(typeof result.endLeftovers, 'function');
    assert.strictEqual(Object.keys(result).includes('endLeftovers'), false, 'and the function is not part of the receipt');

    const l = await result.endLeftovers();
    assert.ok(l.found.includes(stray) && l.killed.includes(stray), "the shell's process is found and ended by its pid: " + JSON.stringify(l));
    for (const [name, pid] of [['the adapter', adapter], ["the adapter's worker", adaptersWorker], ['the registered worker', registered], ['an unrelated process', other.pid]]) {
      assert.ok(!l.found.includes(pid), `${name} is not taken`);
      assert.strictEqual(P.pidAlive(pid), true, `${name} is still running`);
    }
    assert.strictEqual(P.pidAlive(stray), false);
  } finally {
    for (const k of KNOBS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    for (const pid of [...kids, other.pid]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    cleanup(d);
  }
});

test('a captured descendant whose pid now belongs to another process (a different creation time) is counted gone and left running', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-leftovers-'));
  const pidFile = path.join(d, 'p.pid');
  const stranger = spawn(process.execPath, [HELPER], { stdio: 'ignore', windowsHide: true, env: { ...process.env, FAKE_HELPER_PIDFILE: pidFile } });
  try {
    await pidFrom(pidFile);
    const real = await P.createdOf(stranger.pid);
    assert.ok(real && real.created != null, "the stranger's creation time is readable");
    // The capture sees the stranger as a child of the orchestrator with an earlier creation time than it really has: the pid was reused.
    const snap = new Map([[process.pid, { created: 1, ppid: null }], [stranger.pid, { created: real.created - 60000, ppid: process.pid, image: real.image }]]);
    snap.get(stranger.pid).created = Math.max(2, real.created - 60000);
    const fakeP = { snapshotShared: async () => ({ snap }), killMany: (t) => P.killMany(t) };
    const l = createLeftovers({ child: { pid: process.pid, exitCode: null, signalCode: null }, P: fakeP, state: {}, owned: async () => ({ adapterKnown: true, list: [] }) });
    await l.capture();
    const r = await l.end();
    assert.deepStrictEqual(r.found, [stranger.pid]);
    assert.deepStrictEqual(r.killed, []);
    assert.deepStrictEqual(r.gone, [stranger.pid], 'the meant process is provably not there');
    assert.deepStrictEqual(r.refused, [], 'so it is not a refusal, and the run is not failed for it');
    assert.strictEqual(P.pidAlive(stranger.pid), true, 'the process that took the pid is untouched');
  } finally { try { process.kill(stranger.pid, 'SIGKILL'); } catch { /* gone */ } cleanup(d); }
});

test('with no adapter named in the run row, or the owned processes unreadable, nothing is taken and the receipt says why', async () => {
  const child = { pid: process.pid, exitCode: null, signalCode: null };
  const snap = new Map([[process.pid, { created: 5, ppid: null }], [900001, { created: 6, ppid: process.pid, image: 'node.exe' }]]);
  const killed = [];
  const fakeP = { snapshotShared: async () => ({ snap }), killMany: async (t) => { killed.push(...t); return []; } };
  const l = createLeftovers({ child, P: fakeP, state: {}, owned: async () => ({ adapterKnown: false, list: [] }) });
  await l.capture();
  const r = await l.end();
  assert.deepStrictEqual(r.found, []);
  assert.match(r.not_taken, /names no adapter/);
  const l2 = createLeftovers({ child, P: fakeP, state: {}, owned: async () => { throw new Error('boom'); } });
  await l2.capture();
  assert.match((await l2.end()).not_taken, /could not be read: boom/);
  assert.deepStrictEqual(killed, []);
});

test('a captured stray that exited (absent) or whose pid was reused (mismatch) is gone; only an unverifiable identity is a refusal', async () => {
  const child = { pid: process.pid, exitCode: null, signalCode: null };
  const snap = new Map([[process.pid, { created: 5, ppid: null }], [900001, { created: 6, ppid: process.pid }], [900002, { created: 6, ppid: process.pid }], [900003, { created: 6, ppid: process.pid }], [900004, { created: 6, ppid: process.pid }]]);
  const fakeP = { snapshotShared: async () => ({ snap }), killMany: async () => [
    { pid: 900001, killed: false, gone: true },
    { pid: 900002, killed: false, refused: 'identity', kind: 'absent', detail: 'not in the snapshot' },
    { pid: 900003, killed: false, refused: 'identity', kind: 'mismatch', detail: 'a different process holds the pid' },
    { pid: 900004, killed: false, refused: 'identity', kind: 'unverifiable', detail: 'snapshot unreadable' },
  ] };
  const l = createLeftovers({ child, P: fakeP, state: {}, owned: async () => ({ adapterKnown: true, list: [] }) });
  await l.capture();
  const r = await l.end();
  assert.deepStrictEqual([...r.gone].sort(), [900001, 900002, 900003]);
  assert.deepStrictEqual(r.refused.map((x) => x.pid), [900004]);
  assert.deepStrictEqual(r.killed, []);
});
