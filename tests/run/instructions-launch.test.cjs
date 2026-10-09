'use strict';
// instructions-launch.test.cjs — build step S2-2, ADR 0024 amendment 1, over the fakes (never a real
// session; A18 is the paid row). The spawn-time copy of the worktree's CLAUDE.md reaches every launch
// through --append-system-prompt-file, and no later launch re-reads the worktree.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const P = require('../../src/run/process.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json').replace(/\\/g, '/');
const fwd = (p) => String(p).replace(/\\/g, '/');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-instr-launch-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { root: d, data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}
const cleanup = (sb) => { try { fs.rmSync(sb.root, { recursive: true, force: true }); } catch { /* temp dir */ } };
const mgr = (sb, core) => createRunManager({
  core, dataDir: sb.data, runId: 'run-instr', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS },
});
const claudeMd = (sb) => path.join(sb.root, 'wt', 'CLAUDE.md');
const argvOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')).spec.args;
const appendFile = (args) => {
  const i = args.indexOf('--append-system-prompt-file');
  return i === -1 ? null : args[i + 1];
};

test('spawn: argv carries --append-system-prompt-file naming the spawn copy, and the spawn returns instructions', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  try {
    fs.writeFileSync(claudeMd(sb), 'PROJECT RULES i5');
    const r = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-i5' });
    const args = argvOf(path.join(sb.data, 'workers', 'w-i5'));
    const want = fwd(path.join(sb.data, 'workers', 'w-i5', 'instructions.md'));
    assert.equal(appendFile(args), want);
    assert.ok(args.includes('--setting-sources=') && !args.includes('--setting-sources'));
    assert.deepStrictEqual(r.instructions, { path: want, bytes: 16, sha256: sha('PROJECT RULES i5') });
    assert.equal(fs.readFileSync(want, 'utf8'), 'PROJECT RULES i5');
    await m._waitTurn('w-i5', 8000).catch(() => {});
  } finally {
    await m.shutdown().catch(() => {});
    cleanup(sb);
  }
});

test('restart: the relaunch passes the same spawn copy after the worktree CLAUDE.md was rewritten, and the copy\'s bytes are the spawn-time ones', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  try {
    fs.writeFileSync(claudeMd(sb), 'SPAWN TIME i6');
    const born = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-i6' });
    await m._waitTurn('w-i6', 8000);
    const dir = path.join(sb.data, 'workers', 'w-i6');
    fs.writeFileSync(claudeMd(sb), 'REWRITTEN BY THE WORKER i6, longer');
    const r = await m.restart({ worker_id: 'w-i6', first_turn_timeout_ms: 8000 });
    const args = argvOf(dir);
    assert.deepEqual(args.slice(-2), ['--resume', born.session_id], 'this was a real resume');
    assert.equal(appendFile(args), born.instructions.path, 'the same copy');
    assert.equal(fs.readFileSync(born.instructions.path, 'utf8'), 'SPAWN TIME i6', 'spawn-time bytes');
    assert.deepStrictEqual(r.instructions, born.instructions, 'restart returns the spawn copy, not a new one');
  } finally {
    await m.shutdown().catch(() => {});
    cleanup(sb);
  }
});

test('spawn: a worktree with no CLAUDE.md launches with no --append-system-prompt-file and returns instructions.path null', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  try {
    const r = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-i7' });
    const dir = path.join(sb.data, 'workers', 'w-i7');
    assert.equal(appendFile(argvOf(dir)), null);
    assert.equal(r.instructions.path, null);
    assert.match(r.instructions.reason, /no CLAUDE\.md/);
    assert.ok(!fs.existsSync(path.join(dir, 'instructions.md')));
    await m._waitTurn('w-i7', 8000).catch(() => {});
  } finally {
    await m.shutdown().catch(() => {});
    cleanup(sb);
  }
});

