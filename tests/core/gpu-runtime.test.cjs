'use strict';
// gpu-runtime.test.cjs — the pinned GPU runtime manifest and its on-demand install (ADR 0049 decision 2).
// No test runs npm: installRuntime takes an installer seam, here one that builds the tree the shipped
// lockfile describes (and, for the refusals, a damaged one).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const R = core('gpu-runtime.cjs');
const manifest = R.readManifest();
const DIRECT = ['@node-llama-cpp/win-x64', '@node-llama-cpp/win-x64-vulkan', 'node-llama-cpp'];

// Writes node_modules as `npm ci --omit=optional` would, from the shipped lockfile; `damage(tree)` may alter it.
function treeInstaller(damage, calls = []) {
  return async (dir) => {
    calls.push(dir);
    const direct = new Set(DIRECT.map(n => `node_modules/${n}`));
    const hidden = { name: manifest.lock.name, lockfileVersion: 3, requires: true, packages: {} };
    for (const [key, ent] of Object.entries(manifest.lock.packages)) {
      if (!key || (ent.optional && !direct.has(key))) continue;
      hidden.packages[key] = { ...ent };
    }
    const tree = { hidden, versions: Object.fromEntries(Object.entries(hidden.packages).map(([k, e]) => [k, e.version])), lock: null };
    if (damage) damage(tree);
    for (const [key, version] of Object.entries(tree.versions)) {
      fs.mkdirSync(path.join(dir, key), { recursive: true });
      fs.writeFileSync(path.join(dir, key, 'package.json'), JSON.stringify({ name: key, version }));
    }
    fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), JSON.stringify(tree.hidden));
    if (tree.lock) fs.writeFileSync(path.join(dir, 'package-lock.json'), tree.lock);
    return { code: tree.code === undefined ? 0 : tree.code, ms: 1, tail: tree.tail || '' };
  };
}

const envFor = (dir) => ({ ...process.env, BELAY_GPU_RUNTIME: dir });
const leftovers = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n !== '.install.lock') : []);

test('the manifest pins exactly three direct dependencies at 3.22.2 and the lockfile pins every package', () => {
  assert.deepStrictEqual(manifest.dependencies, { '@node-llama-cpp/win-x64': '3.22.2', '@node-llama-cpp/win-x64-vulkan': '3.22.2', 'node-llama-cpp': '3.22.2' });
  assert.strictEqual(manifest.lock.packages[''].dependencies['node-llama-cpp'], '3.22.2');
  const missing = Object.entries(manifest.lock.packages).filter(([k, e]) => k && (!e.integrity || !e.resolved)).map(([k]) => k);
  assert.deepStrictEqual(missing, [], 'every locked package has an integrity hash and a source');
  for (const k of ['win-x64-cuda', 'win-x64-cuda-ext']) assert.strictEqual(manifest.lock.packages[`node_modules/@node-llama-cpp/${k}`].optional, true, `${k} is optional, so --omit=optional skips it`);
  assert.ok(R.INSTALL_ARGS.includes('--omit=optional') && R.INSTALL_ARGS.includes('--ignore-scripts') && R.INSTALL_ARGS[0] === 'ci');
});

test('the install base sits beside the model cache', () => {
  assert.strictEqual(R.baseDir({ BELAY_GPU_RUNTIME: 'C:/x/rt' }), 'C:/x/rt');
  assert.strictEqual(R.baseDir({ BELAY_MODEL_CACHE: 'C:/x/models' }), 'C:/x/models/gpu-runtime');
  assert.match(R.baseDir({ LOCALAPPDATA: 'D:/la/AppData/Local' }).replace(/\\/g, '/'), /belay\/gpu-runtime$/);
  assert.match(R.installDir(manifest, { BELAY_GPU_RUNTIME: 'C:/x' }), /^C:\/x\/llama-3\.22\.2-[0-9a-f]{12}$/);
});

test('a missing runtime is refused E_MODEL_ABSENT naming the installing command', () => {
  const dir = sandbox();
  try {
    assert.throws(() => R.requireRuntime({ env: envFor(dir) }), (e) => {
      assert.strictEqual(e.code, 'E_MODEL_ABSENT');
      assert.match(e.message, /belay embedder fetch --gpu/);
      assert.strictEqual(e.detail.command, 'belay embedder fetch --gpu');
      return true;
    });
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'a check creates nothing');
  } finally { cleanup(dir); }
});

