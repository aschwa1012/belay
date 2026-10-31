'use strict';
// policy-review-once.test.cjs -- ADR 0072 decision 2 for the verdict review of a task: the policy step (review, re_review) and the orchestrator
// both create one, and exactly one review row stands whichever comes first. Real core, sandbox store; no sleeps and no load.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { guarded, makeRepo, git } = require('./worktree-helpers.cjs');

const test = guarded(nodeTest);
const { openCore } = core('index.cjs');
const rows = core('rows.cjs');

let dir, orch, h, repo;
const raw = (sql, ...a) => orch.owner.engine.store.p(sql).all(...a);
const VERDICT = { verdict: true };

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
  h = orch.harness();
});
after(async () => { try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); } });

async function fixOf(label) {
  const work = await orch.task.create({ spec: `${label} work` });
  return orch.task.create({ spec: `${label} fix`, repairs: work.id });
}
const reviewsOf = (id) => raw("SELECT id, acted_by FROM task t WHERE seq = (SELECT MAX(seq) FROM task WHERE id = t.id) AND state != 'cancelled' AND depends_on = ? AND acceptance LIKE '%verdict%'", JSON.stringify([id]));
async function policyReview(target, step = 're_review') {
  const task = await orch.task.get({ task_id: target.id });
  const seq = (await h.policy.claim({ step, trigger: { table: 'task', id: target.id, seq: task.seq } })).row.seq;
  return { seq, made: await h.policyAs(seq).task.create({ spec: 'policy review', acceptance: VERDICT, depends_on: [target.id] }) };
}

test('the orchestrator\'s review after the policy step\'s is the policy step\'s row, with a reason', async () => {
  const fix = await fixOf('after');
  const { made } = await policyReview(fix);
  assert.strictEqual(made.acted_by, 'policy');
  const o = await orch.task.create({ spec: 'orchestrator review', acceptance: VERDICT, depends_on: [fix.id] });
  assert.strictEqual(o.id, made.id);
  assert.strictEqual(o.existing, true);
  assert.match(o.reason, /not written/, 'the answer says the spec, files and budget of the call were not written');
  assert.strictEqual(reviewsOf(fix.id).length, 1);
});

test('the policy step\'s review after the orchestrator\'s answers the orchestrator\'s row, superseded', async () => {
  const fix = await fixOf('first');
  const o = await orch.task.create({ spec: 'orchestrator review', acceptance: VERDICT, depends_on: [fix.id] });
  assert.notStrictEqual(o.existing, true);
  const { made } = await policyReview(fix);
  assert.strictEqual(made.id, o.id);
  assert.strictEqual(made.existing, true);
  assert.strictEqual(made.superseded, true);
  assert.strictEqual(reviewsOf(fix.id).length, 1);
});

test('plain work: the review step and the orchestrator leave one review, in either order', async () => {
  const w1 = await orch.task.create({ spec: 'plain policy first' });
  const p1 = await policyReview(w1, 'review');
  const o1 = await orch.task.create({ spec: 'orchestrator review', acceptance: VERDICT, depends_on: [w1.id] });
  assert.deepStrictEqual([o1.id, o1.existing], [p1.made.id, true]);
  assert.strictEqual(reviewsOf(w1.id).length, 1);
  const w2 = await orch.task.create({ spec: 'plain orchestrator first' });
  const o2 = await orch.task.create({ spec: 'orchestrator review', acceptance: VERDICT, depends_on: [w2.id] });
  const p2 = await policyReview(w2, 'review');
  assert.deepStrictEqual([p2.made.id, p2.made.existing, p2.made.superseded], [o2.id, true, true]);
  assert.strictEqual(reviewsOf(w2.id).length, 1);
});

test('two orchestrator reviews of the same task are not collapsed', async () => {
  const fix = await fixOf('plain');
  await orch.task.create({ spec: 'first', acceptance: VERDICT, depends_on: [fix.id] });
  await orch.task.create({ spec: 'second opinion', acceptance: VERDICT, depends_on: [fix.id] });
  assert.strictEqual(reviewsOf(fix.id).length, 2);
});

test('a policy review judged refuted does not stand: the orchestrator gets a second opinion', async () => {
  const fix = await fixOf('refuted');
  const { made } = await policyReview(fix);
  // handed back and evaluated without passing: results written, the task not done (what task.evaluate appends)
  const store = orch.owner.engine.store;
  const cur = rows.current(store, 'task', made.id);
  rows.append(store, 'task', { ...cur, state: 'released', results: { evaluated_at: Date.now(), executable: true, passed: false, checks: [] } }, { role: 'orchestrator' }, Date.now());
  const o = await orch.task.create({ spec: 'second opinion', acceptance: VERDICT, depends_on: [fix.id] });
  assert.notStrictEqual(o.existing, true);
  assert.notStrictEqual(o.id, made.id);
});

test('a create that collapses into a standing review makes no worktree and no branch, alone or in a batch', async () => {
  const branches = () => git(repo, 'branch', '--list', 'belay/*').split('\n').map((x) => x.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
  const fix = await fixOf('tree');
  const { made } = await policyReview(fix);
  const before = branches();
  const o = await orch.task.create({ id: 'rv-tree-single', spec: 'orchestrator review', acceptance: VERDICT, depends_on: [fix.id], worktree: true });
  assert.deepStrictEqual([o.id, o.existing], [made.id, true]);
  const b = await orch.task.create({ tasks: [{ id: 'rv-tree-batch', spec: 'orchestrator review', acceptance: VERDICT, depends_on: [fix.id], worktree: true }, { id: 'plain-in-batch', spec: 'p', worktree: true }] });
  assert.strictEqual(b.tasks[0].id, made.id);
  assert.deepStrictEqual(branches().filter((x) => !before.includes(x)), ['belay/plain-in-batch'], 'only the item that wrote a row got a tree');
  assert.deepStrictEqual(raw("SELECT id FROM task WHERE id IN ('rv-tree-single', 'rv-tree-batch')"), []);
});
