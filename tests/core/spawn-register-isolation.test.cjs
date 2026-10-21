'use strict';
// spawn-register-isolation.test.cjs — the spawn register is machine-wide by design (src/core/spawn-register.cjs), which makes it the
// one place where one test's processes can be taken for another's, or for a real belay run's. Tests must never reach it: every test
// process gets its own register directory from tests/helpers/tmp.cjs however the file is run, the suite's guard reports anything
// found in the default directory, and a test file that can start processes loads the helper.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core } = require('./helpers.cjs');
const { leaked } = require('../../scripts/test.cjs');

const SR = core('spawn-register.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const HELPER = path.join(ROOT, 'tests', 'helpers', 'tmp.cjs');
const fwd = (p) => p.split(path.sep).join('/');

test('this test process has its own register directory, not the machine-wide default', () => {
  assert.ok(process.env.BELAY_SPAWN_REGISTRY, 'the helper set it');
  assert.notStrictEqual(path.resolve(SR.dir()).toLowerCase(), path.resolve(path.join(os.tmpdir(), 'belay-spawned')).toLowerCase());
  assert.ok(path.basename(SR.dir()).startsWith('belay-spawned-test-'));
});

test('a process started with the helper and no register variable writes nothing to the default register', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-reg-iso-'));
  try {
    const script = path.join(scratch, 'writer.cjs');
    fs.writeFileSync(script, [
      `const SR = require(${JSON.stringify(fwd(path.join(ROOT, 'src', 'core', 'spawn-register.cjs')))});`,
      "SR.register({ pid: process.pid, kind: 'worker' });",
      "SR.saveTombstone({ pid: 4003, created: 1, from: 1, until: 2, kind: 'worker', via: null });",
      "console.log(SR.dir());",
    ].join('\n'));
    const tmp = path.join(scratch, 'tmp');
    fs.mkdirSync(tmp);
    const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
    delete env.BELAY_SPAWN_REGISTRY;
    const r = spawnSync(process.execPath, ['--require', HELPER, script], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(path.basename(r.stdout.trim()).startsWith('belay-spawned-test-'), r.stdout);
    assert.ok(!fs.existsSync(path.join(tmp, 'belay-spawned')), 'the default register directory was never made');
    assert.deepStrictEqual(leaked(tmp), [], 'and the helper removed its own on exit');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('the suite guard reports a record or a tombstone in the default register, and nothing for an absent one', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-reg-guard-'));
  try {
    assert.deepStrictEqual(leaked(scratch), []);
    fs.mkdirSync(path.join(scratch, 'belay-spawned', 'exited'), { recursive: true });
    assert.deepStrictEqual(leaked(scratch), [], 'an empty register directory is not a write');
    fs.writeFileSync(path.join(scratch, 'belay-spawned', '123.json'), '{}');
    fs.writeFileSync(path.join(scratch, 'belay-spawned', 'exited', '5-0.json'), '{}');
    assert.deepStrictEqual(leaked(scratch).sort(), ['belay-spawned/123.json', 'belay-spawned/exited/5-0.json']);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

// Static: a test file that can start a process (a child, a run manager, a store owner) must load tests/helpers/tmp.cjs, directly or
// through a helper module of its own. A file that does not would write to the machine-wide register when run by itself.
test('every test file that can start processes loads the tmp helper', () => {
  const norm = (p) => path.resolve(p).split(path.sep).join('/').toLowerCase();
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['fixtures', 'fakes', 'acceptance', 'measure', 'node_modules'].includes(e.name)) walk(p); } else if (e.name.endsWith('.cjs')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'tests'));
  const reqs = (f) => [...fs.readFileSync(f, 'utf8').matchAll(/require\('(\.[^']+)'\)/g)].map((m) => {
    let p = path.resolve(path.dirname(f), m[1]);
    if (!/\.c?js$/.test(p)) p = fs.existsSync(p + '.cjs') ? p + '.cjs' : path.join(p, 'index.cjs');
    return p;
  });
  const loads = (f, seen = new Set()) => {
    const k = norm(f);
    if (k === norm(HELPER)) return true;
    if (seen.has(k) || !k.includes('/tests/') || !fs.existsSync(f)) return false;
    seen.add(k);
    return reqs(f).some((r) => loads(r, seen));
  };
  const canStart = (f) => /child_process|createRunManager|core\/index\.cjs|run\/index\.cjs|\bfork\(|openStore|ensureOwner/.test(fs.readFileSync(f, 'utf8'));
  const ALONE = new Set(['tests/core/tmp-helper.test.cjs']); // tests the helper itself, with its own environment
  const bad = files.filter((f) => f.endsWith('.test.cjs') && canStart(f) && !ALONE.has(fwd(path.relative(ROOT, f))) && !loads(f)).map((f) => fwd(path.relative(ROOT, f)));
  assert.deepStrictEqual(bad, [], 'add require of tests/helpers/tmp.cjs (or of a helper that does) to these files');
});