test('install: a sound tree is verified, renamed into place, recorded and then reused without a second install', async () => {
  const dir = sandbox(), calls = [];
  try {
    const r = await R.installRuntime({ env: envFor(dir), installer: treeInstaller(null, calls) });
    assert.strictEqual(r.already_present, false);
    assert.deepStrictEqual(r.versions, { '@node-llama-cpp/win-x64': '3.22.2', '@node-llama-cpp/win-x64-vulkan': '3.22.2', 'node-llama-cpp': '3.22.2' });
    assert.ok(r.bytes > 0);
    assert.ok(fs.existsSync(path.join(r.dir, 'runtime.json')));
    assert.deepStrictEqual(leftovers(dir), [path.basename(r.dir)], 'no temporary directory is left');
    assert.ok(!fs.existsSync(path.join(r.dir, 'node_modules', '@node-llama-cpp', 'win-x64-cuda')), 'no CUDA package');
    assert.strictEqual(R.requireRuntime({ env: envFor(dir) }), r.dir);
    assert.strictEqual(R.check({ env: envFor(dir), deep: true }).ok, true);
    const again = await R.installRuntime({ env: envFor(dir), installer: treeInstaller(null, calls) });
    assert.strictEqual(again.already_present, true);
    assert.strictEqual(calls.length, 1, 'the installer ran once');
  } finally { cleanup(dir); }
});

const REFUSED = {
  'a direct dependency at another version': (t) => { t.versions['node_modules/node-llama-cpp'] = '3.22.1'; },
  'a package the lockfile does not name': (t) => { t.hidden.packages['node_modules/left-pad'] = { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: 'sha512-x' }; t.versions['node_modules/left-pad'] = '1.3.0'; },
  'a different integrity hash': (t) => { t.hidden.packages['node_modules/node-llama-cpp'].integrity = 'sha512-tampered'; },
  'an optional CUDA package': (t) => { const k = 'node_modules/@node-llama-cpp/win-x64-cuda'; t.hidden.packages[k] = { ...manifest.lock.packages[k] }; t.versions[k] = manifest.lock.packages[k].version; },
  'files on disk that differ from the record': (t) => { t.versions['node_modules/yargs'] = '0.0.1'; },
  'a rewritten lockfile': (t) => { t.lock = '{"lockfileVersion":3}'; },
  'no installed-package record': (t) => { t.hidden = { packages: {} }; },
};
for (const [name, damage] of Object.entries(REFUSED)) {
  test(`install refuses ${name} and keeps nothing`, async () => {
    const dir = sandbox();
    try {
      await assert.rejects(R.installRuntime({ env: envFor(dir), installer: treeInstaller(damage) }), (e) => {
        assert.strictEqual(e.code, 'E_MODEL_ABSENT');
        assert.strictEqual(e.detail.cause, 'mismatch');
        return true;
      });
      assert.deepStrictEqual(leftovers(dir), [], 'no install, no temporary directory');
      assert.strictEqual(R.check({ env: envFor(dir) }).ok, false);
    } finally { cleanup(dir); }
  });
}

test('install: a failing npm is refused with its output and keeps nothing', async () => {
  const dir = sandbox();
  try {
    await assert.rejects(R.installRuntime({ env: envFor(dir), installer: async () => ({ code: 1, ms: 1, tail: 'npm error integrity checksum failed' }) }), (e) => e.code === 'E_MODEL_ABSENT' && /integrity checksum failed/.test(e.message) && e.detail.npm_code === 1);
    assert.deepStrictEqual(leftovers(dir), []);
  } finally { cleanup(dir); }
});

test('install: a wrong tree already in place is replaced only by a verified one', async () => {
  const dir = sandbox();
  try {
    const target = R.installDir(manifest, envFor(dir));
    fs.mkdirSync(path.join(target, 'node_modules', 'node-llama-cpp'), { recursive: true });
    fs.writeFileSync(path.join(target, 'node_modules', 'node-llama-cpp', 'package.json'), '{"version":"9.9.9"}');
    fs.writeFileSync(path.join(target, 'runtime.json'), '{}');
    assert.strictEqual(R.check({ env: envFor(dir) }).ok, false);
    await assert.rejects(R.installRuntime({ env: envFor(dir), installer: treeInstaller((t) => { t.versions['node_modules/node-llama-cpp'] = '1.0.0'; }) }), (e) => e.code === 'E_MODEL_ABSENT');
    assert.ok(fs.existsSync(path.join(target, 'runtime.json')), 'a refused install does not touch what was there');
    const r = await R.installRuntime({ env: envFor(dir), installer: treeInstaller() });
    assert.strictEqual(r.already_present, false);
    assert.strictEqual(R.check({ env: envFor(dir), deep: true }).ok, true);
  } finally { cleanup(dir); }
});

