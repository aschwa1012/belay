'use strict';
require('../helpers/tmp.cjs');
// policy-review.test.cjs — the review step (ADR 0072 decision 1, decision 4) and the budget rule (ADR 0075 decision 1) against the REAL core
// and, where a worker is spawned, the REAL run manager over the fake claude executable. The review of a done work goes to the plan's worker or
// to a worker belay spawns through manager.spawn; the claim records the worker and the turn the step started, so the step log joins the turn's
// cost; a spawn or a send is refused at the budget's soft threshold (E9) and a spawn while the run is paused. No model, no sleep: every wait is
// on the event it needs. BELAY_KEEP_SANDBOX=<dir> keeps each case's store and run receipt for R1's h3.cjs and h4.cjs.

const { test: nodeTest } = require('node:test');
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

const test = guarded(nodeTest);
const { openCore } = core('index.cjs');
const RUN = 'test-run';
const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split('\\').join('/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json').split('\\').join('/');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const REST = { fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };

async function env(label) {
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
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
async function workDone(e, plan, { builder = 'builder-1', label = 'w' } = {}) {
  const repo = makeRepo(e.dir);
  const t = await e.orch.task.create({ spec: `${label}: write a.txt`, acceptance: PASS, policy: plan });
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

test('review to a named worker: the verdict task is made under the claim and assigned to that worker; the claim names the worker and its next turn', async () => {
  const e = await env('review-assigned');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await e.worker('rv');
    const spent = { n: 0 };
    const spy = { ...e.h, usage: { spend: (a) => { spent.n += 1; return e.h.usage.spend(a); } } };
    const out = await e.exec({ turnOf: async (id) => (id === 'rv' ? 3 : null) }, spy).tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['review', 'done']]);
    const made = out.steps[0].row_ref.replace('task:', '');
    const row = latest(e, 'task', made);
    assert.deepStrictEqual([row.acted_by, JSON.parse(row.depends_on), JSON.parse(row.acceptance).verdict], ['policy', [work.id], true]);
    const lease = e.raw('SELECT holder, acted_by FROM lease WHERE task_id = ? ORDER BY seq', made)[0];
    assert.deepStrictEqual([lease.holder, lease.acted_by], ['rv', 'policy']);
    const [step] = stepRows(e);
    assert.deepStrictEqual([step.step, step.trigger_id, step.worker_id, step.turn], ['review', work.id, 'rv', 3]);
    assert.strictEqual(spent.n, 0, 'a run with no budget reads no spend');
    assert.deepStrictEqual((await e.exec({}, spy).tick()).steps, [], 'the next pass finds the trigger taken');
    assert.strictEqual(reviewsOf(e, work.id).length, 1);
  } finally { await e.close(); }
});

test('review to a worker that cannot take it writes nothing and is an exception (E8); a work with no review in its plan makes no review step', async () => {
  const e = await env('review-unavailable');
  try {
    const { work } = await workDone(e, { review: { worker: 'gone' }, ...REST });
    const out = await e.exec().tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['review', 'exception']]);
    assert.match(stepRows(e)[0].error, /reviewer gone has no worker row/);
    assert.strictEqual(reviewsOf(e, work.id).length, 0, 'no review task was made for a worker that could not take it');
    const w = (await wakesOf(e)).filter((x) => x.exception === 'E8');
    assert.deepStrictEqual(w.map((x) => [x.field, x.task_id]), [['review', work.id]]);
  } finally { await e.close(); }
});

test('the orchestrator making the review between the claim and the step: the claim ends superseded naming its review, and the step writes nothing', async () => {
  const e = await env('review-superseded');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await e.worker('rv');
    let mine = null;
    // policyAs(seq) is called after the step is claimed and re-checked; the orchestrator's review lands on the step's first read.
    const seam = { ...e.h, policyAs: (seq) => { const v = e.h.policyAs(seq); return { ...v, task: { ...v.task, list: async (a) => { if (!mine) mine = await e.orch.task.create({ spec: 'my review', acceptance: { verdict: true }, depends_on: [work.id] }); return v.task.list(a); } } }; } };
    const out = await e.exec({}, seam).tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome, s.row_ref]), [['review', 'superseded', `task:${mine.id}`]]);
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM task WHERE acted_by = 'policy'")[0].n, 0, 'the step made no task');
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM lease WHERE acted_by = 'policy'")[0].n, 0, 'and assigned nothing');
  } finally { await e.close(); }
});

