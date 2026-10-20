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

test('relaunch: settings.json edited by a worker spawned without the lever is refused by a second manager, and memory stays off', async () => {
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
      await assert.rejects(() => second.restart({ worker_id: 'w-plant', first_turn_timeout_ms: 45000 }), (e) => e.code === 'E_NATIVE_MEMORY_MISMATCH');
      assert.equal(fs.existsSync(sb.mem), false, 'the planted folder was never created');
      assert.equal(core.currentWorker('w-plant').native_memory, null, 'the record still says off');
    } finally { delete process.env.FAKE_MEMORY_AUTO; if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); cleanup(sb.d); }
  }
});

test('relaunch: a worker spawned with the lever and a settings.json edited to another folder is refused', async () => {
  const sb = sandbox(); const core = createFakeCore(); const first = mgr(sb, core); let second = null;
  process.env.FAKE_MEMORY_AUTO = 'echo';
  try {
    await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-plant2', native_memory: sb.mem });
    await first.stop({ worker_id: 'w-plant2', mode: 'kill', timeout_ms: 8000 });
    const real = fwd(path.join(os.homedir(), '.claude', 'projects', 'p', 'memory'));
    fs.writeFileSync(path.join(L.workerDir(sb.data, 'w-plant2'), 'settings.json'), JSON.stringify({ ...settingsOf(sb, 'w-plant2'), autoMemoryDirectory: real }));
    second = mgr(sb, core);
    await assert.rejects(() => second.restart({ worker_id: 'w-plant2', first_turn_timeout_ms: 45000 }), (e) => e.code === 'E_NATIVE_MEMORY_MISMATCH' && e.detail.recorded === sb.mem);
    assert.equal(core.currentWorker('w-plant2').native_memory, sb.mem);
  } finally { delete process.env.FAKE_MEMORY_AUTO; if (second) await second.shutdown().catch(() => {}); await first.shutdown().catch(() => {}); cleanup(sb.d); }
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
