'use strict';
// off-path-guards.test.cjs — the guards around ADR 0061's amend and tree_of: an amend needs no spec at the MCP boundary; tree_of
// refuses another repository's tree (the operator may name one), refuses a tree whose removal is in flight (the removal is held
// mid-flight by a stalled git call), and judges file overlaps in the inherited tree; a review whose results went stale under an
// amend is no refutation, so it authorises no fix and spends no round. Real core, a sandbox store and throwaway repositories.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit, rejectsCode } = require('./worktree-helpers.cjs');
const tools = require('../../src/mcp/tools.cjs');

const { openCore } = core('index.cjs');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

let dir, repo, orch, op;
const workers = new Map();

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo, max_fix_rounds: 1 });
  op = await openCore({ dataDir: `${dir}/data`, caller: callerFor('operator'), embed: false });
});

after(async () => {
  for (const c of workers.values()) await c.close();
  await op.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function worker(id, worktree) {
  if (workers.has(id)) return workers.get(id);
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree });
  const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.set(id, c);
  return c;
}

async function handBack(taskId, workerId, worktree, result = { branch: 'b' }) {
  const w = await worker(workerId, worktree);
  const a = await orch.task.assign({ task_id: taskId, worker_id: workerId });
  return w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result });
}

async function treeTask(name, files = [`src/${name}.cjs`]) {
  const t = await orch.task.create({ spec: name, acceptance: { files_within_owned: true }, files_owned: files });
  return orch.task.worktreeCreate({ task_id: t.id });
}

test('the MCP boundary: an amend needs no spec, a create still does', () => {
  const args = { id: 't', amend: true, acceptance: PASS };
  assert.strictEqual(tools.validateArgs('task_create', args, { role: 'orchestrator' }), args);
  assert.throws(() => tools.validateArgs('task_create', { acceptance: PASS }, { role: 'orchestrator' }), (e) => e.code === 'E_ARGS' && e.detail.missing === 'spec');
  assert.throws(() => tools.validateArgs('task_create', { id: 't', amend: false, acceptance: PASS }, { role: 'orchestrator' }), (e) => e.code === 'E_ARGS' && e.detail.missing === 'spec');
});

test('tree_of: another repository\'s tree is refused, nothing written', async () => {
  const other = makeRepo(dir);
  const t = await orch.task.create({ spec: 'elsewhere', acceptance: PASS });
  const foreign = await op.task.worktreeCreate({ task_id: t.id, repo: other }); // the operator may name another repository
  const count = (await orch.task.list({})).tasks.length;
  const e = await rejectsCode(orch.task.create({ spec: 'into another repo', tree_of: foreign.id }), 'E_ROLE');
  assert.deepStrictEqual([e.detail.tree_of, e.detail.repo], [foreign.id, foreign.worktree.repo]);
  assert.strictEqual((await orch.task.list({})).tasks.length, count, 'nothing written');
  await orch.task.cancel({ task_id: t.id });
});

test('tree_of: refused E_BUSY while the tree\'s removal is in flight, so no open task is left with a removed tree', async () => {
  const w = await treeTask('removing');
  const G = require('../../src/core/git.cjs');
  const real = G.worktrees;
  let reached, release;
  const atGit = new Promise((r) => { reached = r; });
  const gate = new Promise((r) => { release = r; });
  G.worktrees = async (...a) => { reached(); await gate; return real(...a); }; // removal stalls in its git call, past its sharer check
  let removal;
  try {
    removal = orch.task.worktreeRemove({ task_id: w.id });
    await Promise.race([atGit, removal]);
    const e = await rejectsCode(orch.task.create({ spec: 'a fix in a tree going away', tree_of: w.id }), 'E_BUSY');
    assert.deepStrictEqual([e.detail.op, e.detail.removing_through], ['worktree_remove', w.id]);
  } finally { release(); G.worktrees = real; }
  const out = await removal;
  assert.ok(out.worktree.removed_at);
  assert.ok(!(await orch.task.list({})).tasks.some((t) => t.worktree && t.worktree.inherited_from === w.id), 'no task was given the tree');
  await rejectsCode(orch.task.create({ spec: 'too late', tree_of: w.id }), 'E_PRECONDITION');
});

test('tree_of: overlaps are judged in the inherited tree, not the shared one', async () => {
  const w = await treeTask('ov', ['src/ov.cjs']);
  await worker('c-ov', w.worktree.path);
  await orch.task.assign({ task_id: w.id, worker_id: 'c-ov' }); // holds src/ov.cjs in its tree
  const e = await rejectsCode(orch.task.create({ spec: 'same file, same tree', tree_of: w.id, files_owned: ['src/ov.cjs'] }), 'E_FILES_OVERLAP');
  assert.strictEqual(e.detail.other_task_id, w.id);
  // A holder in the shared tree does not refuse a task in the inherited tree; it is reported.
  const shared = await orch.task.create({ spec: 'shared holder', files_owned: ['src/shared-ov.cjs'], acceptance: PASS });
  await worker('c-shared-ov', repo); // the shared checkout; the sandbox dir would contain every worktree
  await orch.task.assign({ task_id: shared.id, worker_id: 'c-shared-ov' });
  const f = await orch.task.create({ spec: 'in the inherited tree', tree_of: w.id, files_owned: ['src/shared-ov.cjs'] });
  assert.deepStrictEqual(f.overlaps.map((o) => o.task_id), [shared.id]);
  for (const id of [f.id, shared.id, w.id]) await orch.task.cancel({ task_id: id });
});

