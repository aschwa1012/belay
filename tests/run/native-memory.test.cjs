'use strict';
// native-memory.test.cjs — ADR 0024 amendment 3 (proposed): the eval-only native_memory spawn lever. Settings with and without it,
// checkSurface's exact-equality accept and every reject, and a relaunch keeping the folder. Driven over the fake executable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('../../src/run/surface.cjs');
const L = require('../../src/run/launch.cjs');
const LC = require('../../src/run/lifecycle.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => String(p).replace(/\\/g, '/');
const DIR = 'C:/eval/mem-arm';

const okReady = (memory_paths) => ({
  tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'mcp__belay__task_get'], plugins: [], ...(memory_paths === undefined ? {} : { memory_paths }),
});

test('settings: off by default, auto-memory stays disabled and no directory is named', () => {
  const h = S.hygieneSettings('C:/a/wt');
  assert.equal(h.autoMemoryEnabled, false);
  assert.equal('autoMemoryDirectory' in h, false);
  assert.equal(S.hygieneSettings('C:/a/wt', { nativeMemory: null }).autoMemoryEnabled, false);
  assert.equal('autoMemoryDirectory' in L.workerSettings([], { cwd: 'C:/a/wt' }), false);
});

test('settings: with the lever on, auto-memory is enabled in that folder and dream stays off', () => {
  const h = S.hygieneSettings('C:/a/wt', { nativeMemory: 'C:\\eval\\mem-arm' });
  assert.equal(h.autoMemoryEnabled, true);
  assert.equal(h.autoMemoryDirectory, DIR);
  assert.equal(h.autoDreamEnabled, false);
  assert.deepStrictEqual(h.claudeMdExcludes, S.ancestorExcludes('C:/a/wt'));
});

test('settings: a relative, empty or non-string folder is refused E_ARGS', () => {
  for (const bad of ['rel/dir', '', 7, 'C:foo', 'mem\u0000x']) {
    assert.throws(() => S.hygieneSettings('C:/a/wt', { nativeMemory: bad }), (e) => e.code === 'E_ARGS', String(bad));
  }
});

test('writeWorkerFiles: creates the folder and writes it into settings.json; without the lever neither happens', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nm-'));
  try {
    const mem = fwd(path.join(d, 'a', 'mem'));
    const base = { workerId: 'w', runId: 'r', dataDir: fwd(d), mcpPath: 'x.cjs', settingsPath: path.join(d, 'none.json'), cwd: fwd(path.join(d, 'wt')) };
    const off = L.writeWorkerFiles({ ...base, dir: path.join(d, 'off') });
    const offSettings = JSON.parse(fs.readFileSync(off.settingsPath, 'utf8'));
    assert.equal(offSettings.autoMemoryEnabled, false);
    assert.equal('autoMemoryDirectory' in offSettings, false);
    assert.equal(fs.existsSync(mem), false);
    const on = L.writeWorkerFiles({ ...base, dir: path.join(d, 'on'), nativeMemory: mem });
    const onSettings = JSON.parse(fs.readFileSync(on.settingsPath, 'utf8'));
    assert.equal(onSettings.autoMemoryEnabled, true);
    assert.equal(onSettings.autoMemoryDirectory, mem);
    assert.ok(fs.statSync(mem).isDirectory());
  } finally { cleanup(d); }
});

test('checkSurface: accepts memory_paths only on exact equality, separators, case and a trailing slash aside', () => {
  for (const auto of [DIR, 'C:\\eval\\mem-arm', 'c:/EVAL/mem-arm/', 'C:/eval/mem-arm//']) {
    const r = S.checkSurface(okReady({ auto }), { nativeMemory: DIR });
    assert.equal(r.ok, true, auto + ': ' + r.reason);
  }
});

