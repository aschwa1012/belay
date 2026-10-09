'use strict';
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
    "console.log(c.pid);",
  ].join('\n'));
  const tmp = path.join(scratch, 'tmp');
  fs.mkdirSync(tmp);
  let pid = null;
  try {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--require', HELPER, script], { encoding: 'utf8', env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    const ms = Date.now() - t0;
    pid = Number(r.stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 0, r.stdout + r.stderr);
    assert.ok(ms < 2500, `exit stalled ${ms} ms`);
    const left = leaked(tmp);
    assert.strictEqual(left.length, 1, JSON.stringify(left));
    assert.match(left[0], /^belay-held-/);
  } finally {
    if (pid) { try { process.kill(pid); } catch { /* gone */ } }
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
