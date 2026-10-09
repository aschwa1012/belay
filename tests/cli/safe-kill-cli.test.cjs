'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// safe-kill-cli.test.cjs — ADR 0039 decision 4 at the two CLI kill sites: `belay run`'s worker close
// (src/cli/run-close.cjs) and `belay worker kill` (src/cli/cmd-worker.cjs). A different live process (a
// sleeper this test spawned) holds the pid a worker row names, with a creation time that is not its own. The
// kill must refuse, say so in the receipt, and the sleeper must survive.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const P = require('../../src/core/process.cjs');
const { sandbox, cleanup } = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { closeRunWorkers } = require('../../src/cli/run-close.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
const running = (c) => c.exitCode === null && c.signalCode === null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('run close: a worker row whose pid another process holds is refused by identity and left running, and the block names it', async () => {
  const s = sleeper();
  try {
    const row = { id: 'w1', run_id: 'r1', substrate: 'claude-code', state: 'running', pid: s.pid, pid_created: 1 };
    const core = { run: { get: async () => ({ run: { adapter_pid: process.pid } }) }, worker: { list: async () => ({ workers: [row] }) } };
    const out = await closeRunWorkers({ core, runId: 'r1', graceMs: 100 });
    assert.strictEqual(out.killed.length, 1);
    assert.strictEqual(out.killed[0].refused, 'identity', JSON.stringify(out.killed));
    assert.strictEqual(out.killed[0].signalled, false);
    assert.strictEqual(out.killed[0].gone, false);
    assert.deepStrictEqual(out.still_alive, [{ worker_id: 'w1', pid: s.pid }]);
    await sleep(200);
    assert.strictEqual(running(s), true, 'the bystander must still be running');
  } finally { s.kill(); }
});

test('worker kill: a row whose pid another process holds is refused with the reason, writes nothing, and the bystander survives', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const s = sleeper();
  try {
    const plant = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-a', pid: process.pid } });
    try {
      await plant.worker.write({ id: 'w1', substrate: 'claude-code', pid: s.pid, pid_created: 1, state: 'running', turns: 0, started_at: Date.now() });
    } finally { await plant.shutdownOwner(); await plant.close(); }
    const r = spawnSync(process.execPath, [CLI, 'worker', 'kill', 'w1', '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    const receipt = JSON.parse(r.stdout || r.stderr);
    assert.strictEqual(receipt.killed, false, JSON.stringify(receipt).slice(0, 600));
    assert.strictEqual(receipt.refused, 'identity');
    assert.match(receipt.reason, /could not be shown to be this worker's process/);
    assert.strictEqual(receipt.pid_kill.signalled, false);
    assert.strictEqual(receipt.pid_alive_after, true, 'the receipt must say the process is still there');
    assert.strictEqual(running(s), true);
  } finally { s.kill(); await sleep(100); cleanup(dir); }
});

test('worker kill: the same row with the pid\'s true creation time is killed, with the identity in the receipt', async (t) => {
  if (process.platform !== 'win32') return t.skip('the CIM snapshot is Windows only');
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const s = sleeper();
  try {
    const made = await P.createdOf(s.pid);
    const plant = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-a', pid: process.pid } });
    try {
      await plant.worker.write({ id: 'w1', substrate: 'claude-code', pid: s.pid, pid_created: made.created, pid_image: 'node.exe', state: 'running', turns: 0, started_at: Date.now() });
    } finally { await plant.shutdownOwner(); await plant.close(); }
    const r = spawnSync(process.execPath, [CLI, 'worker', 'kill', 'w1', '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    const receipt = JSON.parse(r.stdout || r.stderr);
    assert.strictEqual(receipt.killed, true, JSON.stringify(receipt).slice(0, 600));
    assert.strictEqual(receipt.identity.via, 'created');
    assert.strictEqual(receipt.identity.created, made.created);
    await new Promise((res) => (s.exitCode !== null ? res() : s.once('exit', res)));
  } finally { if (running(s)) s.kill(); cleanup(dir); }
});
