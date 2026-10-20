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