test('a review refuted and then amended is no refutation: no fix, no round spent; re-judged, it refutes again', async () => {
  const w = await orch.task.create({ spec: 'stale work', acceptance: PASS });
  await handBack(w.id, 'c-stale-rev', dir);
  assert.strictEqual((await orch.task.evaluate({ task_id: w.id, worktree: dir })).state, 'done');
  const r = await orch.task.create({ spec: 'review stale work', depends_on: [w.id], acceptance: { verdict: true } });
  await handBack(r.id, 'j-stale-rev', dir, { verdict: 'refuted', summary: 'old findings', findings: [] });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  const amended = await orch.task.create({ id: r.id, amend: true, acceptance: { verdict: true, handoff: { required: ['verdict', 'summary'] } } });
  assert.strictEqual(amended.results.stale, 'acceptance amended');
  const T = require('../../src/core/methods-task.cjs'), RS = require('../../src/core/review-state.cjs');
  assert.deepStrictEqual([T.refutedReview(amended), RS.verdictOf(amended)], [false, 'pending']);
  assert.strictEqual((await orch.task.get({ task_id: w.id })).review.state, 'pending', 'the work\'s review is pending, not refuted');
  await rejectsCode(orch.task.fixFromReview({ review_id: r.id }), 'E_PRECONDITION');
  assert.ok(!(await orch.task.list({})).tasks.some((t) => t.repairs === w.id), 'no fix written, no round spent');
  const again = await orch.task.evaluate({ task_id: r.id, worktree: dir });
  assert.strictEqual(again.results.stale, undefined);
  assert.strictEqual((await orch.task.fixFromReview({ review_id: r.id })).repairs, w.id, 'the round is still there to spend');
});

test('amend keeps a task\'s kind: a work task cannot become a review, nor a review a work task; amend: false is a plain create', async () => {
  const w = await orch.task.create({ spec: 'kind work', acceptance: PASS });
  const e = await rejectsCode(orch.task.create({ id: w.id, amend: true, acceptance: { verdict: true } }), 'E_ARGS');
  assert.strictEqual(e.detail.field, 'acceptance.verdict');
  const r = await orch.task.create({ spec: 'kind review', depends_on: [w.id], acceptance: { verdict: true } });
  await rejectsCode(orch.task.create({ id: r.id, amend: true, acceptance: PASS }), 'E_ARGS');
  assert.deepStrictEqual([(await orch.task.get({ task_id: w.id })).amended, (await orch.task.get({ task_id: r.id })).amended], [null, null], 'nothing written');
  const plain = await orch.task.create({ spec: 'amend false', amend: false, acceptance: PASS });
  assert.deepStrictEqual([plain.state, plain.spec, plain.amended ?? null], ['open', 'amend false', null]);
  await rejectsCode(orch.task.create({ id: w.id, spec: 'x', amend: false }), 'E_ARGS'); // an existing id is still refused
  for (const id of [r.id, w.id, plain.id]) await orch.task.cancel({ task_id: id });
});

test('a stale review decides the work pending, over a later holds', async () => {
  const w = await orch.task.create({ spec: 'panel work', acceptance: PASS });
  await handBack(w.id, 'c-panel', dir);
  assert.strictEqual((await orch.task.evaluate({ task_id: w.id, worktree: dir })).state, 'done');
  const r2 = await orch.task.create({ spec: 'panel review 2', depends_on: [w.id], acceptance: { verdict: true } });
  const r1 = await orch.task.create({ spec: 'panel review 1', depends_on: [w.id], acceptance: { verdict: true } });
  await handBack(r2.id, 'j-panel-2', dir, { verdict: 'refuted', summary: 's', findings: [] });
  await orch.task.evaluate({ task_id: r2.id, worktree: dir });
  await handBack(r1.id, 'j-panel-1', dir, { verdict: 'holds', summary: 's', findings: [] });
  assert.strictEqual((await orch.task.evaluate({ task_id: r1.id, worktree: dir })).state, 'done');
  assert.strictEqual((await orch.task.get({ task_id: w.id })).review.state, 'refuted', 'the open refutation decides');
  await orch.task.create({ id: r2.id, amend: true, acceptance: { verdict: true, handoff: { required: ['verdict'] } } });
  const review = (await orch.task.get({ task_id: w.id })).review;
  assert.deepStrictEqual([review.state, review.review_id], ['pending', r2.id], 'the stale review decides, pending; the older holds does not');
});