test('install: a live holder of the lock refuses with E_BUSY, a dead holder is stolen', async () => {
  const dir = sandbox();
  try {
    const base = R.baseDir(envFor(dir));
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, '.install.lock'), String(process.pid));
    await assert.rejects(R.installRuntime({ env: envFor(dir), installer: treeInstaller() }), (e) => e.code === 'E_BUSY');
    fs.writeFileSync(path.join(base, '.install.lock'), String(require('./helpers.cjs').deadPid()));
    const r = await R.installRuntime({ env: envFor(dir), installer: treeInstaller() });
    assert.strictEqual(r.already_present, false);
  } finally { cleanup(dir); }
});

test('belay embedder verify --gpu reports a missing runtime and exits 1 without creating anything; --gpu --model needs a GPU table id', async () => {
  const dir = sandbox(), saved = process.env.BELAY_GPU_RUNTIME;
  process.env.BELAY_GPU_RUNTIME = dir;
  try {
    const cmd = require(path.join(__dirname, '..', '..', 'src', 'cli', 'cmd-embedder.cjs'));
    const r = await cmd.run({ argv: ['verify', '--gpu'] });
    assert.strictEqual(r.code, 1);
    assert.match(r.text, /verify FAILED for the GPU runtime/);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    const m = await cmd.run({ argv: ['fetch', '--gpu', '--model', 'onnx-community/voyage-4-nano-ONNX'] });
    assert.strictEqual(m.code, 2);
    assert.match(m.text, /unknown embedding model/);
  } finally { if (saved === undefined) delete process.env.BELAY_GPU_RUNTIME; else process.env.BELAY_GPU_RUNTIME = saved; cleanup(dir); }
});

// ---- the install record's file manifest: a changed runtime is wrong ----

const MODS = {
  'a removed file (a quarantined DLL)': { light: true, mutate: (d) => fs.rmSync(path.join(d, 'node_modules/@node-llama-cpp/win-x64-vulkan/package.json')) },
  'a file of another size': { light: true, mutate: (d) => fs.appendFileSync(path.join(d, 'node_modules/node-llama-cpp/package.json'), ' ') },
  'an extra file': { light: true, mutate: (d) => fs.writeFileSync(path.join(d, 'node_modules/node-llama-cpp/implant.node'), 'x') },
  'an extra directory': { light: true, mutate: (d) => fs.mkdirSync(path.join(d, 'node_modules/implant')) },
  'a replaced file of the same size': { light: false, mutate: (d) => { const p = path.join(d, 'node_modules/node-llama-cpp/package.json'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('"name":"node_', '"name":"nodX_')); } },
};
for (const [name, mod] of Object.entries(MODS)) {
  test(`the file manifest catches ${name}: ${mod.light ? 'the light check and the deep check' : 'the deep check (a hash)'} refuse it, naming the install command`, async () => {
    const dir = sandbox();
    try {
      const r = await R.installRuntime({ env: envFor(dir), installer: treeInstaller() });
      assert.ok(r.files > 100, 'the record lists every file');
      assert.strictEqual(R.check({ env: envFor(dir) }).ok, true);
      mod.mutate(r.dir);
      assert.strictEqual(R.check({ env: envFor(dir) }).ok, !mod.light, 'the light check compares file set and sizes');
      const deep = R.check({ env: envFor(dir), deep: true });
      assert.strictEqual(deep.ok, false);
      if (mod.light) assert.throws(() => R.requireRuntime({ env: envFor(dir) }), (e) => e.code === 'E_MODEL_ABSENT' && /belay embedder fetch --gpu/.test(e.message));
      else assert.match(deep.problems.join(' '), /sha256 differs/);
      // an install over the damaged tree replaces it with a verified one
      const again = await R.installRuntime({ env: envFor(dir), installer: treeInstaller() });
      assert.strictEqual(again.already_present, false);
      assert.strictEqual(R.check({ env: envFor(dir), deep: true }).ok, true);
    } finally { cleanup(dir); }
  });
}

// ---- the install lock and the sweep: deterministic interleavings, no timing ----

