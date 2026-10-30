'use strict';
// policy-stamp.test.cjs -- ADR 0072 decisions 2, 3 and 5 in the core: a row a policy step writes carries acted_by, the trigger and the
// revision, taken from the open claim the harness view names and from nothing a caller passes; every other write resets them; the
// orchestrator and a policy step acting on one trigger leave exactly one effect, in both orders (each order forced by stalling one
// writer between its read and its write, the fault-injection seam of policy-stamp.cjs); and a policy merge goes only into the run's own
// integration branch. Real core, sandbox store, throwaway repositories; no sleeps and no load.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode, guarded } = require('./worktree-helpers.cjs');

const test = guarded(nodeTest);
const { openCore } = core('index.cjs');
const PS = core('policy-stamp.cjs');

let dir, orch, op, h;
const workers = new Map();
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const RUN = 'test-run';
const raw = (sql, ...a) => orch.owner.engine.store.p(sql).all(...a);

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  h = orch.harness();
});

after(async () => {
  PS.setHooksForTest(null);
  for (const c of workers.values()) await c.close();
  await op.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function worker(id) {
  if (workers.has(id)) return workers.get(id);
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree: dir });
  const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.set(id, c);
  return c;
}

// A claim of a step on a trigger; -> the claim's seq.
async function claim(step, trigger, extra = {}) { return (await h.policy.claim({ step, trigger, ...extra })).row.seq; }
const taskTrigger = async (id) => ({ table: 'task', id, seq: (await orch.task.get({ task_id: id })).seq });

// Stalls the first call that reaches `point` and matches `pred`, until release(). `reached` resolves when it is stalled.
function stall(point, pred) {
  let release; let reached;
  const gate = new Promise((r) => { release = r; });
  const there = new Promise((r) => { reached = r; });
  let taken = false;
  PS.setHooksForTest({ at: async (p, info) => { if (p === point && !taken && pred(info)) { taken = true; reached(); await gate; } } });
  return { release, reached: there };
}
const policyCall = (i) => i.policy_step !== null;
const orchestratorCall = (i) => i.policy_step === null;

// ---- stamps ---------------------------------------------------------------------------------------------------------------------

test('a policy assign stamps its lease and task rows from the claim; the next write that is not the step\'s resets them', async () => {
  await worker('wk-1');
  const t = await orch.task.create({ spec: 's1 work' });
  const trig = await taskTrigger(t.id);
  const seq = await claim('fix', trig, { task_id: t.id, policy_rev: 3 });
  const out = await h.policyAs(seq).task.assign({ task_id: t.id, worker_id: 'wk-1' });
  for (const row of [out.new_lease, out.task]) {
    assert.strictEqual(row.acted_by, 'policy');
    assert.deepStrictEqual(row.trigger, trig);
    assert.strictEqual(row.policy_rev, 3);
  }
  // the lease keep-alive renews the lease: the renewed version is the keep-alive's write, not the step's
  const w = await worker('wk-1');
  const renewed = await w.lease.renew({ lease_id: out.new_lease.id });
  assert.deepStrictEqual([renewed.acted_by, renewed.trigger, renewed.policy_rev], [null, null, null]);
  // the orchestrator's next write to the task: acted_by and trigger reset, the plan's revision carried
  const after1 = (await orch.task.cancel({ task_id: t.id, reason: 'stamp reset' })).task;
  assert.deepStrictEqual([after1.acted_by, after1.trigger, after1.policy_rev], [null, null, 3]);
  const leases = raw('SELECT acted_by, trigger, policy_rev FROM lease WHERE task_id = ? ORDER BY seq', t.id);
  assert.deepStrictEqual(leases.map((l) => l.acted_by), ['policy', null, null], 'the grant is stamped; the renewal and the release are not');
  assert.ok(leases.slice(1).every((l) => l.trigger === null && l.policy_rev === null));
  await h.policy.finish({ seq, outcome: 'done', row_ref: `lease:${out.new_lease.id}` });
});

