'use strict';
require('../helpers/tmp.cjs'); // a plain `node --test` of this file keeps its temp dirs out of the real temp dir
// tests/helpers/temp-root.cjs: a temp root inside the user's Projects folder (or another indexed location) is
// refused and replaced by the real OS temp dir; an explicit override keeps it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const TR = require('../helpers/temp-root.cjs');

const HELPER = path.join(__dirname, '..', 'helpers', 'tmp.cjs');
const win = process.platform === 'win32';
const HOME = win ? 'C:/fakehome/someone' : '/fakehome/someone';

test('indexedReason: Projects and other folders under the home are indexed, AppData and outside paths are not', () => {
  const o = { env: {}, home: HOME };
  assert.match(TR.indexedReason(`${HOME}/Projects/research/scratch-tmp`, o), /home folder/);
  assert.match(TR.indexedReason(`${HOME}/eval-lines/x`, o), /home folder/);
  assert.strictEqual(TR.indexedReason(`${HOME}/AppData/Local/Temp`, o), null);
  assert.strictEqual(TR.indexedReason(win ? 'D:/a/_temp' : '/var/tmp', o), null);
  assert.strictEqual(TR.indexedReason(`${HOME}x/Projects`, o), null, 'a sibling that merely shares the prefix is not under the home');
  assert.match(TR.indexedReason(win ? 'D:/extra/t' : '/extra/t', { env: { BELAY_TEST_INDEXED_ROOTS: [win ? 'D:/extra' : '/extra', 'other'].join(path.delimiter) }, home: HOME }), /indexed root/);
});

test('safeTempRoot: a Projects temp root falls back to the OS temp dir; the override keeps it', () => {
  const current = `${HOME}/Projects/research-2026-10-31/scratch-tmp`;
  const env = { LOCALAPPDATA: `${HOME}/AppData/Local` };
  const r = TR.safeTempRoot({ env, home: HOME, current });
  assert.strictEqual(r.refused, true);
  assert.strictEqual(r.from, current);
  assert.strictEqual(r.dir, TR.fallbackTemp({ env, home: HOME }));
  assert.strictEqual(TR.indexedReason(r.dir, { env, home: HOME }), null, 'the fallback is not itself indexed');
  const kept = TR.safeTempRoot({ env: { ...env, BELAY_TEST_TEMP_ALLOW_INDEXED: '1' }, home: HOME, current });
  assert.deepStrictEqual([kept.refused, kept.dir], [false, current]);
  assert.strictEqual(TR.safeTempRoot({ env, home: HOME, current: `${HOME}/AppData/Local/Temp` }).refused, false);
});

// A child that loads tmp.cjs with TEMP inside a pretend indexed root, and prints the temp dir it ended up with.
function child(extraEnv) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-temproot-'));
  const indexed = path.join(base, 'Projects', 'scratch-tmp');
  const localAppData = path.join(base, 'Local');
  fs.mkdirSync(indexed, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  const script = path.join(base, 'print.cjs');
  fs.writeFileSync(script, "process.stdout.write(require('os').tmpdir());\n");
  const r = spawnSync(process.execPath, ['--require', HELPER, script], {
    encoding: 'utf8',
    env: { ...process.env, TEMP: indexed, TMP: indexed, TMPDIR: indexed, LOCALAPPDATA: localAppData, BELAY_TEST_INDEXED_ROOTS: path.join(base, 'Projects'), BELAY_TEST_TMP_ISOLATE: '0', ...extraEnv },
  });
  return { base, indexed, localAppData, r };
}

test('tmp helper: a temp root under an indexed folder is refused with a loud warning and replaced by the OS temp dir', () => {
  const { base, indexed, localAppData, r } = child({});
  try {
    assert.strictEqual(r.status, 0, r.stderr);
    const want = win ? path.join(localAppData, 'Temp') : '/tmp';
    assert.strictEqual(path.resolve(r.stdout), path.resolve(want));
    assert.notStrictEqual(path.resolve(r.stdout), path.resolve(indexed));
    assert.match(r.stderr, /belay tests: temp root .* is inside the indexed root/);
    assert.match(r.stderr, /BELAY_TEST_TEMP_ALLOW_INDEXED=1/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('tmp helper: BELAY_TEST_TEMP_ALLOW_INDEXED=1 keeps the chosen root and stays quiet', () => {
  const { base, indexed, r } = child({ BELAY_TEST_TEMP_ALLOW_INDEXED: '1' });
  try {
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(path.resolve(r.stdout), path.resolve(indexed));
    assert.doesNotMatch(r.stderr, /belay tests: temp root/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('indexedReason: a junction or symlink into an indexed folder is caught through the real path', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-temproot-link-')));
  try {
    const target = path.join(base, 'Projects');
    fs.mkdirSync(target);
    const link = path.join(base, 'link');
    try { fs.symlinkSync(target, link, 'junction'); } catch (e) { return; /* links not permitted here: nothing to check */ }
    const env = { BELAY_TEST_INDEXED_ROOTS: target };
    assert.match(TR.indexedReason(path.join(link, 'scratch-tmp'), { env, home: HOME }), /indexed root/);
    assert.strictEqual(TR.indexedReason(path.join(base, 'elsewhere'), { env, home: HOME }), null);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

// Every test file, acceptance row and smoke script must reach the guard: it, or a helper it requires (transitively, relative requires only), loads
// tests/helpers/tmp.cjs, git-env.cjs or temp-root.cjs. A bare `node --test file` has no --require, so this is the only way in.
test('every test file, acceptance row and smoke script reaches the temp-root guard through its requires', () => {
  const root = path.join(__dirname, '..');
  const GUARDS = new Set(['tmp.cjs', 'git-env.cjs', 'temp-root.cjs'].map((n) => path.join(root, 'helpers', n)));
  const cache = new Map();
  const reaches = (file, seen = new Set()) => {
    if (GUARDS.has(file)) return true;
    if (cache.has(file)) return cache.get(file);
    if (seen.has(file)) return false;
    seen.add(file);
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch { return false; }
    let hit = false;
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let t = path.resolve(path.dirname(file), m[1]);
      if (!fs.existsSync(t) || fs.statSync(t).isDirectory()) t = fs.existsSync(`${t}.cjs`) ? `${t}.cjs` : path.join(t, 'index.cjs');
      if (reaches(t, seen)) { hit = true; break; }
    }
    cache.set(file, hit);
    return hit;
  };
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'fixtures' && e.name !== 'node_modules') walk(p); } else if (/\.(test|selftest)\.cjs$/.test(e.name) || (/^(acceptance|smoke)$/.test(path.basename(d)) && e.name !== 'lib.cjs')) files.push(p); } };
  walk(root);
  assert.ok(files.length > 100, `found ${files.length} test files`);
  const missing = files.filter((f) => !reaches(f)).map((f) => path.relative(root, f).split(path.sep).join('/'));
  assert.deepStrictEqual(missing, [], `${missing.length} files never load the temp-root guard`);
});
