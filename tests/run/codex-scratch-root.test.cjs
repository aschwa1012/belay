'use strict';
// A Codex reviewer's scratch folder lies outside its worktree, and `-s workspace-write` makes only the worktree writable. The
// launch adds the folder, and only that folder, as an extra writable root (`--add-dir`, codex-cli 0.163.0). Every other launch
// keeps its argv.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../../src/run/launch.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const FAKE_CODEX = path.join(__dirname, 'fakes', 'fake-codex.cjs').split(path.sep).join('/');

test('codexLaunchArgv adds the scratch folder once, forward-slashed, before the prompt, and nothing without one', () => {
  const base = { worktree: 'C:/w', adapterArgs: ['a.cjs'], prompt: '- p', model: 'm' };
  const without = L.codexLaunchArgv(base);
  assert.ok(!without.includes('--add-dir'));
  const withDir = L.codexLaunchArgv({ ...base, scratchDir: ['C:', 'data', 'scratch', 'r', 'rev1'].join(path.win32.sep) });
  assert.strictEqual(withDir.filter((a) => a === '--add-dir').length, 1);
  assert.strictEqual(withDir[withDir.indexOf('--add-dir') + 1], 'C:/data/scratch/r/rev1');
  assert.deepStrictEqual(withDir.filter((a) => a !== '--add-dir' && a !== 'C:/data/scratch/r/rev1'), without, 'the rest of the argv is unchanged');
  assert.deepStrictEqual(withDir.slice(-2), ['--', '- p']);
  assert.strictEqual(withDir[withDir.indexOf('-s') + 1], 'workspace-write');
});

test('a spawned Codex reviewer gets its scratch folder as the one extra root; a coder and a Claude Code reviewer get none', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cx-scratch-')).split(path.sep).join('/');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const m = createRunManager({ core: createFakeCore(), dataDir: data, runId: 'run-cxs', paths: { claudeExe: FAKE, codexExe: FAKE_CODEX, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  const argsOf = (id) => JSON.parse(fs.readFileSync(`${data}/workers/${id}/argv.json`, 'utf8')).spec.args;
  try {
    const rev = await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'rev1', agent_type: 'reviewer' });
    const args = argsOf('rev1');
    assert.strictEqual(args.filter((a) => a === '--add-dir').length, 1);
    assert.strictEqual(args[args.indexOf('--add-dir') + 1], rev.scratch.split(path.sep).join('/'));
    assert.strictEqual(args[args.indexOf('--add-dir') + 1], `${data}/scratch/run-cxs/rev1`);
    await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'cod1', agent_type: 'coder' });
    assert.ok(!argsOf('cod1').includes('--add-dir'));
    await m.spawn({ substrate: 'claude-code', worktree, prompt: 'one', worker_id: 'rev2', agent_type: 'reviewer' });
    assert.ok(!argsOf('rev2').includes('--add-dir'));
  } finally { await m.shutdown().catch(() => {}); cleanup(data); }
});

test('codexResumeArgv carries the scratch folder as a writable_roots override, quoted for TOML, and nothing without one', () => {
  const base = { threadId: 't1', adapterArgs: ['a.cjs'], prompt: '- p', model: 'm' };
  const without = L.codexResumeArgv(base);
  assert.ok(!without.some((a) => /writable_roots/.test(a)) && !without.includes('--add-dir'));
  const dir = ['D:', 'work', 'my "data"', 'scratch', 'r', 'rev1'].join(path.win32.sep);
  const argv = L.codexResumeArgv({ ...base, scratchDir: dir });
  const i = argv.findIndex((a) => a.startsWith('sandbox_workspace_write.writable_roots='));
  assert.ok(i > 0 && argv[i - 1] === '-c');
  assert.ok(!argv.includes('--add-dir'), 'resume takes no --add-dir');
  assert.strictEqual(argv[i], 'sandbox_workspace_write.writable_roots=["D:/work/my \\"data\\"/scratch/r/rev1"]');
  assert.deepStrictEqual(JSON.parse(argv[i].slice(argv[i].indexOf('=') + 1)), ['D:/work/my "data"/scratch/r/rev1']);
  assert.deepStrictEqual(argv.filter((_, k) => k !== i - 1 && k !== i), without, 'the rest of the argv is unchanged');
  assert.deepStrictEqual(argv.slice(-2), ['--', '- p']);
});

