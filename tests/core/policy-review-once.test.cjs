'use strict';
// policy-review-once.test.cjs -- ADR 0072 decision 2 for the verdict review of a fix: the policy step (re_review) and the orchestrator
// both create one, and exactly one review row stands whichever comes first. Real core, sandbox store; no sleeps and no load.

const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { guarded } = require('./worktree-helpers.cjs');

const test = guarded(nodeTest);
const { openCore } = core('index.cjs');

let dir, orch, h;
const raw = (sql, ...a) => orch.owner.engine.store.p(sql).all(...a);
const VERDICT = { verdict: true };

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  h = orch.harness();
});
after(async () => { try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); } });

async function fixOf(label) {
  const work = await orch.task.create({ spec: `${label} work` });
  return orch.task.create({ spec: `${label} fix`, repairs: work.id });
}
const reviewsOf = (fixId) => raw("SELECT id, acted_by FROM task t WHERE seq = (SELECT MAX(seq) FROM task WHERE id = t.id) AND state != 'cancelled' AND depends_on = ? AND acceptance LIKE '%verdict%'", JSON.stringify([fixId]));
async function policyReview(fix) {
  const task = await orch.task.get({ task_id: fix.id });
  const seq = (await h.policy.claim({ step: 're_review', trigger: { table: 'task', id: fix.id, seq: task.seq } })).row.seq;
  return { seq, made: await h.policyAs(seq).task.create({ spec: 're-review', acceptance: VERDICT, depends_on: [fix.id] }) };
}

test('the orchestrator\'s review after the policy step\'s is the policy step\'s row', async () => {
  const fix = await fixOf('after');
  const { made } = await policyReview(fix);
  assert.strictEqual(made.acted_by, 'policy');
  const o = await orch.task.create({ spec: 'orchestrator review', acceptance: VERDICT, depends_on: [fix.id] });
  assert.strictEqual(o.id, made.id);
  assert.strictEqual(o.existing, true);
  assert.strictEqual(reviewsOf(fix.id).length, 1);
});

test('the policy step\'s review after the orchestrator\'s answers the orchestrator\'s row, superseded', async () => {
  const fix = await fixOf('during');
  const o = await orch.task.create({ spec: 'orchestrator review', acceptance: VERDICT, depends_on: [fix.id] });
  assert.notStrictEqual(o.existing, true);
  const { made } = await policyReview(fix);
  assert.strictEqual(made.id, o.id);
  assert.strictEqual(made.existing, true);
  assert.strictEqual(made.superseded, true);
  assert.strictEqual(reviewsOf(fix.id).length, 1);
});

test('two orchestrator reviews of a fix, and reviews of plain work, are not collapsed', async () => {
  const fix = await fixOf('plain');
  await orch.task.create({ spec: 'first', acceptance: VERDICT, depends_on: [fix.id] });
  await orch.task.create({ spec: 'second opinion', acceptance: VERDICT, depends_on: [fix.id] });
  assert.strictEqual(reviewsOf(fix.id).length, 2);
  const work = await orch.task.create({ spec: 'work' });
  const a = await orch.task.create({ spec: 'r1', acceptance: VERDICT, depends_on: [work.id] });
  const b = await orch.task.create({ spec: 'r2', acceptance: VERDICT, depends_on: [work.id] });
  assert.notStrictEqual(a.id, b.id);
});
