'use strict';
require('../helpers/tmp.cjs'); // a plain `node --test` of this file keeps its temp dirs out of the real temp dir
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

// A repository's config may only name a data_dir inside that repository (--data is the way to name one elsewhere).
const withDataDir = (value) => {
  const dir = project(sandbox());
  fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: value }), 'utf8');
  return { dir, found: C.discover(dir) };
};

test('a committed data_dir inside the repository is accepted when relative', () => {
  const { dir, found } = withDataDir('state/store');
  assert.strictEqual(C.dataDirOf(found, { cwd: dir, dataDir: `${dir}/.belay`, dataDirGiven: false }), `${dir}/state/store`);
  const abs = withDataDir(`${sandbox()}/x`); // another sandbox: outside
  assert.throws(() => C.dataDirOf(abs.found, { cwd: abs.dir, dataDir: `${abs.dir}/.belay`, dataDirGiven: false }), { code: 'E_DATA_DIR' });
});

test('a committed data_dir that leaves the repository is refused, naming the path and the allowed source', () => {
  const cases = ['..', '../elsewhere', '.', `${sandbox()}/other`, '//server/share/store', '\\server\share\store', 'sub/../../out'];
  if (process.platform === 'win32') cases.push('C:store', 'C:');
  for (const value of cases) {
    const { dir, found } = withDataDir(value);
    const ctx = { cwd: dir, dataDir: `${dir}/.belay`, dataDirGiven: false };
    assert.throws(() => C.dataDirOf(found, ctx), (e) => e.code === 'E_DATA_DIR' && e.message.includes(JSON.stringify(value)) && e.message.includes('--data'), `data_dir ${value} was accepted`);
    assert.ok(C.effective(found, 'data_dir', {}).refused, `effective() did not flag ${value}`);
  }
});

test('--data names a store anywhere, even when the config names one that would be refused', () => {
  const { dir, found } = withDataDir('../elsewhere');
  const elsewhere = `${sandbox()}/store`;
  assert.strictEqual(C.dataDirOf(found, { cwd: dir, dataDir: elsewhere, dataDirGiven: true }), elsewhere);
});

test('a junction inside the repository that points out of it is followed before the check', () => {
  const dir = project(sandbox());
  const outside = sandbox();
  fs.symlinkSync(outside, `${dir}/link`, 'junction');
  fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: 'link/store' }), 'utf8');
  const found = C.discover(dir);
  assert.throws(() => C.dataDirOf(found, { cwd: dir, dataDir: `${dir}/.belay`, dataDirGiven: false }), { code: 'E_DATA_DIR' });
  fs.rmdirSync(`${dir}/link`); // unlink the junction only
});

test('a data_dir in a config below the project root may be anywhere inside the project', () => {
  const dir = project(sandbox());
  fs.mkdirSync(`${dir}/pkg`, { recursive: true });
  fs.writeFileSync(`${dir}/pkg/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: '../shared/.belay' }), 'utf8');
  const found = C.discover(`${dir}/pkg`);
  assert.strictEqual(C.dataDirOf(found, { cwd: `${dir}/pkg`, dataDir: `${dir}/pkg/.belay`, dataDirGiven: false }), `${dir}/shared/.belay`);
});

test('init --data outside the repository keeps the default data_dir in the config and says how to name the store', async () => {
  const dir = project(sandbox());
  const outside = `${sandbox()}/store`;
  const r = await require('../../src/cli/cmd-init.cjs').run({ argv: [], cwd: dir, dataDir: outside, dataDirGiven: true, json: true });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(`${dir}/${C.CONFIG_NAME}`, 'utf8')).data_dir, '.belay'); // init also writes memory.project (default-project.test.cjs)
  assert.match(r.json.note, /--data .* on each command/);
  assert.ok(fs.existsSync(outside), 'the store the operator asked for was created');
});

test('doctor reports a refused data_dir as a failed check and still runs the other checks', async () => {
  const { dir } = withDataDir('../elsewhere');
  const r = await require('../../src/cli/cmd-doctor.cjs').run({ argv: [], cwd: dir, dataDir: `${dir}/.belay`, dataDirGiven: false, json: true });
  assert.strictEqual(r.code, 0);
  const row = r.json.checks.find((c) => c.check === 'config-data-dir');
  assert.strictEqual(row.verdict, 'error');
  assert.match(row.evidence, /not inside the repository/);
  assert.strictEqual(r.json.data_dir, `${dir}/.belay`);
  assert.ok(r.json.checks.some((c) => c.check === 'data-dir'));
});

test('a package with its own package.json takes the .git above it as the root, so the shared store at the root is allowed', () => {
  const dir = project(sandbox());
  fs.mkdirSync(`${dir}/packages/app`, { recursive: true });
  fs.writeFileSync(`${dir}/packages/app/package.json`, '{}');
  fs.writeFileSync(`${dir}/packages/app/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: '../../.belay' }), 'utf8');
  const found = C.discover(`${dir}/packages/app`);
  assert.strictEqual(C.dataDirOf(found, { cwd: `${dir}/packages/app`, dataDir: 'x', dataDirGiven: false }), `${dir}/.belay`);
});

