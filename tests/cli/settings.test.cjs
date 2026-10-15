'use strict';
// settings.test.cjs — `belay settings`, the panel's display settings (ADR 0036 amendment 1 §6).
// Drives the built CLI as a subprocess with its cwd in a temporary sandbox project (a `.git` directory
// marks the root so discovery stops there). Never the repository's own config.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const fwd = (p) => String(p).split('\\').join('/');

function project() {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-settings-')));
  fs.mkdirSync(`${dir}/.git`);
  return dir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

function cli(cwd, args, { json = true } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, ...(json ? ['--json'] : [])], { cwd, windowsHide: true, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout || r.stderr); } catch { /* text mode or usage text */ }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

const entries = (dir) => fs.readdirSync(dir).sort();

test('settings: the list names every mod.* setting with its default, source and allowed values', () => {
  const dir = project();
  try {
    const r = cli(dir, ['settings']);
    assert.strictEqual(r.code, 0);
    const by = Object.fromEntries(r.out.settings.map((s) => [s.key, s]));
    assert.deepStrictEqual(Object.keys(by).filter((k) => k.startsWith('mod.')), ['mod.pane', 'mod.marks', 'mod.cache', 'mod.context', 'mod.band', 'mod.task']);
    assert.strictEqual(by['mod.pane'].value, 'docked');
    assert.strictEqual(by['mod.marks'].value, 'shapes');
    assert.strictEqual(by['mod.cache'].value, 'both');
    assert.strictEqual(by['mod.context'].value, 'both');
    assert.strictEqual(by['mod.band'].value, 'two-lines');
    assert.deepStrictEqual(by['mod.band'].allowed, ['one-line', 'two-lines', 'minimal']);
    assert.strictEqual(by['mod.task'].value, 'kind');
    assert.deepStrictEqual(by['mod.task'].allowed, ['kind', 'title', 'off']);
    for (const s of Object.values(by)) assert.strictEqual(s.source, 'default');
    assert.strictEqual(r.out.found, false);
  } finally { cleanup(dir); }
});

test('settings: a single read, and the text form', () => {
  const dir = project();
  try {
    const r = cli(dir, ['settings', 'mod.cache']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out.key, 'mod.cache');
    assert.strictEqual(r.out.value, 'both');
    assert.deepStrictEqual(r.out.allowed, ['countdown', 'bar', 'both']);
    const t = cli(dir, ['settings', 'mod.cache'], { json: false });
    assert.match(t.stdout, /mod\.cache\s+"both"\s+\(from default\)\s+\[countdown \| bar \| both\]/);
  } finally { cleanup(dir); }
});

test('settings: read forms create no file', () => {
  const dir = project();
  try {
    const before = entries(dir);
    cli(dir, ['settings']);
    cli(dir, ['settings', 'mod.pane']);
    cli(dir, ['settings', 'mod.pane'], { json: false });
    assert.deepStrictEqual(entries(dir), before);
    assert.strictEqual(fs.existsSync(`${dir}/belay.config.json`), false);
  } finally { cleanup(dir); }
});

test('settings: a write with no config file creates belay.config.json at the project root, and the receipt proves it', () => {
  const dir = project();
  try {
    fs.mkdirSync(`${dir}/sub/deep`, { recursive: true });
    const r = cli(`${dir}/sub/deep`, ['settings', 'mod.pane', 'above-prompt']);
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(r.out, {
      key: 'mod.pane',
      old: { value: 'docked', source: 'default' },
      new: { value: 'above-prompt', source: `${dir}/belay.config.json` },
      path: `${dir}/belay.config.json`,
      created: true,
    });
    const file = fs.readFileSync(`${dir}/belay.config.json`, 'utf8');
    assert.strictEqual(file, `${JSON.stringify({ mod: { pane: 'above-prompt' } }, null, 2)}\n`);
    assert.strictEqual(entries(dir).some((n) => n.endsWith('.tmp')), false, 'a temp file was left behind');
  } finally { cleanup(dir); }
});

test('settings: write then read back; other keys and other mod keys are preserved; the old value is the previous effective one', () => {
  const dir = project();
  try {
    fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify({ data_dir: 'store', mod: { band: 'minimal', extra: 1 }, other: { a: [1, 2] } }));
    const r = cli(dir, ['settings', 'mod.band', 'one-line']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out.created, false);
    assert.deepStrictEqual(r.out.old, { value: 'minimal', source: `${dir}/belay.config.json` });
    assert.strictEqual(r.out.new.value, 'one-line');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${dir}/belay.config.json`, 'utf8')), {
      data_dir: 'store', mod: { band: 'one-line', extra: 1 }, other: { a: [1, 2] },
    });
    const back = cli(dir, ['settings', 'mod.band']);
    assert.strictEqual(back.out.value, 'one-line');
    assert.strictEqual(back.out.source, `${dir}/belay.config.json`);
    // a second key lands beside the first
    cli(dir, ['settings', 'mod.pane', 'above-prompt']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${dir}/belay.config.json`, 'utf8')).mod, { band: 'one-line', extra: 1, pane: 'above-prompt' });
  } finally { cleanup(dir); }
});

