'use strict';
require('../helpers/tmp.cjs');
// digest-wake-headless.test.cjs — ADR 0074 amendment 2, the headless path: every policy step reaches the orchestrator in exactly one digest,
// whether it waits for the run or is only woken. Before it, the headless run wrote wakes to stdin and never a digest, so an orchestrator that
// never called worker_wait saw none of belay's steps (the e040 P2 run: 13 wakes, no wait, 11 steps in no digest). Through the run's own
// orchestrator loop (fake executable, fake core) and the run wait; the claim files are the record of what was shown.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const D = require('../../src/run/run-digest.cjs');
const DW = require('../../src/run/digest-wake.cjs');
const { createRunWait } = require('../../src/run/run-wait.cjs');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const RUN = 'r1';
const fwd = (p) => String(p).split(path.sep).join('/');
// A task under a plan whose release evaluation failed: one E5 exception, so the run writes one wake.
const W = {
  id: 'W', seq: 7, run_id: RUN, state: 'released', policy: { review: { worker: 'rv' }, fix: 'builder' }, depends_on: [], repairs: null, lease: null, review: null, integration: null, written_at: 50,
  handoff: { by: 'w1', at: 10 },
  results: { trigger: 'release', evaluated_at: 20, executable: true, passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: false, exit_code: 1 }] },
};
const stepRow = (seq, step, taskId, ref) => ({ seq, run_id: RUN, step, task_id: taskId, outcome: 'done', row_ref: ref, error: null, worker_id: 'coder', trigger_table: 'task', trigger_id: taskId, trigger_seq: 1, finished_at: 1000 + seq });

function setup(tasks, steps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-dw-headless-'));
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true });
  fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore();
  core.task = { ...(core.task || {}), list: async () => ({ tasks }) };
  core.policy = { list: async (a = {}) => { const rows = steps.filter((s) => s.seq > (a.since_seq || 0)); return { rows, last_seq: rows.length ? rows[rows.length - 1].seq : 0 }; } };
  return { root, sb, core };
}
const runWith = (core, sb) => runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
  worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null, policy: true,
  startupTimeoutMs: 8000, timeoutMs: 60000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
} });
async function withFake(fn) {
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
  try { return await fn(); } finally { if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved; }
}
const digestWakes = (out) => out.wakes.filter((w) => w.event === 'policy_digest');
const shownSeqs = (dataDir) => D.readDigests(dataDir, RUN).flatMap((d) => d.lines.map((l) => l.step_seq));
const clock = () => { const c = { t: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; return c; };

test('P2: woken, never waiting: the steps reach the orchestrator in a digest written after the wake, once', async () => {
  const steps = [stepRow(1, 'fix', 'W', 'task:f1'), stepRow(2, 're_review', 'W', 'task:r2'), stepRow(3, 'integrate', 'W', 'integration:i1')];
  const { root, sb, core } = setup([W], steps);
  try {
    const out = await withFake(() => runWith(core, sb));
    assert.strictEqual(out.wakes.filter((w) => w.exception === 'E5').length, 1, JSON.stringify(out.wakes));
    assert.strictEqual(digestWakes(out).length, 1, `one digest wake: ${JSON.stringify(out.wakes)}`);
    const ds = D.readDigests(sb.dataDir, RUN);
    assert.deepStrictEqual(ds.map((d) => d.via), ['wake']);
    assert.deepStrictEqual(shownSeqs(sb.dataDir), [1, 2, 3], 'every step shown, each once');
    const r = await createRunWait({ core, runId: RUN, dataDir: sb.dataDir, pollMs: 100, clock: clock() }).wait({ ms: 300, t0: 0, workers: [] });
    assert.strictEqual(r.digest, undefined, 'the wait does not show them again');
  } finally { cleanup(root); }
});

test('a step after the last wake: the idle close writes the digest first, then closes', async () => {
  const { root, sb, core } = setup([], [stepRow(1, 'integrate', 'X', 'integration:i9')]);
  try {
    const out = await withFake(() => runWith(core, sb));
    assert.strictEqual(digestWakes(out).length, 1, JSON.stringify(out.wakes));
    assert.deepStrictEqual(shownSeqs(sb.dataDir), [1]); // runOrchestrator returned: the run still closed, after the digest
  } finally { cleanup(root); }
});

test('a mix: steps a wait already showed are not in the wake\'s digest, and the rest are, once each', async () => {
  const steps = [stepRow(1, 'fix', 'W', 'task:f1'), stepRow(2, 're_review', 'W', 'task:r2')];
  const { root, sb, core } = setup([W], steps);
  try {
    const waited = D.claimDigest({ dataDir: sb.dataDir, runId: RUN, rows: steps.slice(0, 1), via: 'wait' }); // the orchestrator waited once, then only by the wake
    assert.deepStrictEqual(waited.lines.map((l) => l.step_seq), [1]);
    const out = await withFake(() => runWith(core, sb));
    assert.strictEqual(digestWakes(out).length, 1);
    const ds = D.readDigests(sb.dataDir, RUN);
    assert.deepStrictEqual(ds.map((d) => [d.via, d.lines.map((l) => l.step_seq)]), [['wait', [1]], ['wake', [2]]]);
  } finally { cleanup(root); }
});

test('the wait claimed every step first: the run writes no digest wake', async () => {
  const steps = [stepRow(1, 'fix', 'W', 'task:f1')];
  const { root, sb, core } = setup([W], steps);
  try {
    assert.ok(D.claimDigest({ dataDir: sb.dataDir, runId: RUN, rows: steps, via: 'wait' }));
    const out = await withFake(() => runWith(core, sb));
    assert.strictEqual(digestWakes(out).length, 0, JSON.stringify(out.wakes));
    assert.deepStrictEqual(D.readDigests(sb.dataDir, RUN).map((d) => d.via), ['wait']);
  } finally { cleanup(root); }
});

test('a digest wake the run could not write gives its claim back, so the steps stay for the next asker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-dw-unit-'));
  try {
    const dataDir = fwd(root);
    const rows = [stepRow(1, 'fix', 'W', 'task:f1')];
    const rec = D.claimDigest({ dataDir, runId: RUN, rows, via: 'wake' });
    const state = { wakesSuppressed: [] };
    const ev = { event: 'policy_digest', worker_id: `digest:${RUN}`, text: rec.text, digest_n: rec.n };
    assert.strictEqual(DW.deliver(ev, { writeWake: (e) => state.wakesSuppressed.push({ ...e, reason: 'stdin was broken' }), state, dataDir, runId: RUN }), false);
    const again = D.claimDigest({ dataDir, runId: RUN, rows, via: 'wait' });
    assert.ok(again && again.lines[0].step_seq === 1, 'released: the wait is offered the step');
  } finally { cleanup(root); }
});
