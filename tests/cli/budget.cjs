'use strict';
// budget.cjs — the one floor helper ADR 0018 amendment 1 asks for. `interleaved` is the one gate
// primitive this suite uses: every spawned-process budget in tests/budgets/cli-budgets.test.cjs
// compares a command's own timing against an empty script spawned the same way, sample for sample in
// the same round, never as two serial blocks (amendment 1's fix for the delta a serial floor could
// not hold under `npm test`'s own load). No assertion lives here — the caller keeps its own listing
// brackets and exit-code checks around each sample, exactly as `interleaved`'s own doc comment asks.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let emptyScriptPath = null;

// Writes an empty .cjs under the OS temp dir once per process; removed on exit.
function emptyScript() {
  if (emptyScriptPath) return emptyScriptPath;
  const p = `${os.tmpdir().split(path.sep).join('/')}/belay-cli-floor-${process.pid}.cjs`;
  fs.writeFileSync(p, '', 'utf8');
  process.on('exit', () => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } });
  emptyScriptPath = p;
  return p;
}

function medianOf(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ADR 0018 amendment 1: the floor and the commands it gates must share one load window, sample for
// sample, not two serial blocks. `spawnFloor()` performs one spawn of the empty script (built by the
// caller from its own spawnSync options, so the subtraction is of byte-identical spawns except the
// script argument) and returns its elapsed ms; `commands` is `{ [name]: fn }` where `fn(i)` performs
// one spawn of that command and returns its elapsed ms — the caller keeps its own listing bracket and
// exit-code assertion inside `fn`. Round `i` calls `spawnFloor()` first, then every command's `fn(i)`
// in the order given.
function interleaved({ spawnFloor, commands, n = 7 }) {
  const names = Object.keys(commands);
  const floorSamples = [];
  const commandSamples = {};
  for (const name of names) commandSamples[name] = [];
  for (let i = 0; i < n; i += 1) {
    floorSamples.push(spawnFloor());
    for (const name of names) commandSamples[name].push(commands[name](i));
  }
  const floor = { min: Math.min(...floorSamples), median: medianOf(floorSamples), samples: floorSamples };
  const result = {};
  for (const name of names) {
    const samples = commandSamples[name];
    const min = Math.min(...samples);
    result[name] = { min, median: medianOf(samples), samples, over_floor_ms: min - floor.min };
  }
  return { floor, commands: result };
}

// ADR 0035: what a spawned command may add above the host floor (was 100 ms, ADR 0018).
const SPAWN_OVER_FLOOR_MS = 500;

module.exports = { emptyScript, interleaved, SPAWN_OVER_FLOOR_MS };
