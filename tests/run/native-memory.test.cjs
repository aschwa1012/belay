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
    [undefined, /absent/], [null, /absent/], [{}, /exactly/], [{ auto: 'C:/Work/x/.claude/projects/p/memory' }, /asked for/],
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
  const sb = sandbox(); const m = mgr(sb, createFakeCore());
  try {
    process.env.FAKE_MEMORY_AUTO = 'C:/fake/mem';
    await assert.rejects(() => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-nm-off' }), (e) => e.code === 'E_NO_READY');
    delete process.env.FAKE_MEMORY_AUTO;
    await assert.rejects(() => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', native_memory: 'relative' }), (e) => e.code === 'E_ARGS');
    await assert.rejects(() => m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'hi', native_memory: sb.mem }), (e) => e.code === 'E_SUBSTRATE');
    assert.equal(fs.existsSync(sb.mem), false, 'a refused spawn creates no folder');
  } finally { delete process.env.FAKE_MEMORY_AUTO; await m.shutdown?.().catch(() => {}); cleanup(sb.d); }
});