test('settings: an invalid value is exit 2 naming the allowed values and writes nothing', () => {
  const dir = project();
  try {
    const r = cli(dir, ['settings', 'mod.marks', 'emoji']);
    assert.strictEqual(r.code, 2);
    assert.match(r.out.error, /shapes, words, colour/);
    assert.strictEqual(fs.existsSync(`${dir}/belay.config.json`), false);
    const t = cli(dir, ['settings', 'mod.marks', 'emoji'], { json: false });
    assert.strictEqual(t.code, 2);
    assert.match(t.stderr, /shapes, words, colour/);
  } finally { cleanup(dir); }
});

test('settings: an unknown key is exit 2, for a read and for a write', () => {
  const dir = project();
  try {
    for (const args of [['settings', 'mod.nope'], ['settings', 'mod.nope', 'x'], ['settings', 'data_dir', 'x']]) {
      const r = cli(dir, args);
      assert.strictEqual(r.code, 2, args.join(' '));
      assert.match(r.out.error, /unknown key/);
    }
    assert.strictEqual(fs.existsSync(`${dir}/belay.config.json`), false);
  } finally { cleanup(dir); }
});

test('settings: a hand-edited invalid stored value is reported, the default is used, and belay config says so too', () => {
  const dir = project();
  try {
    fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify({ mod: { band: 'huge' } }));
    const r = cli(dir, ['settings', 'mod.band']);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out.value, 'two-lines');
    assert.strictEqual(r.out.source, 'default');
    assert.strictEqual(r.out.invalid.stored, 'huge');
    assert.match(r.out.invalid.reason, /"huge" is not one of one-line, two-lines, minimal/);
    const list = cli(dir, ['settings']);
    assert.strictEqual(list.out.settings.find((s) => s.key === 'mod.band').invalid.stored, 'huge');
    const c = cli(dir, ['config', 'get', 'mod.band']);
    assert.strictEqual(c.out.value, 'two-lines');
    assert.strictEqual(c.out.invalid.stored, 'huge');
    const t = cli(dir, ['config', 'get', 'mod.band'], { json: false });
    assert.match(t.stdout, /warning: mod\.band: "huge" is not one of/);
    // writing a valid value repairs it
    const w = cli(dir, ['settings', 'mod.band', 'minimal']);
    assert.strictEqual(w.code, 0);
    assert.strictEqual(w.out.old.source, 'default');
    assert.strictEqual(w.out.old.invalid.stored, 'huge');
    assert.match(w.out.old.invalid.reason, /"huge" is not one of/);
    assert.strictEqual(cli(dir, ['settings', 'mod.band']).out.value, 'minimal');
  } finally { cleanup(dir); }
});

test('settings: a config file that does not parse is never overwritten', () => {
  const dir = project();
  try {
    fs.writeFileSync(`${dir}/belay.config.json`, '{ not json');
    const r = cli(dir, ['settings', 'mod.pane', 'docked']);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(fs.readFileSync(`${dir}/belay.config.json`, 'utf8'), '{ not json');
  } finally { cleanup(dir); }
});

test('config: get mod.band and the plain listing show the settings with their source', () => {
  const dir = project();
  try {
    const g = cli(dir, ['config', 'get', 'mod.band']);
    assert.strictEqual(g.code, 0);
    assert.strictEqual(g.out.key, 'mod.band');
    assert.strictEqual(g.out.value, 'two-lines');
    assert.strictEqual(g.out.source, 'default');
    assert.deepStrictEqual(g.out.allowed, ['one-line', 'two-lines', 'minimal']);
    fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify({ mod: { band: 'minimal' } }));
    const g2 = cli(dir, ['config', 'get', 'mod.band']);
    assert.strictEqual(g2.out.value, 'minimal');
    assert.strictEqual(g2.out.source, `${dir}/belay.config.json`);
    const all = cli(dir, ['config']);
    assert.strictEqual(all.out.values['mod.band'].value, 'minimal');
    assert.strictEqual(all.out.values['mod.pane'].source, 'default');
  } finally { cleanup(dir); }
});

// In-process tests through the module's seams: they make a rename fail, change the file mid-write, or
// make the read-back disagree, none of which a subprocess can do.
const settings = require('../../src/cli/cmd-settings.cjs');
const realSeams = { ...settings.seams };
const inproc = async (cwd, argv) => settings.run({ argv, cwd, json: true });
const resetSeams = () => Object.assign(settings.seams, realSeams);