test('checkSurface: refuses absent, a different folder, extra keys and non-objects when native memory was requested', () => {
  const cases = [
    [undefined, /absent/], [null, /absent/], [{}, /exactly/], [{ auto: 'D:/home/x/.claude/projects/p/memory' }, /asked for/],
    [{ auto: DIR + '2' }, /asked for/], [{ auto: '' }, /asked for/], [{ auto: DIR, project: 'p' }, /exactly/],
    [{ project: DIR }, /exactly/], [DIR, /absent/], [[DIR], /absent/],
  ];
  for (const [mp, re] of cases) {
    const r = S.checkSurface(okReady(mp), { nativeMemory: DIR });
    assert.equal(r.ok, false, JSON.stringify(mp));
    assert.match(r.reason, re, JSON.stringify(mp) + ': ' + r.reason);
  }
});

test('checkSurface: memory_paths still refused when native memory was not requested', () => {
  assert.equal(S.checkSurface(okReady(), {}).ok, true);
  assert.equal(S.checkSurface(okReady(), { nativeMemory: null }).ok, true);
  for (const mp of [{ auto: DIR }, {}, { project: 'x' }, 'x']) {
    assert.equal(S.checkSurface(okReady(mp), {}).ok, false, JSON.stringify(mp));
  }
});

// ------------------------------------------------------------- over the fake executable

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nm-run-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { d, data: fwd(d), worktree: fwd(path.join(d, 'wt')), mem: fwd(path.join(d, 'mem')) };
}
const mgr = (sb, core) => createRunManager({
  core, dataDir: sb.data, runId: 'run-nm',
  paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
});
const settingsOf = (sb, id) => JSON.parse(fs.readFileSync(path.join(L.workerDir(sb.data, id), 'settings.json'), 'utf8'));

test('spawn: native_memory launches when the init reports exactly that folder, and a restart keeps it', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core);
  process.env.FAKE_MEMORY_AUTO = 'echo';
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-nm', native_memory: sb.mem });
    assert.equal(row.state, 'running');
    assert.ok(fs.statSync(sb.mem).isDirectory(), 'created if missing');
    assert.equal(settingsOf(sb, 'w-nm').autoMemoryDirectory, sb.mem);
    const again = await m.restart({ worker_id: 'w-nm' });
    assert.match(again.surface.tools_hash, /^[0-9a-f]{64}$/, 'the relaunch passes the same exact-equality check');
    assert.equal(settingsOf(sb, 'w-nm').autoMemoryDirectory, sb.mem);
    assert.equal(settingsOf(sb, 'w-nm').autoMemoryEnabled, true);
    // the lever is recorded on the worker row, and the worker's own files are not read back for it
    assert.equal(core.currentWorker('w-nm').native_memory, sb.mem);
    assert.equal('nativeMemory' in LC.readLaunchOptions(L.workerDir(sb.data, 'w-nm')), false);
  } finally { delete process.env.FAKE_MEMORY_AUTO; await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
});