test('a stamp is never taken from arguments, a tool caller or a claim that is not open', async () => {
  await worker('wk-1');
  // arguments: the fields are not arguments of any write, and nothing in the row comes from them
  const t = await orch.task.create({ spec: 's2 work', acted_by: 'policy', trigger: { table: 'task', id: 'x', seq: 1 }, policy_rev: 9 });
  assert.deepStrictEqual([t.acted_by, t.trigger, t.policy_rev], [null, null, null]);
  const seq = await claim('fix', await taskTrigger(t.id));
  // a tool-channel caller naming a step is refused at the engine
  await rejectsCode(orch._invoke('task.assign', { task_id: t.id, worker_id: 'wk-1' }, { ...orch.caller, policy_step: seq }), 'E_ARGS');
  await rejectsCode(orch._invoke('task.assign', { task_id: t.id, worker_id: 'wk-1' }, { ...orch.caller, channel: 'tool', policy_step: seq }), 'E_ARGS');
  // a step of another run, and a step already finished, name no open claim
  const other = Number(orch.owner.engine.store.p("INSERT INTO policy_step(run_id, step, trigger_table, trigger_id, trigger_seq, outcome, at) VALUES ('other-run', 'fix', 'task', 'zz', 1, 'started', 1)").run().lastInsertRowid);
  await rejectsCode(h.policyAs(other).task.assign({ task_id: t.id, worker_id: 'wk-1' }), 'E_ARGS');
  await h.policy.finish({ seq, outcome: 'skipped', error: 'test' });
  await rejectsCode(h.policyAs(seq).task.assign({ task_id: t.id, worker_id: 'wk-1' }), 'E_ARGS');
  assert.strictEqual(raw('SELECT COUNT(*) AS n FROM lease WHERE task_id = ?', t.id)[0].n, 0, 'nothing was written');
  assert.throws(() => h.policyAs(0), (e) => e.code === 'E_ARGS');
});

// ---- the one-trigger rule: assign --------------------------------------------------------------------------------------------------

test('assign, policy first: the orchestrator\'s call, stalled until the step has written, answers the step\'s lease (existing) and writes none', async () => {
  await worker('wk-2');
  const t = await orch.task.create({ spec: 'a1 work' });
  const seq = await claim('re_review', await taskTrigger(t.id));
  const s = stall('assign.beforeTx', orchestratorCall);
  const late = orch.task.assign({ task_id: t.id, worker_id: 'wk-2' });
  await s.reached;
  const first = await h.policyAs(seq).task.assign({ task_id: t.id, worker_id: 'wk-2' });
  s.release();
  const second = await late;
  PS.setHooksForTest(null);
  assert.strictEqual(second.existing, true);
  assert.strictEqual(second.superseded, undefined);
  assert.strictEqual(second.new_lease.id, first.new_lease.id);
  assert.strictEqual(second.new_lease.acted_by, 'policy');
  assert.strictEqual(raw('SELECT COUNT(*) AS n FROM lease WHERE task_id = ?', t.id)[0].n, 1, 'exactly one lease row');
  assert.strictEqual(raw("SELECT COUNT(*) AS n FROM task WHERE id = ? AND state = 'assigned'", t.id)[0].n, 1);
});

test('assign, orchestrator first: the step, stalled until the orchestrator has written, is superseded and writes no lease', async () => {
  await worker('wk-2');
  const t = await orch.task.create({ spec: 'a2 work' });
  const seq = await claim('re_review', await taskTrigger(t.id));
  const s = stall('assign.beforeTx', policyCall);
  const late = h.policyAs(seq).task.assign({ task_id: t.id, worker_id: 'wk-2' });
  await s.reached;
  const first = await orch.task.assign({ task_id: t.id, worker_id: 'wk-2' });
  s.release();
  const second = await late;
  PS.setHooksForTest(null);
  assert.deepStrictEqual([second.existing, second.superseded], [true, true]);
  assert.strictEqual(second.new_lease.id, first.new_lease.id);
  assert.strictEqual(second.new_lease.acted_by, null);
  assert.strictEqual(raw('SELECT COUNT(*) AS n FROM lease WHERE task_id = ?', t.id)[0].n, 1, 'exactly one lease row');
  const done = await h.policy.finish({ seq, outcome: 'superseded', row_ref: `lease:${first.new_lease.id}` });
  assert.strictEqual(done.row.outcome, 'superseded');
});