// The adapter's own wiring (policy-wire.cjs) over a real manager: the spawn is the manager's, the assign is compose's, and the turn is the manager's count.
function wired(e, m) { const x = wire.start({ core: e.orch, manager: m, opts: { runId: RUN, dataDir: `${e.dir}/data` }, run: null }); x.arm(); return x; } // armed by the test: the wiring arms on its own read of the task rows, which is asynchronous

test('review by spawn: the manager launches the plan\'s reviewer, the lease it holds is the step\'s, the claim names it and turn 1, and the log joins that turn\'s cost', async () => {
  const e = await env('review-spawned');
  try {
    const { work } = await workDone(e, { review: { spawn: { agent_type: 'reviewer', worker_id: 'rev-1' } }, ...REST });
    const m = e.manager();
    const x = wired(e, m);
    const out = await x.tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['review', 'done']]);
    const made = out.steps[0].row_ref.replace('task:', '');
    const live = m._worker('rev-1');
    assert.ok(live && live.pid > 0, 'the worker is in the manager\'s table: the harness launched it');
    const wrow = (await e.orch.worker.get({ worker_id: 'rev-1' }));
    assert.strictEqual(wrow.pid, live.pid);
    assert.strictEqual(wrow.agent_type, 'reviewer');
    const lease = e.raw('SELECT holder, acted_by, "trigger" FROM lease WHERE task_id = ? ORDER BY seq', made)[0];
    assert.deepStrictEqual([lease.holder, lease.acted_by], ['rev-1', 'policy'], 'assigned under the claim, not by the manager\'s own core');
    assert.deepStrictEqual(JSON.parse(lease.trigger), { table: 'task', id: work.id, seq: JSON.parse(lease.trigger).seq });
    const [step] = stepRows(e);
    assert.deepStrictEqual([step.worker_id, step.turn, step.outcome, step.row_ref], ['rev-1', 1, 'done', `task:${made}`]);
    // The reviewer's first turn is turn 1: a usage row for it is what the log joins.
    await m._waitTurn('rev-1', 20000);
    await e.orch.usage.record({ worker_id: 'rev-1', turn: 1, cost_usd: 0.42, substrate: 'claude-code', cost_basis: 'delta-of-cumulative' });
    const log = await e.orch.policy.log({});
    assert.deepStrictEqual(log.steps.map((s) => [s.step, s.worker_id, s.turn, s.turn_cost_usd]), [['review', 'rev-1', 1, 0.42]]);
    assert.match(require('../../src/core/policy-log.cjs').line(log.steps[0]), /\(turn 1 \$0\.42\)/, 'the printed step line carries the cost');
    assert.deepStrictEqual((await x.tick()).steps, []);
    assert.strictEqual(e.raw('SELECT COUNT(*) AS n FROM worker WHERE id = ?', 'rev-1')[0].n > 0, true);
  } finally { await e.close(); }
});

test('a spawn id made by belay is its own: a spawn with no worker_id gets rev-<hex>, recorded on the claim before the spawn', async () => {
  const e = await env('review-generated-id');
  try {
    const { work } = await workDone(e, { review: { spawn: { agent_type: 'reviewer' } }, ...REST });
    const m = e.manager();
    const out = await wired(e, m).tick();
    assert.deepStrictEqual(out.steps.map((s) => s.outcome), ['done']);
    const [step] = stepRows(e);
    assert.match(step.worker_id, /^rev-[0-9a-f]{8}$/);
    assert.ok(m._worker(step.worker_id), 'that is the worker the manager launched');
    assert.strictEqual(e.raw('SELECT holder FROM lease WHERE task_id = ?', step.row_ref.replace('task:', ''))[0].holder, step.worker_id);
    assert.strictEqual(reviewsOf(e, work.id).length, 1);
  } finally { await e.close(); }
});