test('the next turn of a Codex reviewer (a resume) keeps its scratch folder as the writable root; a coder has none', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cx-scratch-r-')).split(path.sep).join('/');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const m = createRunManager({ core: createFakeCore(), dataDir: data, runId: 'run-cxr', paths: { claudeExe: FAKE, codexExe: FAKE_CODEX, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  const rootsOf = (id) => JSON.parse(fs.readFileSync(`${data}/workers/${id}/argv.json`, 'utf8')).spec.args.filter((a) => /writable_roots/.test(a));
  try {
    await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'rev1', agent_type: 'reviewer' });
    await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'cod1', agent_type: 'coder' });
    for (const id of ['rev1', 'cod1']) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) { try { await m.message({ worker_id: id, text: 'again' }); break; } catch (e) { await new Promise((r) => setTimeout(r, 50)); } }
    }
    assert.deepStrictEqual(rootsOf('rev1'), [`sandbox_workspace_write.writable_roots=["${data}/scratch/run-cxr/rev1"]`]);
    assert.deepStrictEqual(rootsOf('cod1'), []);
  } finally { await m.shutdown().catch(() => {}); cleanup(data); }
});

test('an adopted Codex reviewer record gets its scratch folder back from the data dir; a coder, a Claude Code worker and a folderless row get none', async () => {
  const W = require('../../src/run/worker.cjs');
  const RS = require('../../src/run/review-scratch.cjs');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cx-adopt-')).split(path.sep).join('/');
  const rowOf = (id, substrate) => ({ id, run_id: 'run-ad', substrate, worktree: `${data}/wt`, state: 'idle', seq: 3, pid: null, turns: 1, session_id: 's1' });
  const adopt = (id, substrate) => W.adopt({ core: { worker: { get: async () => rowOf(id, substrate) } }, workerId: id, dataDir: data });
  try {
    const dir = RS.ensure(data, 'rev1', 'run-ad');
    assert.ok(dir, 'the reviewer folder was made');
    assert.strictEqual((await adopt('rev1', 'codex')).scratchDir, `${data}/scratch/run-ad/rev1`);
    assert.strictEqual((await adopt('cod1', 'codex')).scratchDir, null);
    assert.strictEqual((await adopt('rev1', 'claude-code')).scratchDir, null);
    const resume = L.codexResumeArgv({ threadId: 't', adapterArgs: ['a.cjs'], prompt: 'p', scratchDir: (await adopt('rev1', 'codex')).scratchDir });
    assert.ok(resume.some((a) => a === `sandbox_workspace_write.writable_roots=["${data}/scratch/run-ad/rev1"]`));
  } finally { cleanup(data); }
});

// A Codex turn that finishes and exits 0 before the running row is written: the null write must wait for the exit event, not
// fail the start (E_NO_READY) on the state it still has. The exit event is held back by a seam; the running write comes back null.
test('a Codex worker whose turn exits 0 before the running row is written starts idle, not E_NO_READY', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cx-quick-')).split(path.sep).join('/');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const m = createRunManager({ core: createFakeCore(), dataDir: data, runId: 'run-cxq', paths: { claudeExe: FAKE, codexExe: FAKE_CODEX, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  process.env.FAKE_CODEX_TURN_MS = '60';
  const { ChildProcess } = require('node:child_process');
  const emit = ChildProcess.prototype.emit;
  ChildProcess.prototype.emit = function (ev, ...a) { // the exit notice trails the pid's death, as on a loaded host
    if (ev !== 'exit' || !(this.spawnargs || []).join(' ').includes('fake-codex')) return emit.call(this, ev, ...a);
    setTimeout(() => emit.call(this, ev, ...a), 2000);
    return true;
  };
  // The running row is written straight after noteInit: parked here until the pid is really gone (a sleeping wait, bounded), so the
  // write meets a dead pid with its exit event still owed, whatever the machine's speed.
  const W = require('../../src/run/worker.cjs');
  const P = require('../../src/run/process.cjs');
  const noteInit = W.noteInit;
  W.noteInit = (w, ready) => {
    const gate = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 500 && P.pidAlive(w.pid); i++) Atomics.wait(gate, 0, 0, 10);
    return noteInit(w, ready);
  };
  try {
    const row = await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'cq1', first_turn_timeout_ms: 20000 });
    assert.strictEqual(row.state, 'idle', JSON.stringify(row));
  } finally { ChildProcess.prototype.emit = emit; W.noteInit = noteInit; delete process.env.FAKE_CODEX_TURN_MS; await m.shutdown().catch(() => {}); cleanup(data); }
});