// The cwd may be spelled with another case than os.homedir() on Windows (VS Code, Git Bash).
const spellings = {
  'as homedir spells it': (h) => h,
  'drive letter lower-cased': (h) => h.replace(/^[A-Za-z]:/, (d) => d.toLowerCase()),
  'whole path lower-cased': (h) => h.toLowerCase(),
};
for (const [label, spell] of Object.entries(spellings)) {
  test(`settings: with no project root above the cwd (the home directory, ${label}) a write is refused and creates nothing`, { skip: label !== 'as homedir spells it' && process.platform !== 'win32' }, () => {
    const home = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-fakehome-')));
    try {
      const r = spawnSync(process.execPath, [CLI, 'settings', 'mod.pane', 'above-prompt', '--json'], {
        cwd: spell(home), windowsHide: true, encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home },
      });
      assert.strictEqual(r.status, 1, r.stdout + r.stderr);
      const out = JSON.parse(r.stderr);
      assert.strictEqual(out.written, false);
      assert.match(out.error, /never read/);
      assert.deepStrictEqual(fs.readdirSync(home), [], 'a file was created');
    } finally { cleanup(home); }
  });
}

test('settings: a rename that fails leaves no temp file, no config, and an error receipt', async () => {
  const dir = project();
  try {
    settings.seams.rename = () => { throw new Error('rename refused'); };
    const r = await inproc(dir, ['mod.pane', 'above-prompt']);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.json.written, false);
    assert.match(r.json.error, /rename refused/);
    assert.deepStrictEqual(entries(dir), ['.git'], 'a temp or config file was left behind');
  } finally { resetSeams(); cleanup(dir); }
});

test('settings: a file that changes between the read and the rename is a conflict, left untouched', async () => {
  const dir = project();
  try {
    fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify({ mod: { band: 'minimal' } }));
    const theirs = JSON.stringify({ mod: { band: 'minimal' }, theirs: true });
    settings.seams.beforeRename = (file) => fs.writeFileSync(file, theirs);
    const r = await inproc(dir, ['mod.pane', 'above-prompt']);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.json.written, false);
    assert.match(r.json.error, /changed while it was being updated/);
    assert.strictEqual(fs.readFileSync(`${dir}/belay.config.json`, 'utf8'), theirs);
    assert.deepStrictEqual(entries(dir), ['.git', 'belay.config.json']);
  } finally { resetSeams(); cleanup(dir); }
});

test('settings: a file that appears while one was to be created is a conflict', async () => {
  const dir = project();
  try {
    settings.seams.beforeRename = (file) => fs.writeFileSync(file, '{}');
    const r = await inproc(dir, ['mod.pane', 'above-prompt']);
    assert.strictEqual(r.code, 1);
    assert.match(r.json.error, /changed while/);
    assert.strictEqual(fs.readFileSync(`${dir}/belay.config.json`, 'utf8'), '{}');
  } finally { resetSeams(); cleanup(dir); }
});

test('settings: the receipt is the read-back, and a read-back that disagrees is an error that says the file was written', async () => {
  const dir = project();
  try {
    const file = `${dir}/belay.config.json`;
    settings.seams.discover = (cwd) => {
      const f = realSeams.discover(cwd);
      return { ...f, config: { mod: { pane: 'docked' } } };
    };
    const r = await inproc(dir, ['mod.pane', 'above-prompt']);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(r.json.written, true);
    assert.strictEqual(r.json.path, file);
    assert.match(r.json.error, /reading it back gave "docked"/);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mod.pane, 'above-prompt', 'the disk has the new value');
  } finally { resetSeams(); cleanup(dir); }
});

test('config: --data spelled in another case than the cwd still overrides a config that names another data_dir', { skip: process.platform !== 'win32' }, () => {
  const dir = project();
  try {
    fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify({ data_dir: 'store' }));
    const spelled = `${dir}/.belay`.replace(/^[A-Za-z]:/, (d) => d.toLowerCase());
    const r = spawnSync(process.execPath, [CLI, 'config', 'get', 'data_dir', '--data', spelled, '--json'], { cwd: dir, windowsHide: true, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.source, '--data');
    assert.strictEqual(out.resolved, spelled);
  } finally { cleanup(dir); }
});

