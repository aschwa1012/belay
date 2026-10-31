'use strict';
require('../helpers/tmp.cjs');
// run-wait-headless.test.cjs — ADR 0074, the headless path: a policy exception is delivered once, by the stdin wake or by worker_wait,
// whichever claims it first. Both orders, through the run's own orchestrator loop (fake executable) and the run wait.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PW = require('../../src/run/policy-wakes.cjs');
const D = require('../../src/run/run-digest.cjs');
const { createRunWait } = require('../../src/run/run-wait.cjs');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const RUN = 'r1';
const fwd = (p) => String(p).split(path.sep).join('/');
// A task under a plan whose release evaluation failed: one E5 exception, derived from the rows alone.
const W = {
  id: 'W', seq: 7, run_id: RUN, state: 'released', policy: { review: { worker: 'rv' }, fix: 'builder' }, depends_on: [], repairs: null, lease: null, review: null, integration: null, written_at: 50,
  handoff: { by: 'w1', at: 10 },
  results: { trigger: 'release', evaluated_at: 20, executable: true, passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: false, exit_code: 1 }] },
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-headless-'));
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true });
  fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore();
  core.task = { ...(core.task || {}), list: async () => ({ tasks: [W] }) };
  core.policy = { list: async () => ({ rows: [], last_seq: 0 }) };
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
const uidOf = async (core) => { const w = (await PW.createPolicyWatcher({ core, runId: RUN, enabled: true }).poll())[0]; return { uid: `${w.worker_id}:${w.key}`, wake: w }; };
const clock = () => { const c = { t: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; return c; };

test('the wait claimed it first: the stdin wake is suppressed, named as delivered by worker_wait', async () => {
  const { root, sb, core } = setup();
  try {
    const { uid } = await uidOf(core);
    assert.ok(D.claimException({ dataDir: sb.dataDir, runId: RUN, uid }), 'worker_wait returned it');
    const out = await withFake(() => runWith(core, sb));
    assert.deepStrictEqual(out.wakes.filter((w) => w.exception), [], 'not written to stdin');
    const sup = out.wakes_suppressed.filter((w) => w.exception === 'E5');
    assert.strictEqual(sup.length, 1, JSON.stringify(out.wakes_suppressed));
    assert.strictEqual(sup[0].reason, 'delivered by worker_wait');
  } finally { cleanup(root); }
});

test('the wake claimed it first: it is written once, and worker_wait does not return it', async () => {
  const { root, sb, core } = setup();
  try {
    const out = await withFake(() => runWith(core, sb));
    assert.strictEqual(out.wakes.filter((w) => w.exception === 'E5').length, 1, JSON.stringify(out.wakes));
    assert.deepStrictEqual(out.wakes_suppressed.filter((w) => w.reason === 'delivered by worker_wait'), []);
    const c = clock();
    const r = await createRunWait({ core, runId: RUN, dataDir: sb.dataDir, pollMs: 100, clock: c }).wait({ ms: 300, t0: 0, workers: [] });
    assert.strictEqual(r.exceptions, undefined, 'the wake delivered it');
    assert.strictEqual(r.timed_out, true);
  } finally { cleanup(root); }
});

// One rule for "planned", from the store: a plan that arrives by a later task_create (not in the spec) still makes a death a claimed delivery.
test('no plan in the spec, a planned task in the store, a death in the first poll: delivered once, by the wait', async () => {
  const { root, sb, core } = setup();
  try {
    core.worker = { ...(core.worker || {}), list: async () => ({ workers: [{ id: 'w2', run_id: RUN, state: 'dead', turns: 3, seq: 2, pid: 111, pid_created: 5, exit_code: 1, exit_signal: null, death_established_by: 'exit' }] }) };
    assert.ok(D.claimException({ dataDir: sb.dataDir, runId: RUN, uid: D.deathUid('w2', 'death', D.lifeOf(111, 5)) }), 'worker_wait named the death');
    const spec = (policy) => ({ worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null, policy,
      startupTimeoutMs: 8000, timeoutMs: 60000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000 });
    const out = await withFake(() => runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: spec(false) }));
    assert.deepStrictEqual(out.wakes.filter((w) => w.event === 'death'), [], 'not written to stdin');
    assert.strictEqual(out.wakes_suppressed.filter((w) => w.event === 'death' && w.reason === 'delivered by worker_wait').length, 1, JSON.stringify(out.wakes_suppressed));
  } finally { cleanup(root); }
});

test('a run with no plan anywhere claims nothing for a death: the wake is written as before', async () => {
  const { root, sb, core } = setup();
  try {
    core.task = { ...(core.task || {}), list: async () => ({ tasks: [] }) };
    core.worker = { ...(core.worker || {}), list: async () => ({ workers: [{ id: 'w2', run_id: RUN, state: 'dead', turns: 3, seq: 2, pid: 111, pid_created: 5, exit_code: 1, exit_signal: null, death_established_by: 'exit' }] }) };
    const out = await withFake(() => runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
      worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null, policy: false,
      startupTimeoutMs: 8000, timeoutMs: 60000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000 } }));
    assert.strictEqual(out.wakes.filter((w) => w.event === 'death').length, 1, JSON.stringify(out.wakes));
    assert.strictEqual(fs.existsSync(`${sb.dataDir}/run-wait`), false, 'and no claim file was made');
  } finally { cleanup(root); }
});