test('adopt: a worker adopted with an existing copy relaunches with it; one with no copy relaunches with none and reads nothing from the worktree', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const first = mgr(sb, core);
  let second = null;
  try {
    // One worker with a CLAUDE.md at spawn, one without.
    fs.writeFileSync(claudeMd(sb), 'WITH COPY i8');
    const withCopy = await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'a', worker_id: 'w-i8a' });
    await first._waitTurn('w-i8a', 8000);
    const sb2 = path.join(sb.root, 'wt2');
    fs.mkdirSync(sb2, { recursive: true });
    const noCopy = await first.spawn({ substrate: 'claude-code', worktree: fwd(sb2), prompt: 'b', worker_id: 'w-i8b' });
    await first._waitTurn('w-i8b', 8000);
    for (const id of ['w-i8a', 'w-i8b']) {
      const pid = core.currentWorker(id).pid;
      await first.stop({ worker_id: id, mode: 'kill', timeout_ms: 8000 });
      assert.equal(P.pidAlive(pid), false);
    }
    assert.equal(noCopy.instructions.path, null);
    // The worktrees change after the fact; an adoption must not notice.
    fs.writeFileSync(claudeMd(sb), 'CHANGED AFTER SPAWN i8');
    fs.writeFileSync(path.join(sb2, 'CLAUDE.md'), 'APPEARED AFTER SPAWN i8');

    second = mgr(sb, core);
    const ra = await second.restart({ worker_id: 'w-i8a', first_turn_timeout_ms: 8000 });
    const rb = await second.restart({ worker_id: 'w-i8b', first_turn_timeout_ms: 8000 });
    const a = argvOf(path.join(sb.data, 'workers', 'w-i8a'));
    const b = argvOf(path.join(sb.data, 'workers', 'w-i8b'));
    assert.equal(appendFile(a), withCopy.instructions.path);
    assert.equal(fs.readFileSync(appendFile(a), 'utf8'), 'WITH COPY i8');
    assert.deepStrictEqual(ra.instructions, withCopy.instructions);
    assert.equal(appendFile(b), null, 'no copy at spawn, so none now');
    assert.equal(rb.instructions.path, null);
    assert.ok(!fs.existsSync(path.join(sb.data, 'workers', 'w-i8b', 'instructions.md')), 'nothing read from the worktree late');
  } finally {
    if (second) await second.shutdown().catch(() => {});
    await first.shutdown().catch(() => {});
    cleanup(sb);
  }
});

test('orchestrator: argv carries --setting-sources= and --append-system-prompt-file naming the copy in its data dir, and the run\'s orchestrator block carries instructions', async () => {
  const sb = sandbox();
  const dataDir = fwd(path.join(sb.data, '.belay'));
  const orchestratorDir = fwd(path.join(sb.data, 'orch'));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(claudeMd(sb), 'ORCHESTRATOR RULES i9');
  const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };
  const savedExe = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  try {
    const result = await runOrchestrator({
      core, runId: 'run-i9', dataDir,
      spec: {
        worktree: sb.worktree, promptText: 'hello', orchestratorDir, model: 'claude-sonnet-5',
        allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 0, mcpToolTimeoutMs: 60000,
        pollMs: 100, closeGraceMs: 3000,
      },
      onAttached: async () => ({ ok: true }),
    });
    const args = argvOf(orchestratorDir);
    assert.ok(args.includes('--setting-sources=') && !args.includes('--setting-sources'));
    const want = fwd(path.join(orchestratorDir, 'instructions.md'));
    assert.equal(appendFile(args), want);
    assert.equal(fs.readFileSync(want, 'utf8'), 'ORCHESTRATOR RULES i9');
    assert.deepStrictEqual(result.orchestrator.instructions, { path: want, bytes: 21, sha256: sha('ORCHESTRATOR RULES i9') });
  } finally {
    if (savedExe === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = savedExe;
    cleanup(sb);
  }
});

test('instructions: a reused worker id whose second worktree has no CLAUDE.md is adopted with no append file', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const ms = [];
  const mk = () => { const m = mgr(sb, core); ms.push(m); return m; };
  try {
    const wtB = fwd(path.join(sb.root, 'wtB'));
    fs.mkdirSync(wtB, { recursive: true });
    fs.writeFileSync(claudeMd(sb), 'INSTRUCTIONS OF WORKTREE A');
    const dir = path.join(sb.data, 'workers', 'w-i10');
    const m1 = mk();
    await m1.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'a', worker_id: 'w-i10' });
    await m1._waitTurn('w-i10', 8000);
    await m1.stop({ worker_id: 'w-i10', mode: 'kill', timeout_ms: 8000 });
    const m2 = mk();
    const r2 = await m2.spawn({ substrate: 'claude-code', worktree: wtB, prompt: 'b', worker_id: 'w-i10' });
    await m2._waitTurn('w-i10', 8000);
    assert.equal(r2.instructions.path, null);
    assert.equal(appendFile(argvOf(dir)), null, 'the second spawn launched with no copy');
    assert.ok(!fs.existsSync(path.join(dir, 'instructions.md')), "the first spawn's copy was removed");
    await m2.stop({ worker_id: 'w-i10', mode: 'kill', timeout_ms: 8000 });
    const r3 = await mk().restart({ worker_id: 'w-i10', first_turn_timeout_ms: 8000 });
    assert.equal(appendFile(argvOf(dir)), null, 'the adopted relaunch carries no stale copy');
    assert.equal(r3.instructions.path, null);
  } finally {
    for (const m of ms.reverse()) await m.shutdown().catch(() => {});
    cleanup(sb);
  }
});
