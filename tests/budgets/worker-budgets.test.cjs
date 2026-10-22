'use strict';
// worker-budgets.test.cjs — build step 6b, design item 4,
// the shape of tests/budgets/cli-budgets.test.cjs's groups. `worker kill` and `worker rm` against a data
// dir that does not exist, and `worker kill` against a dead store with no such worker, each interleaved
// (tests/cli/budget.cjs's `interleaved`) against the host's own spawn floor. `worker rm` against a real
// store is a write (mode W) and is not gated.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { emptyScript, interleaved, SPAWN_OVER_FLOOR_MS } = require('../cli/budget.cjs');
const { listRecursive } = require('../cli/stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const N = 7;

function sandbox() { return fs.mkdtempSync(path.join(os.tmpdir(), 'belay-worker-budgets-')).split(path.sep).join('/'); }

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
}

function spawnCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 20000 });
}

function timedCli(args, expectCode, listingDir) {
  const beforeListing = listingDir ? listRecursive(listingDir) : null;
  const t0 = Date.now();
  const r = spawnCli(args);
  const ms = Date.now() - t0;
  assert.strictEqual(r.status, expectCode, `${args.join(' ')} exited ${r.status}, expected ${expectCode}: ${r.stderr}`);
  if (listingDir) {
    assert.deepStrictEqual(listRecursive(listingDir), beforeListing, `${args.join(' ')} changed the data dir listing`);
  }
  return ms;
}

function makeSpawnFloor() {
  const script = emptyScript();
  return () => {
    const t0 = Date.now();
    spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return Date.now() - t0;
  };
}

function assertGate(result) {
  // One JSON line per gate, so the deltas are a receipt in the run's own stdout, not a claim.
  const commands = {};
  for (const [name, r] of Object.entries(result.commands)) commands[name] = { min: r.min, median: r.median, over_floor_ms: r.over_floor_ms };
  console.log(JSON.stringify({ floor: { min: result.floor.min, median: result.floor.median }, commands }));
  const misses = Object.entries(result.commands).filter(([, r]) => r.over_floor_ms >= SPAWN_OVER_FLOOR_MS);
  assert.ok(misses.length === 0, misses.map(([name, r]) =>
    `${name} min ${r.min} ms (median ${r.median} ms) is ${r.over_floor_ms} ms above the host floor `
    + `(min ${result.floor.min} ms, median ${result.floor.median} ms); samples ${r.samples.join(', ')}`,
  ).join(' | '));
}

test('budgets: worker kill, worker rm, worker stop, worker restart and message each add under 500 ms to the host floor against a data dir that does not exist, interleaved', () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay-cold`; // never created: every verb refuses before opening a core
  try {
    const result = interleaved({
      spawnFloor: makeSpawnFloor(),
      commands: {
        worker_kill_no_dir: () => timedCli(['worker', 'kill', 'x', '--data', dataDir, '--json'], 1, dataDir),
        worker_rm_no_dir: () => timedCli(['worker', 'rm', 'x', '--data', dataDir, '--json'], 1, dataDir),
        // build step 6c, design item 3, brief "Done" item 3: stop, restart and message are refusals
        // on a read rung (the data dir stat) here, so the budget binds them too, unlike their success
        // paths over the adapter's pipe, which invariant 9 does not bind.
        worker_stop_no_dir: () => timedCli(['worker', 'stop', 'x', '--data', dataDir, '--json'], 1, dataDir),
        worker_restart_no_dir: () => timedCli(['worker', 'restart', 'x', '--data', dataDir, '--json'], 1, dataDir),
        message_no_dir: () => timedCli(['message', 'x', 'hi', '--data', dataDir, '--json'], 1, dataDir),
      },
      n: N,
    });
    assertGate(result);
  } finally { cleanup(dir); }
});

test('budgets: worker kill, worker stop, worker restart and message against a dead store with no such worker each add under 500 ms to the host floor, interleaved', async (tcx) => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  // A real store, no live owner: run.attach then shutdownOwner leaves memory.db on disk with no
  // owner.lock, the "dead store" this codebase's other budget groups plant the same way.
  const plantCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-budgets', pid: process.pid }, embed: false });
  tcx.after(() => Promise.resolve().then(() => plantCore.shutdownOwner()));
  tcx.after(() => Promise.resolve().then(() => plantCore.close()));
  await plantCore.run.attach({ adapter_pid: process.pid });
  await plantCore.shutdownOwner();
  await plantCore.close();
  try {
    const result = interleaved({
      spawnFloor: makeSpawnFloor(),
      commands: {
        worker_kill_dead_store: () => timedCli(['worker', 'kill', 'no-such-worker', '--data', dataDir, '--json'], 1, dataDir),
        // stop, restart and message all refuse at the ladder's own rung 1 (worker.get, E_NOT_FOUND)
        // before ever reaching the adapter's pipe, the same read-rung shape as worker kill above.
        worker_stop_dead_store: () => timedCli(['worker', 'stop', 'no-such-worker', '--data', dataDir, '--json'], 1, dataDir),
        worker_restart_dead_store: () => timedCli(['worker', 'restart', 'no-such-worker', '--data', dataDir, '--json'], 1, dataDir),
        message_dead_store: () => timedCli(['message', 'no-such-worker', 'hi', '--data', dataDir, '--json'], 1, dataDir),
      },
      n: N,
    });
    assertGate(result);
  } finally { cleanup(dir); }
});
