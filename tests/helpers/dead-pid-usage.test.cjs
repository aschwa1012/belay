'use strict';
// A pid taken from a child that has exited is not a dead pid: Windows hands it out again within seconds (tests/helpers/dead-pid.cjs).
// This reads the test sources for the two spellings that took one and fails on any use.
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

test('no test uses the pid of an exited child as a dead pid', () => {
  const bad = [];
  for (const f of walk(ROOT)) {
    const src = fs.readFileSync(f, 'utf8');
    // spawnSync(...) result whose pid is read, and a child awaited to exit then read for a pid named gone/dead
    const spellings = [/spawnSync\([^;]*\)\s*\.pid\b/, /\b(dead|gone)\w*\s*=\s*spawnSync\(/, /\bgone\w*\s*=\s*\w+\.pid\b/];
    for (const re of spellings) if (re.test(src)) bad.push(`${path.relative(ROOT, f)}: ${re}`);
  }
  assert.deepStrictEqual(bad, []);
});
