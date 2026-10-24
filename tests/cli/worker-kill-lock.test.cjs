'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// worker-kill-lock.test.cjs — `belay worker kill` takes the kill lock (src/core/process.cjs withKillLock) around its kill, as every
// other kill site does. In process: the lock and the kill are wrapped by spies, the row's pid is a sleeper this test spawned with a
// creation time that is not its own, so the kill is refused by identity and the sleeper survives; it is stopped by its own handle.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const P = require('../../src/core/process.cjs');
const { sandbox, cleanup } = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const W = require('../../src/cli/cmd-worker.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('worker kill calls killProcess inside the kill lock', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const s = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  const orig = { lock: P.withKillLock, kill: P.killProcess };
  let inside = false;
  const seen = [];
  try {
    const plant = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-a', pid: process.pid } });
    try {
      await plant.worker.write({ id: 'w1', substrate: 'claude-code', pid: s.pid, pid_created: 1, state: 'running', turns: 0, started_at: Date.now() });
    } finally { await plant.shutdownOwner(); await plant.close(); }
    P.withKillLock = (fn) => orig.lock(async () => { inside = true; try { return await fn(); } finally { inside = false; } });
    P.killProcess = (...a) => { seen.push(inside); return orig.kill(...a); };
    const r = await W.run({ argv: ['kill', 'w1'], cwd: dir, dataDir, dataDirGiven: true, json: true, command: 'worker' });
    assert.deepStrictEqual(seen, [true], 'killProcess ran once, inside the lock');
    assert.strictEqual(r.json.refused, 'identity', JSON.stringify(r.json).slice(0, 400));
    assert.strictEqual(s.exitCode === null && s.signalCode === null, true, 'the bystander survives');
  } finally {
    P.withKillLock = orig.lock; P.killProcess = orig.kill;
    s.kill(); await sleep(100); cleanup(dir);
  }
});
