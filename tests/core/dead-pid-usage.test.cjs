'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// A pid taken from a child that has exited is not a dead pid: Windows hands it out again within seconds (tests/helpers/dead-pid.cjs).
// This reads the test sources for the spellings that took one and fails on any use.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SELF = path.basename(__filename);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'fixtures' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.cjs$/.test(e.name) && e.name !== SELF) out.push(p);
  }
  return out;
}

// -> the spellings in `src` that take an exited child's pid as a dead one.
function findings(src) {
  const out = [];
  // a spawnSync result's pid read directly; a dead/gone name assigned a child's pid or a spawnSync result; a spawnSync of an -e
  // script holding a ';' in a file that also reads some `.pid`
  const spellings = [
    /spawnSync\([^;]*\)\s*\.pid\b/,
    /\b(dead|gone)\w*\s*=\s*\w+\.pid\b/,
    /\b(dead|gone)\w*\s*=\s*spawnSync\(/,
    ...(/\.pid\b/.test(src) ? [/spawnSync\([^)]*\['-e',\s*(['"])[^'"]*;[^'"]*\1/] : []),
  ];
  for (const re of spellings) if (re.test(src)) out.push(String(re));
  // the pid of an identifier assigned from spawnSync, named within two lines as dead, gone or exited
  const spawned = [...src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:\w+\.)?spawnSync\(/g)].map((m) => m[1]);
  const lines = src.split(String.fromCharCode(10));
  lines.forEach((line, i) => {
    for (const n of spawned) {
      if (new RegExp(String.raw`\b${n}\.pid\b`).test(line) && /dead|gone|exited/i.test(lines.slice(Math.max(0, i - 2), i + 1).join(' '))) out.push(`${i + 1}: ${n}.pid`);
    }
  });
  return out;
}

test('no test uses the pid of an exited child as a dead pid', () => {
  const bad = [];
  for (const f of walk(ROOT)) for (const x of findings(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(ROOT, f)}: ${x}`);
  assert.deepStrictEqual(bad, []);
});

test('the scan finds each spelling it exists for, and passes the ones it must', () => {
  const found = (s) => findings(s).length > 0;
  assert.ok(found("const dead = spawnSync(process.execPath, ['--version'], { windowsHide: true }).pid;"));
  assert.ok(found("const gone = spawn(process.execPath, ['-e', '']);\nconst gonePid = gone.pid;"));
  assert.ok(found("const deadPid = child.pid;"));
  assert.ok(found("const dead = spawnSync(process.execPath, ['--version']);\nuse(dead.pid);"));
  assert.ok(found("const r = spawnSync(process.execPath, ['--version']);\n// its process has exited\nuse(r.pid);"));
  assert.ok(found("const x = spawnSync(process.execPath, ['-e', 'process.exit(0);']); const p = y.pid;"));
  assert.ok(!found("const r = spawnSync(process.execPath, ['--version']);\nassert.strictEqual(r.pid, 1);"));
  assert.ok(!found("const dead = deadPid();"));
});