test('a .git file (a linked worktree) is a repository root, and the refusal names the root it used', () => {
  const dir = sandbox();
  fs.writeFileSync(`${dir}/.git`, 'gitdir: elsewhere');
  fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: '../out' }), 'utf8');
  const e = C.effective(C.discover(dir), 'data_dir', {});
  assert.ok(e.refused.includes(`not inside the repository ${dir} (the nearest .git)`), e.refused);
  const bare = sandbox();
  fs.writeFileSync(`${bare}/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: '../out' }), 'utf8');
  assert.match(C.effective(C.discover(bare), 'data_dir', {}).refused, /not inside the directory .*no \.git or package\.json above it/);
});

test('an absolute data_dir inside the repository is accepted', () => {
  const dir = project(sandbox());
  fs.writeFileSync(`${dir}/${C.CONFIG_NAME}`, JSON.stringify({ data_dir: `${dir}/in/store` }), 'utf8');
  assert.strictEqual(C.dataDirOf(C.discover(dir), { cwd: dir, dataDir: 'x', dataDirGiven: false }), `${dir}/in/store`);
});

test('belay config (the summary) shows a refused data_dir in text and json', () => {
  const { dir, found } = withDataDir('../elsewhere');
  const cfg = require('../../src/cli/cmd-config.cjs');
  return Promise.resolve(cfg.run({ argv: [], cwd: dir, dataDir: `${dir}/.belay`, dataDirGiven: false, json: false })).then(async (t) => {
    assert.match(t.text, /refused: data_dir "\.\.\/elsewhere"/);
    const j = await cfg.run({ argv: [], cwd: dir, dataDir: `${dir}/.belay`, dataDirGiven: false, json: true });
    assert.match(j.json.values.data_dir.refused, /not inside/);
  });
});

test('init --data the repository root itself, or through a junction that leaves it, is not written into the config', async () => {
  const dir = project(sandbox());
  const r = await require('../../src/cli/cmd-init.cjs').run({ argv: [], cwd: dir, dataDir: dir, dataDirGiven: true, json: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(`${dir}/${C.CONFIG_NAME}`, 'utf8')).data_dir, '.belay'); // init also writes memory.project (default-project.test.cjs)
  assert.ok(r.json.note && !/outside the repository/.test(r.json.note), r.json.note);
  const d2 = project(sandbox());
  const out = sandbox();
  fs.symlinkSync(out, `${d2}/link`, 'junction');
  await require('../../src/cli/cmd-init.cjs').run({ argv: [], cwd: d2, dataDir: `${d2}/link/x`, dataDirGiven: true, json: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(`${d2}/${C.CONFIG_NAME}`, 'utf8')).data_dir, '.belay'); // init also writes memory.project (default-project.test.cjs)
  fs.rmdirSync(`${d2}/link`);
});