test('spawn: native_memory fails the launch when the init reports another folder or none', async () => {
  for (const reported of ['C:/fake/other', null]) {
    const sb = sandbox(); const m = mgr(sb, createFakeCore());
    if (reported) process.env.FAKE_MEMORY_AUTO = reported; else delete process.env.FAKE_MEMORY_AUTO;
    try {
      await assert.rejects(() => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-nm-bad', native_memory: sb.mem }),
        (e) => e.code === 'E_NO_READY' && /memory_paths/.test(e.detail.reason));
    } finally { delete process.env.FAKE_MEMORY_AUTO; await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
  }
});

test('spawn: without native_memory a reported memory_paths still fails, and the argument is validated', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core);
  try {
    process.env.FAKE_MEMORY_AUTO = 'C:/fake/mem';
    await assert.rejects(() => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-nm-off' }), (e) => e.code === 'E_NO_READY');
    delete process.env.FAKE_MEMORY_AUTO;
    // Refused before any row or file (ADR 0030 decision 4): no worker directory, no row, no folder.
    const home = fwd(path.join(os.homedir(), '.claude', 'projects', 'C--eval-git-root', 'memory'));
    const refused = [['w-nm-rel', 'relative', 'E_ARGS', 'claude-code'], ['w-nm-home', home, 'E_ARGS', 'claude-code'], ['w-nm-codex', sb.mem, 'E_SUBSTRATE', 'codex']];
    for (const [id, native_memory, code, substrate] of refused) {
      await assert.rejects(() => m.spawn({ substrate, worktree: sb.worktree, prompt: 'hi', worker_id: id, native_memory }), (e) => e.code === code, id);
      assert.equal(fs.existsSync(L.workerDir(sb.data, id)), false, id + ': no worker directory');
      assert.deepStrictEqual(core.rowsFor(id), [], id + ': no worker row');
    }
    assert.equal(fs.existsSync(sb.mem), false, 'a refused spawn creates no folder');
  } finally { delete process.env.FAKE_MEMORY_AUTO; await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
});

test('checkNativeMemory: refuses Claude Code config directories, the default memory folder among them, and accepts a sibling', () => {
  const home = fwd(os.homedir());
  const cfg = fwd(path.join(os.tmpdir(), 'cfg-dir'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const refused = [
      home + '/.claude', home + '/.claude/', home + '/.claude/projects/C--eval-git-root/memory', (home + '/.claude/projects/x/memory').toUpperCase(),
      home.split('/').join('\\') + '\\.claude\\projects\\x\\memory', home + '/.claude/../.claude/projects/x', cfg, cfg + '/projects/p/memory',
    ];
    for (const bad of refused) assert.throws(() => S.checkNativeMemory(bad), (e) => e.code === 'E_ARGS' && e.detail.reason === 'claude_config_dir', bad);
    for (const good of [home + '/.claudex/mem', home + '/.claude-eval/mem', cfg + '-other/mem', DIR]) assert.equal(S.checkNativeMemory(good), good, good);
    assert.throws(() => S.hygieneSettings('C:/a/wt', { nativeMemory: home + '/.claude/projects/p/memory' }), (e) => e.code === 'E_ARGS');
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
});

const WIN = process.platform === 'win32';
const winOnly = WIN ? {} : { skip: 'Windows path semantics (drive roots, trailing dots, UNC, device prefixes)' };

test('checkNativeMemory: Windows spellings of the config directory are refused, the resolved form is returned', winOnly, () => {
  const home = fwd(os.homedir()); const noDrive = home.replace(/^[A-Za-z]:/, ''); const drive = home.slice(0, 2);
  const refused = [
    noDrive + '/.claude/projects/x/memory', // posix-rooted, resolves onto the current drive
    home + '/.claude./projects/x/memory', home + '/.claude /projects/x/memory', home + '/.claude.. /projects/x/memory',
    '//localhost/' + drive[0] + '$' + noDrive + '/.claude/projects/x/memory', // UNC to the same disk
    '//?/' + home + '/.claude/projects/x/memory', '//./' + home + '/.claude/projects/x/memory', // device prefixes
    home + '/.claude/projects/x/memory:stream', home + '/x/.. /y',
  ];
  for (const bad of refused) assert.throws(() => S.checkNativeMemory(bad), (e) => e.code === 'E_ARGS', bad);
  assert.equal(S.checkNativeMemory(home + '/.claudex./mem/'), home + '/.claudex/mem', 'trailing dots are stripped, then resolved');
  assert.equal(S.checkNativeMemory('C:\\eval\\.\\a\\..\\mem-arm\\'), DIR);
});

test('writeWorkerFiles: a folder in the config directory is refused before anything is created there', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nm-cfg-')); const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    const cfg = fwd(path.join(d, 'cfg')); fs.mkdirSync(cfg);
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const base = { workerId: 'w', runId: 'r', dataDir: fwd(d), mcpPath: 'x.cjs', settingsPath: path.join(d, 'none.json'), cwd: fwd(path.join(d, 'wt')), dir: path.join(d, 'w') };
    assert.throws(() => L.writeWorkerFiles({ ...base, nativeMemory: cfg + '/projects/x/memory' }), (e) => e.code === 'E_ARGS');
    assert.deepStrictEqual(fs.readdirSync(cfg), [], 'nothing was created in the config directory');
    assert.equal(fs.existsSync(path.join(d, 'w')), false, 'no worker files either');
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; cleanup(d); }
});

test('writeWorkerFiles: a junction into the config directory is refused, before and after the folder is created', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nm-junc-')); const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    const cfg = path.join(d, 'fake-config'); fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
    const junc = path.join(d, 'junc'); fs.symlinkSync(cfg, junc, 'junction');
    process.env.CLAUDE_CONFIG_DIR = fwd(cfg);
    const base = { workerId: 'w', runId: 'r', dataDir: fwd(d), mcpPath: 'x.cjs', settingsPath: path.join(d, 'none.json'), cwd: fwd(path.join(d, 'wt')), dir: path.join(d, 'w') };
    for (const target of [fwd(junc) + '/projects/p/memory', fwd(junc)]) {
      assert.throws(() => L.writeWorkerFiles({ ...base, nativeMemory: target }), (e) => e.code === 'E_ARGS' && e.detail.reason === 'claude_config_dir', target);
    }
    assert.deepStrictEqual(fs.readdirSync(path.join(cfg, 'projects')), [], 'nothing was created through the junction');
    const NMOD = require('../../src/run/native-memory.cjs');
    assert.throws(() => NMOD.assertOutsideConfig(fwd(junc) + '/projects'), (e) => e.code === 'E_ARGS', 'the post-create check refuses a folder that is already there');
    assert.doesNotThrow(() => NMOD.assertOutsideConfig(fwd(path.join(d, 'elsewhere', 'mem'))));
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; cleanup(d); }
});

