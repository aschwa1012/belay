'use strict';
// spawn-tools.test.cjs — worker_spawn's allowed_tools also narrows the worker's built-in tool surface (--tools), not only the
// pre-approval (--allowedTools, which does nothing in auto mode). mcp__* names stay pre-approval only; any other non-built-in
// name is refused with nothing written. Driven over the fake claude, which reports exactly its --tools plus the belay tools.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const S = require('../../src/run/surface.cjs');
const LC = require('../../src/run/lifecycle.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => String(p).replace(/\\/g, '/');
const SIX = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-tools-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}
const mgr = (sb, core) => createRunManager({
  core, dataDir: sb.data, runId: 'run-spawn-tools',
  paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
});
const argvOf = (sb, id) => JSON.parse(fs.readFileSync(path.join(sb.data, 'workers', id, 'argv.json'), 'utf8')).spec.args;
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
async function withMgr(fn) {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core);
  try { await fn({ sb, core, m }); } finally { await m.shutdown(); cleanup(sb.data); }
}
const spawn = (m, sb, id, extra) => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id, ...extra });

test('allowed_tools Read, Grep, Glob narrows --tools, and the result carries the list the worker got', () => withMgr(async ({ sb, m }) => {
  const r = await spawn(m, sb, 'w-narrow', { allowed_tools: ['Read', 'Grep', 'Glob', 'mcp__belay'] });
  assert.deepStrictEqual(r.surface.builtins, ['Glob', 'Grep', 'Read']);
  const args = argvOf(sb, 'w-narrow');
  assert.strictEqual(flag(args, '--tools'), 'Read,Glob,Grep');
  assert.strictEqual(m._worker('w-narrow').tools.join(','), 'Read,Glob,Grep', 'the record keeps the narrowed list');
}));

test('mcp__belay stays in --allowedTools only, never in --tools', () => withMgr(async ({ sb, m }) => {
  await spawn(m, sb, 'w-mcp', { allowed_tools: ['Read', 'mcp__belay'] });
  const args = argvOf(sb, 'w-mcp');
  assert.strictEqual(flag(args, '--tools'), 'Read');
  const at = args.indexOf('--allowedTools');
  assert.deepStrictEqual(args.slice(at + 1, at + 3), ['Read', 'mcp__belay']);
}));

test('omitted allowed_tools gives the full six, and naming all six is the same surface', () => withMgr(async ({ sb, m }) => {
  const a = await spawn(m, sb, 'w-all');
  assert.deepStrictEqual(a.surface.builtins, SIX);
  assert.strictEqual(flag(argvOf(sb, 'w-all'), '--tools'), 'Read,Edit,Write,Glob,Grep,Bash');
  const b = await spawn(m, sb, 'w-six', { allowed_tools: ['Bash', 'Write', 'Edit', 'Grep', 'Glob', 'Read', 'mcp__belay'] });
  assert.deepStrictEqual(b.surface.builtins, SIX);
}));

test('a name that is neither a built-in nor mcp__* is refused E_ARGS with nothing written, naming web tools', () => withMgr(async ({ sb, core, m }) => {
  for (const bad of [['Read', 'WebFetch'], ['WebSearch', 'Task', 'mcp__belay'], ['Read', 7]]) {
    await assert.rejects(spawn(m, sb, 'w-web', { allowed_tools: bad }), (e) => {
      assert.strictEqual(e.code, 'E_ARGS');
      if (typeof bad[1] === 'string') assert.match(e.message, /web tools are not available to workers in this release/);
      return true;
    });
  }
  assert.strictEqual(fs.existsSync(path.join(sb.data, 'workers', 'w-web')), false, 'no worker directory');
  assert.strictEqual(core.rowsFor('w-web').length, 0, 'no row');
  await spawn(m, sb, 'w-web', { allowed_tools: ['Read', 'mcp__belay'] }); // the id is still free
}));

test('allowed_tools with no built-in (only mcp__belay, or empty) is refused E_ARGS with nothing written', () => withMgr(async ({ sb, core, m }) => {
  for (const bad of [['mcp__belay'], []]) {
    await assert.rejects(spawn(m, sb, 'w-none', { allowed_tools: bad }), (e) => e.code === 'E_ARGS' && /no built-in tool/.test(e.message));
  }
  assert.strictEqual(fs.existsSync(path.join(sb.data, 'workers', 'w-none')), false);
  assert.strictEqual(core.rowsFor('w-none').length, 0);
}));

