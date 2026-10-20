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
  const sb = sandbox(); const m = mgr(sb, createFakeCore());
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
    // a cross-adapter relaunch recovers the folder from the worker directory
    assert.equal(LC.readLaunchOptions(L.workerDir(sb.data, 'w-nm')).nativeMemory, sb.mem);
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

test('readLaunchOptions: a settings.json a worker edited to name a Claude config folder is not read back', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-nm-rb-'));
  try {
    fs.writeFileSync(path.join(d, 'argv.json'), JSON.stringify({ spec: { args: [] } }));
    const put = (dir) => fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ autoMemoryEnabled: true, autoMemoryDirectory: dir }));
    put(fwd(path.join(os.homedir(), '.claude', 'projects', 'p', 'memory')));
    const bad = LC.readLaunchOptions(d);
    assert.equal(bad.nativeMemory, null);
    assert.equal(bad.error.where, 'settings.json');
    assert.equal(bad.error.code, 'E_ARGS');
    put(fwd(path.join(d, 'mem')));
    assert.equal(LC.readLaunchOptions(d).nativeMemory, fwd(path.join(d, 'mem')), 'a folder that passes the spawn check is read back');
  } finally { cleanup(d); }
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