test('readLaunchOptions: nothing is recovered from the worker-writable settings.json', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nm-rb-'));
  try {
    fs.writeFileSync(path.join(d, 'argv.json'), JSON.stringify({ spec: { args: [] } }));
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ autoMemoryEnabled: true, autoMemoryDirectory: fwd(path.join(d, 'mem')) }));
    const r = LC.readLaunchOptions(d);
    assert.equal('nativeMemory' in r, false);
    assert.notEqual(r.error && r.error.where, 'settings.json');
  } finally { cleanup(d); }
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
const cfgWith = (d) => { const cfg = path.join(d, 'fake-config'); fs.mkdirSync(path.join(cfg, 'projects', 'p', 'memory'), { recursive: true }); return cfg; };

test('adopt: a second manager restarting a worker whose settings.json was edited regenerates it from the record, and memory stays off', async () => {
  for (const edit of [(st, sb) => ({ ...st, autoMemoryEnabled: true, autoMemoryDirectory: sb.mem }), (st) => ({ ...st, autoMemoryDirectory: 'C:/elsewhere' }), () => 'not json']) {
    const sb = sandbox(); const core = createFakeCore(); const first = mgr(sb, core); let second = null;
    try {
      await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-plant' });
      assert.equal(core.currentWorker('w-plant').native_memory, null);
      await first.stop({ worker_id: 'w-plant', mode: 'kill', timeout_ms: 8000 });
      const file = path.join(L.workerDir(sb.data, 'w-plant'), 'settings.json');
      const planted = edit(settingsOf(sb, 'w-plant'), sb);
      fs.writeFileSync(file, typeof planted === 'string' ? planted : JSON.stringify(planted));
      second = mgr(sb, core);
      const r = await second.restart({ worker_id: 'w-plant', first_turn_timeout_ms: 45000 });
      assert.match(r.surface.tools_hash, /^[0-9a-f]{64}$/);
      const now = settingsOf(sb, 'w-plant');
      assert.equal(now.autoMemoryEnabled, false, 'regenerated from the record');
      assert.equal('autoMemoryDirectory' in now, false);
      assert.equal(fs.existsSync(sb.mem), false, 'the planted folder was never created');
      assert.equal(core.currentWorker('w-plant').native_memory, null, 'the record still says off');
    } finally { delete process.env.FAKE_MEMORY_AUTO; if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); cleanup(sb.d); }
  }
});