test('the orchestrator-first tie-break is a seam: replaced, the step is refused and nothing is written; another worker is the orchestrator\'s reassignment', async () => {
  await worker('wk-2'); await worker('wk-3');
  const t = await orch.task.create({ spec: 'a3 work' });
  const seq = await claim('fix', await taskTrigger(t.id));
  const lease = (await orch.task.assign({ task_id: t.id, worker_id: 'wk-2' })).new_lease;
  const { err } = core('errors.cjs');
  PS.setHooksForTest({ onOrchestratorFirst: () => { throw err('E_BUSY', 'the orchestrator holds this trigger'); } });
  try { await rejectsCode(h.policyAs(seq).task.assign({ task_id: t.id, worker_id: 'wk-2' }), 'E_BUSY'); } finally { PS.setHooksForTest(null); }
  assert.strictEqual(raw('SELECT COUNT(*) AS n FROM lease WHERE task_id = ?', t.id)[0].n, 1);
  // a policy lease, then the orchestrator names another worker: that is its decision, and it is written (reset stamps)
  const t2 = await orch.task.create({ spec: 'a3 other' });
  const seq2 = await claim('fix', await taskTrigger(t2.id));
  const p = await h.policyAs(seq2).task.assign({ task_id: t2.id, worker_id: 'wk-2' });
  const re = await orch.task.assign({ task_id: t2.id, worker_id: 'wk-3' });
  assert.strictEqual(re.existing, undefined);
  assert.notStrictEqual(re.new_lease.id, p.new_lease.id);
  assert.deepStrictEqual([re.new_lease.acted_by, re.task.acted_by, re.new_lease.trigger], [null, null, null]);
  assert.ok(lease.id);
});

// ---- the one-trigger rule: fix_from_review -------------------------------------------------------------------------------------------

// A task judged done and a review over it refuted, ready for task.fixFromReview. -> { work, review }
async function refuted(label) {
  const w = await worker('plain-coder');
  const work = await orch.task.create({ spec: `${label} work`, acceptance: PASS });
  let a = await orch.task.assign({ task_id: work.id, worker_id: 'plain-coder' });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h' } });
  assert.strictEqual((await orch.task.evaluate({ task_id: work.id, worktree: dir })).state, 'done');
  const review = await orch.task.create({ spec: `${label} review`, depends_on: [work.id], acceptance: { verdict: true } });
  const j = await worker(`judge-${label}`);
  a = await orch.task.assign({ task_id: review.id, worker_id: `judge-${label}` });
  await j.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict: 'refuted', summary: `${label} refuted`, findings: [{ severity: 'blocking', clause: 'a', note: `${label} finding` }] } });
  assert.strictEqual((await orch.task.evaluate({ task_id: review.id, worktree: dir })).results.checks.at(-1).passed, false);
  return { work, review };
}
const fixesOf = (workId) => raw('SELECT DISTINCT id FROM task WHERE repairs = ?', workId);

test('fix, orchestrator first: the step, stalled until the orchestrator\'s fix is written, is superseded and makes no second fix', async () => {
  const { work, review } = await refuted('f1');
  const seq = await claim('fix', await taskTrigger(review.id), { task_id: work.id, policy_rev: 1 });
  const s = stall('fix.beforeWrite', policyCall);
  const late = h.policyAs(seq).task.fixFromReview({ review_id: review.id });
  await s.reached;
  const first = await orch.task.fixFromReview({ review_id: review.id });
  s.release();
  const second = await late;
  PS.setHooksForTest(null);
  assert.deepStrictEqual([second.existing, second.superseded, second.id], [true, true, first.id]);
  assert.strictEqual(first.acted_by, null);
  assert.strictEqual(fixesOf(work.id).length, 1, 'exactly one fix task');
  await h.policy.finish({ seq, outcome: 'superseded', row_ref: `task:${first.id}` });
});

test('fix, policy first: the orchestrator\'s call, stalled until the step has written, answers the step\'s fix (existing); the fix is stamped', async () => {
  const { work, review } = await refuted('f2');
  const trig = await taskTrigger(review.id);
  const seq = await claim('fix', trig, { task_id: work.id, policy_rev: 2 });
  const s = stall('fix.beforeWrite', orchestratorCall);
  const late = orch.task.fixFromReview({ review_id: review.id });
  await s.reached;
  const first = await h.policyAs(seq).task.fixFromReview({ review_id: review.id });
  s.release();
  const second = await late;
  PS.setHooksForTest(null);
  assert.strictEqual(first.existing, undefined);
  assert.deepStrictEqual([first.acted_by, first.trigger, first.policy_rev], ['policy', trig, 2]);
  assert.deepStrictEqual([second.existing, second.superseded, second.id], [true, undefined, first.id]);
  assert.strictEqual(fixesOf(work.id).length, 1, 'exactly one fix task');
  await h.policy.finish({ seq, outcome: 'done', row_ref: `task:${first.id}` });
});

