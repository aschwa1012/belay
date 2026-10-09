'use strict';
// config.test.cjs — the shared discovery module behind all four slice-3a commands. The gate in
// slice-3a.test.cjs drives these behaviours through the built CLI; this file asserts the two that a
// black-box test cannot reach without writing into the operator's real home directory, plus the
// resolution rules that are easy to get subtly wrong and hard to notice.
//
// Nothing here writes outside a temp sandbox, and the home-directory rule is asserted by calling
// discovery *at* the home directory and proving it looked at nothing, rather than by planting a file
// there.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../../src/cli/config.cjs');

const fwd = (p) => String(p).split('\\').join('/');
const sandbox = () => fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cfg-')));
const project = (dir) => { fs.mkdirSync(`${dir}/.git`, { recursive: true }); return dir; };

test('the home directory is never searched and never returned', () => {
  // On Windows the system temp directory sits under the home directory, so this guard decides
  // whether a sandboxed run can escape into the operator's own config. Called at home itself,
  // discovery must look at nothing at all.
  const r = C.discover(os.homedir());
  assert.strictEqual(r.found, false);
  assert.deepStrictEqual(r.searched, [], 'the home directory was read');
  assert.match(r.stopped_because, /home directory/);
});

test('discovery stops at the project root and does not take a config from above it', () => {
  const dir = sandbox();
  try {
    fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: 'from-above' }), 'utf8');
    const inner = project(`${dir}/proj`);
    fs.mkdirSync(`${inner}/src/deep`, { recursive: true });

    const r = C.discover(`${inner}/src/deep`);
    assert.strictEqual(r.found, false, 'a config above the project root must not be adopted');
    assert.ok(!r.searched.some((p) => p.startsWith(`${dir}/${C.CONFIG_NAME}`)), 'it looked above the root');
    assert.match(r.stopped_because, /project root/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a config at the project root is found from any depth below it', () => {
  const dir = project(sandbox());
  try {
    fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: 'store' }), 'utf8');
    fs.mkdirSync(`${dir}/a/b/c`, { recursive: true });
    const r = C.discover(`${dir}/a/b/c`);
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.path, `${dir}/${C.CONFIG_NAME}`);
    assert.strictEqual(r.searched.length, 4, 'it walked c, b, a and the root');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a relative data_dir resolves against the config file, not against the cwd', () => {
  // Otherwise the same config names a different store depending on which subdirectory the operator
  // happened to run from, which is how two processes end up owning two different stores.
  const dir = project(sandbox());
  try {
    fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: 'store' }), 'utf8');
    fs.mkdirSync(`${dir}/a/b`, { recursive: true });
    const deep = C.discover(`${dir}/a/b`);
    assert.strictEqual(C.dataDirOf(deep, { cwd: `${dir}/a/b`, dataDir: `${dir}/a/b/.belay` }), `${dir}/store`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unparseable config reports the parse error and still answers with defaults', () => {
  const dir = project(sandbox());
  try {
    fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, '{ not json', 'utf8');
    const r = C.discover(dir);
    assert.strictEqual(r.found, true, 'the file was found; it is its contents that are bad');
    assert.match(r.parse_error, /not valid JSON/);
    const eff = C.effective(r, 'data_dir', {});
    assert.strictEqual(eff.value, C.KEYS.data_dir.default);
    assert.strictEqual(eff.source, 'default', 'a value that did not come from the file must not claim to');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every effective value names where it came from, and an unknown key returns null', () => {
  const dir = project(sandbox());
  try {
    fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: 'store' }), 'utf8');
    const r = C.discover(dir);
    for (const eff of C.all(r, {})) {
      assert.ok(eff.source === 'default' || eff.source === r.path, `${eff.key} came from ${eff.source}`);
    }
    assert.strictEqual(C.effective(r, 'no_such_key', {}), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--data is inferred only when it differs from the dispatcher default', () => {
  // The dispatcher always fills ctx.dataDir, so a command cannot see the flag. The inference must
  // not label the default as an override, or `config get data_dir` would stop reporting the file.
  const cwd = 'C:/p';
  assert.strictEqual(C.overrideOf({ cwd, dataDir: 'C:/p/.belay' }), null);
  assert.strictEqual(C.overrideOf({ cwd, dataDir: 'D:/elsewhere' }), 'D:/elsewhere');
  // The dispatcher says outright: a given --data wins even when spelled as the default.
  assert.strictEqual(C.overrideOf({ cwd, dataDir: 'C:/p/.belay', dataDirGiven: true }), 'C:/p/.belay');
  assert.strictEqual(C.overrideOf({ cwd, dataDir: 'C:/p/.belay', dataDirGiven: false }), null);
});

test('init writes at the project root from a nested cwd, and at the cwd when there is no root', () => {
  const dir = project(sandbox());
  try {
    fs.mkdirSync(`${dir}/a/b`, { recursive: true });
    assert.strictEqual(C.writeDirOf(`${dir}/a/b`), dir, 'a nested init belongs at the project root');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const bare = sandbox();
  try {
    assert.strictEqual(C.writeDirOf(bare), bare, 'with no project root, init writes where it stands');
  } finally { fs.rmSync(bare, { recursive: true, force: true }); }
});