test('adopt: a second manager stops a live worker whose settings.json was edited, and the pid goes', async () => {
  const sb = sandbox(); const core = createFakeCore(); const first = mgr(sb, core); let second = null;
  try {
    const row = await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-stop' });
    const file = path.join(L.workerDir(sb.data, 'w-stop'), 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ ...settingsOf(sb, 'w-stop'), autoMemoryEnabled: true, autoMemoryDirectory: sb.mem }));
    second = mgr(sb, core);
    assert.ok(alive(row.pid));
    await second.stop({ worker_id: 'w-stop', mode: 'graceful', timeout_ms: 8000 });
    for (let i = 0; i < 100 && alive(row.pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(row.pid), false, 'a stop always goes through');
    assert.notEqual(core.currentWorker('w-stop').death_established_by, 'native_memory_settings_mismatch', 'a stop is not rewritten as a mismatch death');
  } finally { if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('relaunch: the same manager refuses a settings.json that is not what it wrote, launches nothing, and confirms the dead row', async () => {
  const edits = [
    ['lever on', (st, sb) => ({ ...st, autoMemoryEnabled: true, autoMemoryDirectory: sb.mem }), false],
    ['other folder', (st) => ({ ...st, autoMemoryDirectory: 'C:/elsewhere' }), true],
    ['unreadable', () => 'not json', false],
    ['an extra key the record does not cover', (st) => ({ ...st, autoDreamEnabled: true }), false],
    ['claudeMdExcludes emptied', (st) => ({ ...st, claudeMdExcludes: [] }), true],
  ];
  for (const [name, edit, withLever] of edits) {
    const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const id = 'w-same';
    if (withLever) process.env.FAKE_MEMORY_AUTO = 'echo';
    try {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id, ...(withLever ? { native_memory: sb.mem } : {}) });
      await m.stop({ worker_id: id, mode: 'kill', timeout_ms: 8000 });
      const launches = m._worker(id).launches;
      const planted = edit(settingsOf(sb, id), sb);
      fs.writeFileSync(path.join(L.workerDir(sb.data, id), 'settings.json'), typeof planted === 'string' ? planted : JSON.stringify(planted));
      let err = null;
      try { await m.restart({ worker_id: id, first_turn_timeout_ms: 45000 }); } catch (e) { err = e; }
      assert.ok(err && err.code === 'E_NATIVE_MEMORY_MISMATCH', name + ': ' + (err && err.code));
      assert.equal(m._worker(id).launches, launches, name + ': nothing was launched');
      if (name === 'lever on' || name === 'other folder') assert.ok('recorded' in err.detail && 'found' in err.detail, name + ': names the recorded and found values');
      if (name.startsWith('an extra key') || name.startsWith('claudeMd')) assert.equal(err.detail.reason, 'settings_changed', name);
      const cur = core.currentWorker(id);
      assert.equal(cur.state, 'dead', name);
      assert.equal(cur.death_established_by, 'native_memory_settings_mismatch', name);
      assert.equal(err.detail.dead_row.seq, cur.seq, name + ': the error carries the row that was written, already confirmed');
      assert.equal(err.detail.dead_row.state, 'dead');
    } finally { delete process.env.FAKE_MEMORY_AUTO; await m.shutdown().catch(() => {}); cleanup(sb.d); }
  }
});