const lockPath = (d) => path.join(d, '.install.lock');

test('lock: two installers read one stale lock; the one that moved a LIVE lock puts it back and fails', () => {
  const dir = sandbox(), dead = require('./helpers.cjs').deadPid(), other = process.ppid;
  try {
    fs.writeFileSync(lockPath(dir), String(dead));
    let nested = null;
    const got = R.takeLock(lockPath(dir), { pid: process.pid, seam: { beforeSteal: (text) => {
      assert.strictEqual(text, String(dead));
      nested = R.takeLock(lockPath(dir), { pid: other }); // the other installer runs its whole steal in the gap
    } } });
    assert.strictEqual(nested, true, 'the other installer got the lock');
    assert.strictEqual(got, false, 'this one must not also hold it');
    assert.strictEqual(fs.readFileSync(lockPath(dir), 'utf8'), String(other), 'the live lock is back in place');
    assert.deepStrictEqual(fs.readdirSync(dir), ['.install.lock'], 'no stale-lock file is left');
  } finally { cleanup(dir); }
});

test('lock: the stale lock is released by another installer before our rename; we take it with a fresh create', () => {
  const dir = sandbox();
  try {
    fs.writeFileSync(lockPath(dir), String(require('./helpers.cjs').deadPid()));
    const got = R.takeLock(lockPath(dir), { pid: process.pid, seam: { beforeSteal: () => fs.rmSync(lockPath(dir)) } });
    assert.strictEqual(got, true);
    assert.strictEqual(fs.readFileSync(lockPath(dir), 'utf8'), String(process.pid));
  } finally { cleanup(dir); }
});

test('lock: a release deletes only a lock that still names the releaser', () => {
  const dir = sandbox();
  try {
    fs.writeFileSync(lockPath(dir), String(process.ppid));
    R.releaseLock(lockPath(dir), process.pid);
    assert.ok(fs.existsSync(lockPath(dir)), 'someone else\'s lock stays');
    R.releaseLock(lockPath(dir), process.ppid);
    assert.ok(!fs.existsSync(lockPath(dir)));
  } finally { cleanup(dir); }
});

test('sweep: only leftovers whose named pid is dead are removed; a live installer\'s tree survives an install', async () => {
  const dir = sandbox(), dead = require('./helpers.cjs').deadPid();
  try {
    const base = R.baseDir(envFor(dir));
    const mk = (n) => { fs.mkdirSync(path.join(base, n, 'node_modules'), { recursive: true }); };
    mk(`.tmp-llama-3.22.2-49276d8b5612-${dead}-111`); mk(`.old-${dead}-222`);
    mk(`.tmp-llama-3.22.2-49276d8b5612-${process.ppid}-333`); mk('unrelated');
    await R.installRuntime({ env: envFor(dir), installer: treeInstaller() });
    assert.deepStrictEqual(fs.readdirSync(base).filter(n => n.startsWith('.')).sort(), [`.tmp-llama-3.22.2-49276d8b5612-${process.ppid}-333`, ], 'only the live installer\'s tree stays');
    assert.ok(fs.existsSync(path.join(base, 'unrelated')));
  } finally { cleanup(dir); }
});

// ---- N4, N7 ----

test('a rename blocked by a process holding the runtime\'s files is a coded E_BUSY, and nothing is kept', async () => {
  const dir = sandbox();
  try {
    const rename = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
    await assert.rejects(R.installRuntime({ env: envFor(dir), installer: treeInstaller(), rename }), (e) => e.code === 'E_BUSY' && e.detail.errno === 'EPERM' && e.detail.gpu === true && /in use/.test(e.message));
    assert.deepStrictEqual(leftovers(dir), []);
    assert.strictEqual(R.check({ env: envFor(dir) }).ok, false);
  } finally { cleanup(dir); }
});

test('npm gets the allow-list and only proxy and CA settings of npm_config_*; npm_config_include=optional is dropped', () => {
  const e = R.npmEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'sk', npm_config_include: 'optional', npm_config_omit: '', NPM_CONFIG_INCLUDE: 'optional', npm_config_registry: 'https://mirror.example', npm_config_https_proxy: 'http://proxy:8080', npm_config_cafile: 'C:/ca.pem', HTTPS_PROXY: 'http://proxy:8080' });
  assert.deepStrictEqual(Object.keys(e).sort(), ['HTTPS_PROXY', 'PATH', 'npm_config_cafile', 'npm_config_https_proxy']);
});