for (const [label, spell] of [['absolute', (d) => `${d}/.belay`], ['relative', () => './.belay']]) {
  test(`config: --data spelled exactly as the default (${label}) wins over a config data_dir`, () => {
    const dir = project();
    try {
      fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify({ data_dir: 'store' }));
      const r = spawnSync(process.execPath, [CLI, 'config', 'get', 'data_dir', '--data', spell(dir), '--json'], { cwd: dir, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.source, '--data');
      assert.strictEqual(out.resolved, `${dir}/.belay`);
      const none = spawnSync(process.execPath, [CLI, 'config', 'get', 'data_dir', '--json'], { cwd: dir, windowsHide: true, encoding: 'utf8' });
      assert.strictEqual(JSON.parse(none.stdout).resolved, `${dir}/store`, 'without --data the config still wins');
    } finally { cleanup(dir); }
  });
}

for (const [label, spell] of Object.entries(spellings)) {
  test(`init: run from the home directory (${label}) is refused and writes nothing`, { skip: label !== 'as homedir spells it' && process.platform !== 'win32' }, () => {
    const home = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-fakehome-')));
    try {
      const r = spawnSync(process.execPath, [CLI, 'init', '--json'], {
        cwd: spell(home), windowsHide: true, encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home },
      });
      assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stderr + r.stdout, /never read/);
      assert.deepStrictEqual(fs.readdirSync(home), [], 'init created something in the home directory');
    } finally { cleanup(home); }
  });
}

test('init: run from the home directory spelled by its 8.3 short name is refused and writes nothing', { skip: process.platform !== 'win32' }, () => {
  const home = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'rv-home-')));
  try {
    const short = fwd(spawnSync(`for %I in ("${path.normalize(home)}") do @echo %~sI`, { shell: true, encoding: 'utf8' }).stdout.trim());
    assert.ok(fs.existsSync(short), `the short name must resolve: ${short}`);
    if (!short || short.toLowerCase() === home.toLowerCase()) return void process.stderr.write('# skipped: 8.3 names are disabled on this volume\n');
    const r = spawnSync(process.execPath, [CLI, 'init', '--json'], {
      cwd: short, windowsHide: true, encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home },
    });
    assert.notStrictEqual(r.status, 0, r.stdout + r.stderr);
    assert.deepStrictEqual(fs.readdirSync(home), [], 'init created something in the home directory');
  } finally { cleanup(home); }
});

// A junction is a link to a directory; on Windows it needs no privilege.
function junction(target, link) { fs.symlinkSync(target, link, 'junction'); }
const runCli = (cwd, home, args) => spawnSync(process.execPath, [CLI, ...args, '--json'], {
  cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home },
});

test('config: a project outside home reached through a junction into home still finds its config, and init writes at the project', { skip: process.platform !== 'win32' }, () => {
  const base = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-junc-')));
  try {
    const home = `${base}/home`;
    const root = `${base}/R`;
    fs.mkdirSync(`${home}/shared`, { recursive: true });
    fs.mkdirSync(`${root}/.git`, { recursive: true });
    fs.mkdirSync(`${root}/src`);
    fs.writeFileSync(`${root}/belay.config.json`, JSON.stringify({ data_dir: 'store' }));
    junction(`${home}/shared`, `${root}/src/link`);
    const g = runCli(`${root}/src/link`, home, ['config', 'get', 'data_dir']);
    assert.strictEqual(g.status, 0, g.stderr);
    assert.strictEqual(JSON.parse(g.stdout).source, `${root}/belay.config.json`);
    assert.strictEqual(JSON.parse(g.stdout).resolved, `${root}/store`);
    const r = runCli(`${root}/src/link`, home, ['init']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(fs.readdirSync(`${home}/shared`), [], 'init wrote into home through the junction');
  } finally { cleanup(base); }
});

test('init: run from a junction to the home directory is refused and writes nothing', { skip: process.platform !== 'win32' }, () => {
  const base = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-junc-')));
  try {
    const home = `${base}/home`;
    fs.mkdirSync(home);
    junction(home, `${base}/J`);
    const r = runCli(`${base}/J`, home, ['init']);
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.deepStrictEqual(fs.readdirSync(home), [], 'init wrote into home through the junction');
  } finally { cleanup(base); }
});

test('settings: mod.task takes kind, title and off, refuses anything else, and reads back what it wrote', () => {
  const dir = project();
  try {
    for (const v of ['title', 'off', 'kind']) {
      const w = cli(dir, ['settings', 'mod.task', v]);
      assert.strictEqual(w.code, 0);
      assert.strictEqual(w.out.new.value, v);
      assert.strictEqual(cli(dir, ['settings', 'mod.task']).out.value, v);
    }
    const bad = cli(dir, ['settings', 'mod.task', 'words']);
    assert.strictEqual(bad.code, 2);
    assert.strictEqual(cli(dir, ['settings', 'mod.task']).out.value, 'kind');
  } finally { cleanup(dir); }
});
