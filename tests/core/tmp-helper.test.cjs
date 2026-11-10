'use strict';
require('../helpers/tmp.cjs'); // a plain `node --test` of this file keeps its temp dirs out of the real temp dir
// tests/helpers/tmp.cjs leaves a directory a surviving child still holds, does not stall the exit waiting for
// it, and scripts/test.cjs's guard names it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { leaked, snapshotResidue } = require('../../scripts/test.cjs');

const HELPER = path.join(__dirname, '..', 'helpers', 'tmp.cjs');

test('tmp helper: a directory held by a surviving child is left for the guard, and exit does not stall', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-tmphelper-'));
  const script = path.join(scratch, 'driver.cjs');
  fs.writeFileSync(script, [
    "const fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');",
    "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-held-'));",
    "const c = spawn(process.execPath, ['-e', \"require('fs').writeFileSync('ready', '1'); setTimeout(() => {}, 20000)\"], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });",
    "c.unref();",
    "const t0 = Date.now(); while (!fs.existsSync(path.join(dir, 'ready')) && Date.now() - t0 < 10000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);",
    "console.log(c.pid + ' ' + Date.now());",
  ].join('\n'));
  const tmp = path.join(scratch, 'tmp');
  fs.mkdirSync(tmp);
  let pid = null, created = null;
  try {
    const r = spawnSync(process.execPath, ['--require', HELPER, script], { encoding: 'utf8', env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, BELAY_TEST_TMP_ISOLATE: '0' } });
    const doneAt = Date.now();
    const [pidText, mainDoneAt] = r.stdout.trim().split(' ');
    pid = Number(pidText);
    assert.ok(Number.isInteger(pid) && pid > 0, r.stdout + r.stderr);
    // The child outlives the driver that started it (it holds for 20 s): its creation time, read now, is what the finally ends it by.
    const seen = (require('../../src/core/proc-identity.cjs').processSnapshotSync() || new Map()).get(pid);
    created = seen ? seen.created : null;
    // Measured from the moment the driver's main was done, not from the spawn: node start-up and the child's launch
    // are the machine's. The stall this catches is the exit waiting out the cleanup budget (3 s) or the child's 20 s.
    const ms = doneAt - Number(mainDoneAt);
    assert.ok(ms < 2500, `exit stalled ${ms} ms`);
    const left = leaked(tmp);
    assert.strictEqual(left.length, 1, JSON.stringify(left));
    assert.match(left[0], /^belay-held-/);
  } finally {
    if (pid) require('../crash.cjs').crash(pid, created); // by pid and creation time: a pid nobody holds now may be another process's
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* held until the child is gone */ }
      if (!fs.existsSync(scratch)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
});

test('guard: probe files in belay-snapshot are counted apart, anything else in it is a leak', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-guardsnap-'));
  try {
    fs.mkdirSync(path.join(tmp, 'belay-snapshot'));
    for (const n of ['__PSScriptPolicyTest_a.b.ps1', '__PSScriptPolicyTest_c.d.psm1']) fs.writeFileSync(path.join(tmp, 'belay-snapshot', n), '');
    assert.deepStrictEqual(leaked(tmp), []);
    assert.strictEqual(snapshotResidue(tmp), 2);
    fs.writeFileSync(path.join(tmp, 'belay-snapshot', 'stray.txt'), '');
    assert.deepStrictEqual(leaked(tmp), ['belay-snapshot/stray.txt']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a targeted run of a temp-making test file leaves the temp dir it was given empty', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-targeted-'));
  try {
    const file = path.join(__dirname, '..', 'run', 'bottle.test.cjs');
    const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
    delete env.BELAY_TEST_TMP_ISOLATE;
    delete env.BELAY_SPAWN_REGISTRY;
    delete env.BELAY_TEST_SPAWN_REGISTRY_MADE_BY;
    for (const args of [['--test', file], ['--test', '--require', HELPER, file]]) {
      const r = spawnSync(process.execPath, args, { encoding: 'utf8', env });
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.deepStrictEqual(fs.readdirSync(tmp), [], `left behind by node ${args.join(' ')}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