test('a spawn the manager refuses (the run paused just before it) is an exception naming the review task it left and the pause; no worker is launched', async () => {
  const e = await env('review-paused');
  try {
    const { work } = await workDone(e, { review: { spawn: { agent_type: 'reviewer', worker_id: 'rev-p' } }, ...REST });
    const m = e.manager();
    const spawnFor = (stepCore) => async (a) => { await e.orch.run.setPaused({ paused: true }); return STEPS.spawnFor(m)(stepCore)(a); };
    const out = await e.exec({ spawnFor }).tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['review', 'exception']]);
    assert.match(stepRows(e)[0].error, /could not be spawned: E_PAUSED/);
    assert.match(stepRows(e)[0].row_ref, /^task:/, 'the review task it made stays named');
    assert.strictEqual(m._worker('rev-p'), undefined, 'no worker was launched');
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM worker WHERE id = 'rev-p'")[0].n, 0, 'and no worker row written');
    const w = (await wakesOf(e)).filter((x) => x.exception === 'E8');
    assert.deepStrictEqual(w.map((x) => x.task_id), [work.id]);
  } finally { await e.close(); }
});

test('a spawn that fails (the id is taken) is an exception that keeps the review task it made', async () => {
  const e = await env('review-spawn-fails');
  try {
    await workDone(e, { review: { spawn: { agent_type: 'reviewer', worker_id: 'taken' } }, ...REST });
    await e.worker('taken');
    const m = e.manager();
    const out = await e.exec({ spawnFor: STEPS.spawnFor(m) }).tick();
    assert.deepStrictEqual(out.steps.map((s) => s.outcome), ['exception']);
    assert.match(stepRows(e)[0].error, /could not be spawned/);
    assert.strictEqual(m._worker('taken'), undefined);
  } finally { await e.close(); }
});

// ---- the budget rule -------------------------------------------------------------------------------------------------------------------------

const readers = (usd) => ({ spend: async () => ({ usd }) });
test('spendForGuard: reported plus the orchestrator\'s counted cost, plus the in-flight estimate only when the record says it counts it; no limit reads nothing', async () => {
  const none = { spend: async () => { throw new Error('read'); } };
  assert.strictEqual(await BUD.spendForGuard({ budget_usd: null, budget: null }, none), null, 'no budget, no read');
  const run = (extra = {}, rec = {}) => ({ budget_usd: 10, budget: { soft_threshold: 0.9, counts_in_flight: false, ...rec }, ...extra });
  assert.strictEqual((await BUD.spendForGuard(run(), readers(8.9))).over, false);
  assert.strictEqual((await BUD.spendForGuard(run(), readers(9))).over, true, 'at the threshold');
  assert.strictEqual((await BUD.spendForGuard(run({}, { orchestrator: { counted: true, usd: 1.5 } }), readers(7.6))).over, true, 'the orchestrator\'s reported cost counts');
  const flight = { in_flight_workers: { usd: 2 }, orchestrator: { counted: true, usd: 0, in_flight_usd: 0.5 } };
  assert.strictEqual((await BUD.spendForGuard(run({}, flight), readers(7))).over, false, 'in flight is not counted unless the record says so');
  const f = await BUD.spendForGuard(run({}, { ...flight, counts_in_flight: true }), readers(7));
  assert.deepStrictEqual([f.over, f.in_flight, f.spent], [true, 2.5, 9.5]);
  assert.strictEqual((await BUD.spendForGuard(run({}, { overrides: { run: true } }), readers(99))), null, 'a limit the operator overrode is not a limit');
  const t = await BUD.spendForGuard({ budget_usd: null, budget: { tasks: { T1: 4 } } }, readers(3.7), 'T1');
  assert.deepStrictEqual([t.scope, t.over], ['task', true]);
  assert.match(await BUD.refusal(run(), readers(9.5)), /^E_BUDGET: the run budget is at its soft threshold \(\$9\.50 reported of \$10\.00, threshold 90%\)/);
});

async function budgeted(e, spendUsd, record = {}) {
  const operator = await openCore({ dataDir: `${e.dir}/data`, caller: callerFor('operator'), embed: false });
  try {
    await operator.run.setBudget({ budget_usd: 10, budget: { soft_threshold: 0.9, counts_in_flight: false, events: [], ...record } });
    if (spendUsd) await operator.usage.record({ worker_id: 'someone', turn: 1, cost_usd: spendUsd, substrate: 'claude-code', cost_basis: 'delta-of-cumulative' });
  } finally { await operator.close(); }
}