test('relaunch: a folder swapped for a junction into the config directory after the spawn is refused by the same manager', { skip: process.platform === 'win32' ? false : 'junctions' }, async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.FAKE_MEMORY_AUTO = 'echo';
  try {
    const cfg = cfgWith(sb.d); const secret = path.join(cfg, 'projects', 'p', 'memory');
    fs.writeFileSync(path.join(secret, 'MEMORY.md'), 'operator secret');
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-junc', native_memory: sb.mem });
    process.env.CLAUDE_CONFIG_DIR = fwd(cfg);
    await m.stop({ worker_id: 'w-junc', mode: 'kill', timeout_ms: 8000 });
    fs.rmSync(sb.mem, { recursive: true, force: true }); fs.symlinkSync(secret, sb.mem, 'junction');
    const launches = m._worker('w-junc').launches;
    for (const verb of [() => m.restart({ worker_id: 'w-junc', first_turn_timeout_ms: 45000 })]) {
      await assert.rejects(verb, (e) => e.code === 'E_ARGS' && e.detail.reason === 'claude_config_dir');
    }
    assert.equal(m._worker('w-junc').launches, launches, 'nothing was launched');
    const cur = core.currentWorker('w-junc');
    assert.equal(cur.state, 'dead'); assert.equal(cur.death_established_by, 'native_memory_folder_refused');
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; delete process.env.FAKE_MEMORY_AUTO; await m.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('prepareFolder: the check after the create refuses a folder swapped for a junction between the first check and the create', { skip: process.platform === 'win32' ? false : 'junctions' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nm-race-')); const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    const cfg = cfgWith(d); process.env.CLAUDE_CONFIG_DIR = fwd(cfg);
    const NMOD = require('../../src/run/native-memory.cjs'); const mem = fwd(path.join(d, 'mem'));
    assert.equal(NMOD.prepareFolder(mem), mem, 'no swap: created');
    fs.rmSync(mem, { recursive: true });
    assert.throws(() => NMOD.prepareFolder(mem, { beforeMkdir: (folder) => fs.symlinkSync(path.join(cfg, 'projects', 'p', 'memory'), folder, 'junction') }),
      (e) => e.code === 'E_ARGS' && e.detail.reason === 'claude_config_dir');
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; cleanup(d); }
});

test('assertOutsideConfig: a dangling junction is refused, not judged by its parent', { skip: process.platform === 'win32' ? false : 'junctions' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nm-dang-'));
  try {
    const target = path.join(d, 'gone'); fs.mkdirSync(target);
    const link = path.join(d, 'link'); fs.symlinkSync(target, link, 'junction'); fs.rmdirSync(target);
    const NMOD = require('../../src/run/native-memory.cjs');
    for (const p of [fwd(link), fwd(link) + '/sub/mem']) {
      assert.throws(() => NMOD.assertOutsideConfig(p), (e) => e.code === 'E_ARGS' && e.detail.reason === 'unresolvable_link', p);
    }
    assert.doesNotThrow(() => NMOD.assertOutsideConfig(fwd(path.join(d, 'plain', 'mem'))), 'a plain missing folder is still fine');
  } finally { cleanup(d); }
});

test('spawn: a junction into the config directory is refused with nothing created and the id free', { skip: process.platform === 'win32' ? false : 'junctions' }, async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    const cfg = cfgWith(sb.d); process.env.CLAUDE_CONFIG_DIR = fwd(cfg);
    fs.symlinkSync(path.join(cfg, 'projects', 'p', 'memory'), sb.mem, 'junction');
    await assert.rejects(() => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-jspawn', native_memory: sb.mem }), (e) => e.code === 'E_ARGS' && e.detail.reason === 'claude_config_dir');
    assert.equal(fs.existsSync(L.workerDir(sb.data, 'w-jspawn')), false, 'no worker directory');
    assert.deepStrictEqual(core.rowsFor('w-jspawn'), [], 'no worker row');
    fs.unlinkSync(sb.mem);
    process.env.FAKE_MEMORY_AUTO = 'echo';
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-jspawn', native_memory: sb.mem });
    assert.equal(row.state, 'running', 'the same id spawns once the folder is fine');
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; delete process.env.FAKE_MEMORY_AUTO; await m.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('settings: with the lever off the file is byte-identical to what it was before the lever existed', () => {
  const wt = 'C:/a/wt';
  const before = JSON.stringify({ claudeMdExcludes: S.ancestorExcludes(wt), autoMemoryEnabled: false, autoDreamEnabled: false });
  assert.equal(JSON.stringify(S.hygieneSettings(wt)), before);
  assert.equal(JSON.stringify(S.hygieneSettings(wt, { nativeMemory: null })), before);
  assert.deepStrictEqual(Object.keys(S.hygieneSettings(wt, { nativeMemory: DIR })), ['claudeMdExcludes', 'autoMemoryEnabled', 'autoDreamEnabled', 'autoMemoryDirectory']);
});

test('adopt: a second manager relaunching the worker keeps the folder in settings.json and passes the gate', async () => {
  const sb = sandbox(); const core = createFakeCore();
  const first = mgr(sb, core); let second = null;
  process.env.FAKE_MEMORY_AUTO = 'echo';
  try {
    await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-nm-adopt', native_memory: sb.mem });
    await first.stop({ worker_id: 'w-nm-adopt', mode: 'kill', timeout_ms: 8000 });
    second = mgr(sb, core);
    const r = await second.restart({ worker_id: 'w-nm-adopt', first_turn_timeout_ms: 45000 });
    assert.match(r.surface.tools_hash, /^[0-9a-f]{64}$/);
    assert.equal(second._worker('w-nm-adopt').nativeMemory, sb.mem, 'the adopted record carries the folder');
    assert.equal(settingsOf(sb, 'w-nm-adopt').autoMemoryEnabled, true);
    assert.equal(settingsOf(sb, 'w-nm-adopt').autoMemoryDirectory, sb.mem);
  } finally { delete process.env.FAKE_MEMORY_AUTO; if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('worker_spawn: native_memory is harness-only, refused at the MCP boundary and absent from the listing', () => {
  const T = require('../../src/mcp/tools.cjs');
  assert.deepStrictEqual(T.HARNESS_ONLY.worker_spawn, ['native_memory']);
  for (const role of ['orchestrator']) {
    const spawnTool = T.toolsFor(role).find((t) => t.name === 'worker_spawn');
    assert.equal('native_memory' in spawnTool.inputSchema.properties, false, 'not listed, so it costs the listing no bytes');
  }
  assert.throws(() => T.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: 'C:/w', prompt: 'p', native_memory: 'C:/eval/mem' }),
    (e) => e.code === 'E_ARGS' && e.detail.reason === 'harness_only' && e.detail.field === 'native_memory');
  assert.doesNotThrow(() => T.validateArgs('worker_spawn', { substrate: 'claude-code', worktree: 'C:/w', prompt: 'p' }));
});

test('assertOutsideConfig: a config directory reached through a junction refuses a folder named by its real path', { skip: process.platform === 'win32' ? false : 'junctions' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nm-cfgj-')); const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    const cfg = cfgWith(d); const junc = path.join(d, 'cfg-link'); fs.symlinkSync(cfg, junc, 'junction');
    process.env.CLAUDE_CONFIG_DIR = fwd(junc);
    const NMOD = require('../../src/run/native-memory.cjs');
    const real = fwd(fs.realpathSync.native(cfg));
    for (const target of [real + '/projects/p/memory', real + '/new-below-target']) {
      assert.throws(() => NMOD.assertOutsideConfig(target), (e) => e.code === 'E_ARGS' && e.detail.reason === 'claude_config_dir', target);
    }
    assert.doesNotThrow(() => NMOD.assertOutsideConfig(fwd(path.join(d, 'elsewhere', 'mem'))));
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; cleanup(d); }
});

test('relaunch: after a refusal the restored settings.json launches again and reports a running worker, not a false dead pid', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const id = 'w-reset';
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id });
    await m.stop({ worker_id: id, mode: 'kill', timeout_ms: 8000 });
    const file = path.join(L.workerDir(sb.data, id), 'settings.json'); const good = fs.readFileSync(file);
    fs.writeFileSync(file, JSON.stringify({ ...settingsOf(sb, id), autoDreamEnabled: true }));
    await assert.rejects(m.restart({ worker_id: id, first_turn_timeout_ms: 45000 }), (e) => e.code === 'E_NATIVE_MEMORY_MISMATCH');
    assert.equal(m._worker(id).launchFailed, true);
    fs.writeFileSync(file, good);
    const again = await m.restart({ worker_id: id, first_turn_timeout_ms: 45000 });
    assert.equal(m._worker(id).launchFailed, false, 'the refusal is over once the cause is gone');
    assert.equal(core.currentWorker(id).state, 'running');
    assert.ok(again && alive(m._worker(id).pid));
  } finally { await m.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('adopt: a stop goes through even when the recorded folder is now refused by the checker', async () => {
  const sb = sandbox(); const core = createFakeCore(); const first = mgr(sb, core); let second = null; const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.FAKE_MEMORY_AUTO = 'echo';
  try {
    const row = await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-badrec', native_memory: sb.mem });
    process.env.CLAUDE_CONFIG_DIR = fwd(sb.d); // the recorded folder now sits inside the config directory
    second = mgr(sb, core);
    await second.stop({ worker_id: 'w-badrec', mode: 'graceful', timeout_ms: 8000 });
    for (let i = 0; i < 100 && alive(row.pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(row.pid), false, 'a stop is never refused by the lever check');
    await assert.rejects(second.restart({ worker_id: 'w-badrec', first_turn_timeout_ms: 45000 }), (e) => e.code === 'E_ARGS' && e.detail.reason === 'claude_config_dir', 'a launch is');
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; delete process.env.FAKE_MEMORY_AUTO; if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('adopt: a stop goes through when the recorded folder can no longer be created, and the pid goes', async () => {
  const sb = sandbox(); const core = createFakeCore(); const first = mgr(sb, core); let second = null;
  process.env.FAKE_MEMORY_AUTO = 'echo';
  try {
    const mem = fwd(path.join(sb.d, 'parent', 'mem'));
    const row = await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-enotdir', native_memory: mem });
    fs.rmSync(path.join(sb.d, 'parent'), { recursive: true, force: true });
    fs.writeFileSync(path.join(sb.d, 'parent'), 'a file where the folder\'s parent was'); // mkdir of the recorded folder now fails ENOTDIR
    second = mgr(sb, core);
    assert.ok(alive(row.pid));
    await second.stop({ worker_id: 'w-enotdir', mode: 'graceful', timeout_ms: 8000 });
    for (let i = 0; i < 100 && alive(row.pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(row.pid), false, 'a stop always goes through, whatever the folder error');
    await assert.rejects(second.restart({ worker_id: 'w-enotdir', first_turn_timeout_ms: 45000 }), (e) => e.code === 'ENOTDIR', 'a launch is refused by the same error');
  } finally { delete process.env.FAKE_MEMORY_AUTO; if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('resume: a refused resume does not leave the worker paused in that manager, so a restart is allowed once the cause is gone', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core); const id = 'w-parkref';
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id });
    await m.pause({ worker_id: id, by: 'test' });
    const file = path.join(L.workerDir(sb.data, id), 'settings.json'); const good = fs.readFileSync(file);
    fs.writeFileSync(file, JSON.stringify({ ...settingsOf(sb, id), autoDreamEnabled: true }));
    await assert.rejects(m.resume({ worker_id: id, by: 'test' }), (e) => e.code === 'E_NATIVE_MEMORY_MISMATCH');
    assert.equal(m._worker(id).paused, null, 'the refused relaunch cleared the park facts');
    assert.equal(m._worker(id).parkRequested, null);
    fs.writeFileSync(file, good);
    await m.restart({ worker_id: id, first_turn_timeout_ms: 45000 }); // not E_PAUSED
    assert.equal(core.currentWorker(id).state, 'running');
    assert.ok(alive(m._worker(id).pid));
  } finally { await m.shutdown().catch(() => {}); cleanup(sb.d); }
});

test('message: two concurrent messages to an idle codex worker start one process and refuse the other E_SUBSTRATE', async () => {
  const sb = sandbox(); const core = createFakeCore();
  const m = createRunManager({ core, dataDir: sb.data, runId: 'run-nm', paths: { claudeExe: FAKE, codexExe: fwd(path.join(__dirname, 'fakes', 'fake-codex.cjs')), userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    await m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'one', worker_id: 'w-cx' });
    await m._waitTurn('w-cx', 8000);
    for (let i = 0; i < 100 && alive(m._worker('w-cx').pid); i++) await new Promise((r) => setTimeout(r, 50)); // idle: the turn's process is gone
    process.env.FAKE_CODEX_TURN_MS = '3000';
    const before = m._worker('w-cx').launches;
    const r = await Promise.allSettled([m.message({ worker_id: 'w-cx', text: 'a' }), m.message({ worker_id: 'w-cx', text: 'b' })]);
    assert.equal(m._worker('w-cx').launches, before + 1, 'one launch');
    assert.deepStrictEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(r.find((x) => x.status === 'rejected').reason.code, 'E_SUBSTRATE');
  } finally { delete process.env.FAKE_CODEX_TURN_MS; await m.shutdown().catch(() => {}); cleanup(sb.d); }
});
