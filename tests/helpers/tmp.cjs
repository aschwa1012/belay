'use strict';
// tests/helpers/tmp.cjs — loaded into every test-file process by scripts/test.cjs (`node --test --require`).
// Every directory a test makes with fs.mkdtemp* under the OS temp dir is recorded and removed when the
// process exits, on pass, fail and throw alike. A store owner or worker a test left holding files is given a
// single removal attempt at exit; a directory still held (by a child that outlived its test) is left in place,
// so the suite-level guard reports it, and nothing is killed or waited on to make a removal succeed. The suite-level guard in scripts/test.cjs
// reports whatever still remains. Idempotent when required twice.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A belay worker that runs `npm test` carries BELAY_WORKER_ID (src/run/env.cjs), and the CLI refuses its write verbs under it.
// The suite's own CLI children must act as the operator, so the marker does not pass into them. A test of the guard sets it itself.
delete process.env.BELAY_WORKER_ID;

const KEY = Symbol.for('belay.tests.tmp');
if (!globalThis[KEY]) {
  const made = new Set();
  const root = path.resolve(os.tmpdir()).toLowerCase();
  const record = (p) => {
    try {
      const abs = path.resolve(String(p));
      if (path.dirname(abs).toLowerCase() === root) made.add(abs);
    } catch { /* not a path */ }
    return p;
  };
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } };

  const origSync = fs.mkdtempSync;
  fs.mkdtempSync = function mkdtempSync(...a) { return record(origSync.apply(this, a)); };
  const origCb = fs.mkdtemp;
  fs.mkdtemp = function mkdtemp(...a) {
    const cb = a[a.length - 1];
    if (typeof cb === 'function') a[a.length - 1] = (err, p) => { if (!err) record(p); cb(err, p); };
    return origCb.apply(this, a);
  };
  const origP = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function mkdtemp(...a) { return record(await origP.apply(this, a)); };

  // The machine-wide spawn register (src/core/spawn-register.cjs) is this process's own for the run of the tests: a worker one test
  // starts is never taken for the ancestor of another test's operator, and nothing is left in the real register.
  // `node --test --require` loads this helper in the runner too, and every test file's process inherits the runner's variable, so a bare
  // "only if unset" gave all concurrent files one register: a fake orchestrator one file registers covers the invented process roots of
  // another file's operator check. The helper marks the register it made with its own pid and path; a process that inherits that pair
  // from another process makes a register of its own, and an explicit value (a test's or the operator's) is kept.
  const madeBy = (process.env.BELAY_TEST_SPAWN_REGISTRY_MADE_BY || '').split('|');
  const inherited = !!madeBy[1] && madeBy[1] === process.env.BELAY_SPAWN_REGISTRY && madeBy[0] !== String(process.pid);
  if (!process.env.BELAY_SPAWN_REGISTRY || inherited) {
    process.env.BELAY_SPAWN_REGISTRY = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawned-test-'));
    process.env.BELAY_TEST_SPAWN_REGISTRY_MADE_BY = `${process.pid}|${process.env.BELAY_SPAWN_REGISTRY}`;
  }

  // One attempt per directory when budgetMs is 0; otherwise retried within the budget. Returns what remains.
  function cleanup(budgetMs = 3000) {
    const deadline = Date.now() + budgetMs;
    let left = [...made];
    for (let wait = 25; left.length; wait = Math.min(wait * 2, 400)) {
      left = left.filter((p) => {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* busy: retry */ }
        return fs.existsSync(p);
      });
      if (!left.length || Date.now() >= deadline) break;
      sleep(wait);
    }
    made.clear();
    return left;
  }
  process.on('exit', () => { try { cleanup(0); } catch { /* exiting */ } });
  globalThis[KEY] = { cleanup, made };
}
module.exports = globalThis[KEY];