test('at the soft threshold a review is not spawned: the claim ends exception E_BUDGET, no review task and no worker are made, and the wake is E9 (halting nothing)', async () => {
  const e = await env('review-budget');
  try {
    const { work } = await workDone(e, { review: { spawn: { agent_type: 'reviewer', worker_id: 'rev-b' } }, ...REST });
    await budgeted(e, 9.2);
    const m = e.manager();
    const out = await wired(e, m).tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['review', 'exception']]);
    const [step] = stepRows(e);
    assert.match(step.error, /^E_BUDGET: the run budget is at its soft threshold \(\$9\.20 reported of \$10\.00/);
    assert.strictEqual(step.row_ref, null, 'nothing was written');
    assert.strictEqual(m._worker('rev-b'), undefined);
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM worker WHERE id = 'rev-b'")[0].n, 0);
    assert.strictEqual(reviewsOf(e, work.id).length, 0);
    const ws = await wakesOf(e);
    assert.deepStrictEqual(ws.map((x) => [x.exception, x.field, x.task_id]), [['E9', 'review', work.id]]);
    const text = PW.wakeOf(ws[0]).text;
    assert.match(text, /^belay: exception E9, task .*field review\. Step review not taken: E_BUDGET/);
    assert.ok(Buffer.byteLength(text) <= 221);
    assert.strictEqual(PW.haltedIds(ws, await tasksNow(e)).size, 0, 'E9 halts no task');
    assert.deepStrictEqual((await e.exec().tick()).steps, [], 'and the step is not tried again');
  } finally { await e.close(); }
});

test('the same step below the threshold is taken, and the in-flight estimate counts only when the record says so', async () => {
  const e = await env('review-budget-below');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await e.worker('rv');
    await budgeted(e, 7, { in_flight_workers: { usd: 2.5 }, counts_in_flight: false });
    assert.deepStrictEqual((await e.exec().tick()).steps.map((s) => s.outcome), ['done'], 'reported $7 + unread in flight $2.5 is under $9');
    assert.strictEqual(reviewsOf(e, work.id).length, 1);
  } finally { await e.close(); }
});

test('with the in-flight lever on, a review sent to a named worker is refused when reported plus in flight reaches the threshold', async () => {
  const e = await env('review-budget-inflight');
  try {
    const { work } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    await e.worker('rv');
    await budgeted(e, 7, { in_flight_workers: { usd: 2.5 }, counts_in_flight: true });
    const out = await e.exec().tick();
    assert.deepStrictEqual(out.steps.map((s) => s.outcome), ['exception']);
    assert.match(stepRows(e)[0].error, /\$7\.00 reported \+ \$2\.50 in flight \(estimate\) of \$10\.00/);
    assert.strictEqual(reviewsOf(e, work.id).length, 0);
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM lease WHERE acted_by = 'policy'")[0].n, 0);
  } finally { await e.close(); }
});

test('through the adapter\'s wiring a review sent to a live worker is delivered by compose, and the claim records the turn the manager counts next', async () => {
  const e = await env('review-wired-assign');
  try {
    const { work, tree } = await workDone(e, { review: { worker: 'rv' }, ...REST });
    const m = e.manager();
    await m.spawn({ substrate: 'claude-code', worktree: tree, prompt: 'stand by', worker_id: 'rv', agent_type: 'reviewer' });
    await m._waitTurn('rv', 20000);
    const next = m._worker('rv').turns + 1;
    const out = await wired(e, m).tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['review', 'done']]);
    const [step] = stepRows(e);
    assert.deepStrictEqual([step.worker_id, step.turn], ['rv', next]);
    assert.strictEqual(e.raw('SELECT holder FROM lease WHERE task_id = ? ORDER BY seq', out.steps[0].row_ref.replace('task:', ''))[0].holder, 'rv');
    assert.strictEqual(reviewsOf(e, work.id).length, 1);
  } finally { await e.close(); }
});
