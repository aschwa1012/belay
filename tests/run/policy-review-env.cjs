'use strict';
// policy-review-env.cjs — the sandbox, the executor and the fixtures the policy review tests share (policy-review.test.cjs and
// policy-review-fixes.test.cjs): a real core, a real run manager over the fake claude executable, a work task judged done under a plan.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { makeRepo, write, commit, guarded } = require('../core/worktree-helpers.cjs');
const { createPolicyExecutor } = require('../../src/run/policy-exec.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const STEPS = require('../../src/run/policy-steps-run.cjs');
const BUD = require('../../src/run/policy-budget.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const { wakeRecord } = require('../../src/run/wake-record.cjs');
const wire = require('../../src/mcp/policy-wire.cjs');

const { openCore } = core('index.cjs');
const RUN = 'test-run';
const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split('\\').join('/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json').split('\\').join('/');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const REST = { fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };

async function env(label, attach = {}) {
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, ...attach });
  const op = await openCore({ dataDir: `${dir}/data`, caller: callerFor('operator'), embed: false });
  const e = { dir, orch, op, h: orch.harness(), workers: new Map(), mgrs: [] };
  e.raw = (sql, ...a) => orch.owner.engine.store.p(sql).all(...a);
  e.worker = async (id, worktree = dir) => {
    if (e.workers.has(id)) return e.workers.get(id);
    await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree });
    const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
    e.workers.set(id, c);
    return c;
  };
  e.manager = () => { const m = createRunManager({ core: orch, dataDir: `${dir}/data`, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } }); e.mgrs.push(m); return m; };
  // The executor with the adapter's assign reduced to the core call (no process is told), and the spawn over a real manager when one is given.
  e.exec = (extra = {}, c = e.h) => { const x = createPolicyExecutor({ core: c, runId: RUN, assignFor: (stepCore) => async (a) => stepCore.task.assign(a), closeWaitMs: 0, identity: { pid: process.pid, created: 'own' }, ...extra }); x.arm(); return x; };
  e.close = async () => {
    // The wakes the rows owe, as the run receipt lists them, for the checkers (kept only under BELAY_KEEP_SANDBOX).
    let receipt = null;
    if (process.env.BELAY_KEEP_SANDBOX) { const ws = PW.derive({ runId: RUN, tasks: (await e.h.task.list({})).tasks, integrations: [], steps: (await e.h.policy.list({})).rows, failures: [] }).map(PW.wakeOf); receipt = { run_id: RUN, wakes: ws.map((w, i) => wakeRecord(w, w.text, 1000 + i, true)) }; }
    for (const m of e.mgrs) await m.shutdown().catch(() => {});
    for (const c of e.workers.values()) await c.close();
    await op.close();
    try { await orch.shutdownOwner(); } catch { /* the manager's shutdown stopped the owner already */ }
    await orch.close();
    if (receipt) { const to = `${process.env.BELAY_KEEP_SANDBOX}/${label}`; fs.cpSync(`${dir}/data`, to, { recursive: true }); fs.writeFileSync(`${to}/receipt.json`, JSON.stringify(receipt, null, 2)); }
    cleanup(dir);
  };
  return e;
}

// A work task under `plan`, with a belay worktree (the tree a spawned reviewer starts in), handed back by `builder` and judged done by the release evaluation.
async function workDone(e, plan, { builder = 'builder-1', label = 'w', create = {} } = {}) {
  const repo = makeRepo(e.dir);
  const t = await e.orch.task.create({ spec: `${label}: write a.txt`, acceptance: PASS, policy: plan, ...create });
  const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(wt.path, 'a.txt', 'a\n'); commit(wt.path, `task ${t.id}`);
  const w = await e.worker(builder, wt.path);
  const a = await e.orch.task.assign({ task_id: t.id, worker_id: builder });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h' } });
  const done = await e.h.task.evaluate({ task_id: t.id, trigger: 'release' });
  assert.strictEqual(done.state, 'done');
  return { work: t, tree: wt.path, builder };
}
const stepRows = (e) => e.raw('SELECT * FROM policy_step ORDER BY seq');
const latest = (e, table, id) => e.raw(`SELECT * FROM ${table} WHERE id = ? ORDER BY seq DESC LIMIT 1`, id)[0];
const reviewsOf = (e, workId) => e.raw("SELECT DISTINCT id FROM task WHERE depends_on LIKE ? AND acceptance LIKE '%\"verdict\":true%'", `%${workId}%`);
const tasksNow = async (e) => (await e.h.task.list({})).tasks;
const wakesOf = async (e) => { const tasks = await tasksNow(e); return PW.derive({ runId: RUN, tasks, integrations: [], steps: (await e.h.policy.list({})).rows, failures: [] }); };

// The adapter's own wiring (policy-wire.cjs) over a real manager: the spawn is the manager's, the assign is compose's, and the turn is the manager's count.
function wired(e, m) { const x = wire.start({ core: e.orch, manager: m, opts: { runId: RUN, dataDir: `${e.dir}/data` }, run: null }); x.arm(); return x; } // armed by the test: the wiring arms on its own read of the task rows, which is asynchronous

async function budgeted(e, spendUsd, record = {}) {
  const operator = await openCore({ dataDir: `${e.dir}/data`, caller: callerFor('operator'), embed: false });
  try {
    await operator.run.setBudget({ budget_usd: 10, budget: { soft_threshold: 0.9, counts_in_flight: false, events: [], ...record } });
    if (spendUsd) await operator.usage.record({ worker_id: 'someone', turn: 1, cost_usd: spendUsd, substrate: 'claude-code', cost_basis: 'delta-of-cumulative' });
  } finally { await operator.close(); }
}

// The steps the wired executor has taken, read from the store: its ticks also come from the adapter's own writes, so the pass a test starts can
// be folded into one that is already running, and what that pass returned is not what this test's pass took.
const taken = (e) => ({ steps: e.raw('SELECT * FROM policy_step ORDER BY seq').map((s) => ({ seq: s.seq, step: s.step, task_id: s.task_id, outcome: s.outcome, row_ref: s.row_ref })) });

// Poll a condition until it holds (a bounded wait on the fact itself, not a fixed sleep).
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: the condition did not hold in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}

module.exports = { waitFor, taken, env, workDone, stepRows, latest, reviewsOf, tasksNow, wakesOf, wired, budgeted, RUN, FAKE, PASS, REST, openCore };