// ---- merge: the branch, and the one-trigger rule -----------------------------------------------------------------------------------------

async function doneTask(repo, files) {
  const t = await orch.task.create({ spec: `write ${Object.keys(files).join(', ')}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  for (const [rel, text] of Object.entries(files)) write(w.path, rel, text);
  commit(w.path, `task ${t.id}`);
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  return t.id;
}
const integrations = () => raw('SELECT id, seq, state, acted_by, trigger, policy_rev, into_branch, repo FROM integration ORDER BY seq');

test('a policy merge names no force, approval, approved_in_chat, take_over, or any branch but belay/integrate/<run>; nothing is written', async () => {
  const seq = await claim('integrate', { table: 'task', id: 'review-x', seq: 4 });
  const p = h.policyAs(seq);
  const before = integrations().length;
  for (const bad of [{ into: 'main' }, { into: 'belay/integrate/other-run' }, { force: true, reason: 'x' }, { approval: 'perm-1' }, { approved_in_chat: true }, { take_over: true }]) {
    const e = await rejectsCode(p.integration.merge({ task_ids: ['no-such-task'], ...bad }), 'E_ARGS');
    assert.match(e.message, /policy step/, JSON.stringify(bad));
  }
  // the run's own spelling is accepted by the guard: the call then fails on its task, not on the branch
  await rejectsCode(p.integration.merge({ task_ids: ['no-such-task'], into: `belay/integrate/${RUN}` }), 'E_NOT_FOUND');
  assert.strictEqual(integrations().length, before);
});

test('merge, policy first then the orchestrator: one integration, its rows stamped by the step, the orchestrator answered with it; a later write resets', async () => {
  const repo = makeRepo(dir);
  const a = await doneTask(repo, { 'a.txt': 'a\n' });
  const trig = { table: 'task', id: 'review-a', seq: 7 };
  const seq = await claim('integrate', trig, { task_id: a, policy_rev: 4 });
  const s = stall('merge.beforeLock', orchestratorCall);
  const late = orch.integration.merge({ task_ids: [a] });
  await s.reached;
  const first = await h.policyAs(seq).integration.merge({ task_ids: [a] });
  s.release();
  const second = await late;
  PS.setHooksForTest(null);
  assert.deepStrictEqual([first.into_branch, first.state, first.acted_by, first.trigger, first.policy_rev], [`belay/integrate/${RUN}`, 'evaluated', 'policy', trig, 4]);
  assert.deepStrictEqual([second.existing, second.superseded, second.id], [true, undefined, first.id]);
  const rowsOf = integrations().filter((r) => r.id === first.id);
  assert.deepStrictEqual(rowsOf.map((r) => [r.state, r.acted_by]), [['merging', 'policy'], ['evaluated', 'policy']], 'one merge: its two versions, both the step\'s');
  assert.strictEqual(integrations().filter((r) => r.repo === repo).length, 2, 'the orchestrator\'s call wrote no row');
  assert.strictEqual(git(repo, 'rev-parse', 'main'), git(repo, 'merge-base', 'main', first.head_sha), 'main did not move');
  await h.policy.finish({ seq, outcome: 'done', row_ref: `integration:${first.id}` });
  const removed = await op.integration.remove({ id: first.id });
  assert.deepStrictEqual([removed.acted_by, removed.trigger, removed.policy_rev], [null, null, null]);
});

test('merge, orchestrator first then the step: the step, stalled until the orchestrator has merged, is superseded and writes no row', async () => {
  const repo = makeRepo(dir);
  const b = await doneTask(repo, { 'b.txt': 'b\n' });
  const seq = await claim('integrate', { table: 'task', id: 'review-b', seq: 2 }, { task_id: b });
  const s = stall('merge.beforeLock', policyCall);
  const late = h.policyAs(seq).integration.merge({ task_ids: [b] });
  await s.reached;
  const first = await orch.integration.merge({ task_ids: [b] });
  s.release();
  const second = await late;
  PS.setHooksForTest(null);
  assert.deepStrictEqual([second.existing, second.superseded, second.id], [true, true, first.id]);
  assert.strictEqual(first.acted_by, null);
  assert.strictEqual(integrations().filter((r) => r.repo === repo).length, 2, "only the orchestrator's two versions: the step wrote none");
  await h.policy.finish({ seq, outcome: 'superseded', row_ref: `integration:${first.id}` });
});
