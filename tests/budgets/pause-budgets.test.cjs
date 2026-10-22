'use strict';
// pause-budgets.test.cjs — build step 6e, item 9, the shape
// of tests/budgets/permission-budgets.test.cjs. `pause x` and `resume x` against a data dir that does
// not exist and a dead store, each under 500 ms above the host's own spawn floor, interleaved.

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

function sandbox() { return fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pause-budgets-')).split(path.sep).join('/'); }

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
  const commands = {};
  for (const [name, r] of Object.entries(result.commands)) commands[name] = { min: r.min, median: r.median, over_floor_ms: r.over_floor_ms };
  console.log(JSON.stringify({ floor: { min: result.floor.min, median: result.floor.median }, commands }));
  const misses = Object.entries(result.commands).filter(([, r]) => r.over_floor_ms >= SPAWN_OVER_FLOOR_MS);
  assert.ok(misses.length === 0, misses.map(([name, r]) =>
    `${name} min ${r.min} ms (median ${r.median} ms) is ${r.over_floor_ms} ms above the host floor `
    + `(min ${result.floor.min} ms, median ${result.floor.median} ms); samples ${r.samples.join(', ')}`,
  ).join(' | '));
}

test('budgets: pause and resume against a data dir that does not exist each add under 500 ms to the host floor, interleaved', () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay-cold`; // never created: both refuse before opening a core
  try {
    const result = interleaved({
      spawnFloor: makeSpawnFloor(),
      commands: {
        pause_no_dir: () => timedCli(['pause', 'x', '--data', dataDir, '--json'], 1, dataDir),
        resume_no_dir: () => timedCli(['resume', 'x', '--data', dataDir, '--json'], 1, dataDir),
      },
      n: N,
    });
    assertGate(result);
  } finally { cleanup(dir); }
});

test('budgets: pause and resume against a dead store with no such worker each add under 500 ms to the host floor, interleaved', async (tcx) => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const plantCore = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-pause-budgets', pid: process.pid }, embed: false });
  tcx.after(() => Promise.resolve().then(() => plantCore.shutdownOwner()).catch(() => {}));
  tcx.after(() => Promise.resolve().then(() => plantCore.close()).catch(() => {}));
  await plantCore.run.attach({ adapter_pid: process.pid });
  await plantCore.shutdownOwner();
  await plantCore.close();
  try {
    const result = interleaved({
      spawnFloor: makeSpawnFloor(),
      commands: {
        pause_dead_store: () => timedCli(['pause', 'x', '--data', dataDir, '--json'], 1, dataDir),
        resume_dead_store: () => timedCli(['resume', 'x', '--data', dataDir, '--json'], 1, dataDir),
      },
      n: N,
    });
    assertGate(result);
  } finally { cleanup(dir); }
});
