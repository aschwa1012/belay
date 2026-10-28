'use strict';
// pre-close-wake.test.cjs — before a headless run closes on its idle rule, the orchestrator is told once which task trees the close
// would keep (dirty, HEAD off its branch), then the next idle turn closes as usual. A clean plan, a failed read and a plan with
// only other reasons say nothing. Over the fakes: no Claude Code, no model.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createPreCloseNotice, textOf } = require('../../src/run/pre-close-wake.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const DIRTY = { task_ids: ['t1'], path: 'C:/r.worktrees/t1', branch: 'belay/t1', reason: 'dirty', detail: '2 uncommitted path(s)', paths: ['a.txt', 'b.txt'] };
const OFF = { task_ids: ['t2'], path: 'C:/r.worktrees/t2', branch: 'belay/t2', reason: 'head_off_branch', detail: 'HEAD is detached' };
const OPEN = { task_ids: ['t3'], path: 'C:/r.worktrees/t3', branch: 'belay/t3', reason: 'task_open', detail: 'task t3 is open' };

test('the text names each tree to be kept with its paths or HEAD, and only dirty and off-branch ones', () => {
  const t = textOf({ kept: [DIRTY, OFF, OPEN] });
  assert.match(t, /C:\/r\.worktrees\/t1 \(task t1; uncommitted: a\.txt, b\.txt\)/);
  assert.match(t, /C:\/r\.worktrees\/t2 \(task t2; HEAD is detached\)/);
  assert.doesNotMatch(t, /t3/);
  assert.ok(Buffer.byteLength(t) < 600, `short: ${Buffer.byteLength(t)} bytes`);
  assert.strictEqual(textOf({ kept: [OPEN] }), null);
  assert.strictEqual(textOf({ kept: [] }), null);
});

test('the notice is made once per run, and a failed read says nothing', async () => {
  let calls = 0, seen;
  const n = createPreCloseNotice({ core: { task: { worktreeSweep: async (a) => { calls += 1; seen = a; return { kept: [DIRTY] }; } } }, runId: 'r1' });
  const first = await n.notice();
  assert.strictEqual(first.event, 'pre_close');
  assert.deepStrictEqual(seen, { run_id: 'r1', dry_run: true });
  assert.strictEqual(await n.notice(), null);
  assert.strictEqual(calls, 1);
  const bad = createPreCloseNotice({ core: { task: { worktreeSweep: async () => { throw new Error('x'); } } }, runId: 'r1' });
  assert.strictEqual(await bad.notice(), null);
});

async function drive(plan, dry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-preclose-'));
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true });
  fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };
  core.task = { ...(core.task || {}), list: async () => ({ tasks: [] }), worktreeSweep: async (a) => { dry.push(a); if (plan instanceof Error) throw plan; return plan; } };
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = FAKE;
  try {
    return await runOrchestrator({ core, runId: 'run-pre', dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
      worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null,
      startupTimeoutMs: 8000, timeoutMs: 60000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
    } });
  } finally {
    if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved;
    cleanup(root);
  }
}

test('a headless run with a dirty tree is told once, then closes on its next idle turn', async () => {
  const dry = [];
  const out = await drive({ kept: [DIRTY] }, dry);
  const pre = out.wakes.filter((w) => w.event === 'pre_close');
  assert.strictEqual(pre.length, 1, JSON.stringify(out.wakes));
  assert.strictEqual(pre[0].established_by, 'task.worktreeSweep dry run');
  assert.ok(pre[0].answered_at_ms >= 0, 'the orchestrator took a turn on it before the run closed');
  assert.strictEqual(dry.length, 1, 'the plan was read once');
  assert.deepStrictEqual(dry[0], { run_id: 'run-pre', dry_run: true });
});

test('a clean plan, a plan with only other reasons and a failed read close without a wake', async () => {
  for (const plan of [{ kept: [] }, { kept: [OPEN] }, new Error('owner gone')]) {
    const dry = [];
    const out = await drive(plan, dry);
    assert.strictEqual(out.wakes.filter((w) => w.event === 'pre_close').length, 0);
    assert.strictEqual(dry.length, 1);
  }
});