test('checkSurface enforces the narrowed list exactly: a ready event with more or fewer built-ins fails', () => {
  const ready = (t) => ({ tools: [...t, 'mcp__belay__worker_wait'], plugins: [], memory_paths: null });
  const want = ['Read', 'Glob', 'Grep'];
  assert.ok(S.checkSurface(ready(want), { tools: want }).ok);
  const more = S.checkSurface(ready([...want, 'Bash']), { tools: want });
  assert.ok(!more.ok && /extra built-in tool\(s\).*Bash/.test(more.reason), more.reason);
  const fewer = S.checkSurface(ready(['Read', 'Glob']), { tools: want });
  assert.ok(!fewer.ok && /missing built-in tool\(s\).*Grep/.test(fewer.reason), fewer.reason);
});

test('a narrowed worker whose init reports an extra tool fails E_NO_READY', () => withMgr(async ({ sb, m }) => {
  process.env.FAKE_SURFACE = 'extra-tool';
  try {
    await assert.rejects(spawn(m, sb, 'w-extra', { allowed_tools: ['Read', 'mcp__belay'] }), (e) => e.code === 'E_NO_READY');
  } finally { delete process.env.FAKE_SURFACE; }
}));

test('restart and pause/resume keep the narrowed list, and a cross-adapter reader recovers it from argv.json', () => withMgr(async ({ sb, m }) => {
  await spawn(m, sb, 'w-keep', { allowed_tools: ['Read', 'Grep', 'Glob', 'mcp__belay'] });
  const r = await m.restart({ worker_id: 'w-keep' });
  assert.deepStrictEqual(r.surface.builtins, ['Glob', 'Grep', 'Read']);
  assert.strictEqual(flag(argvOf(sb, 'w-keep'), '--tools'), 'Read,Glob,Grep');
  await m.pause({ worker_id: 'w-keep', by: 'operator:1' });
  const v = await m.resume({ worker_id: 'w-keep', by: 'operator:1' });
  assert.deepStrictEqual(v.surface.builtins, ['Glob', 'Grep', 'Read']);
  const args = argvOf(sb, 'w-keep');
  assert.strictEqual(flag(args, '--tools'), 'Read,Glob,Grep');
  const lo = LC.readLaunchOptions(path.join(sb.data, 'workers', 'w-keep'));
  assert.deepStrictEqual(lo.tools, ['Read', 'Glob', 'Grep'], 'adopt reads the narrowed list back');
  assert.deepStrictEqual(lo.allowedTools, ['Read', 'Grep', 'Glob', 'mcp__belay']);
}));

test('Codex: a proper subset of built-ins is refused E_SUBSTRATE and a web tool E_ARGS, both with nothing written', () => withMgr(async ({ sb, core, m }) => {
  await assert.rejects(m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'hi', worker_id: 'c-narrow', allowed_tools: ['Read', 'Grep'] }),
    (e) => e.code === 'E_SUBSTRATE' && /omit allowed_tools for a Codex worker; it cannot narrow Codex's tools/.test(e.message));
  await assert.rejects(m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'hi', worker_id: 'c-web', allowed_tools: ['WebFetch'] }), (e) => e.code === 'E_ARGS');
  assert.strictEqual(fs.existsSync(path.join(sb.data, 'workers', 'c-narrow')), false);
  assert.strictEqual(core.rowsFor('c-narrow').length, 0);
}));

test('an explicit tools argument (harness callers) wins over the built-ins derived from allowed_tools', () => withMgr(async ({ sb, m }) => {
  const r = await spawn(m, sb, 'w-explicit', { allowed_tools: ['Read', 'mcp__belay'], tools: ['Read', 'Glob'] });
  assert.strictEqual(flag(argvOf(sb, 'w-explicit'), '--tools'), 'Read,Glob');
  assert.deepStrictEqual(r.surface.builtins, ['Glob', 'Read']);
  // allowed_tools is still validated when tools is given
  await assert.rejects(spawn(m, sb, 'w-explicit-bad', { allowed_tools: ['WebFetch'], tools: ['Read'] }), (e) => e.code === 'E_ARGS');
}));
