'use strict';
// fix-from-review-tree.test.cjs — task.fixFromReview hands out the judged task's tree only after git has been asked whether it
// is still one: two calls for one review make one fix however the awaits interleave, a tree removed during the check is not handed
// out, a tree left on another branch is still a live tree (a worker's tree is not refused for where its HEAD is), and a removal
// in flight is E_BUSY before git is asked. The git seam is git.cjs, so the interleavings are forced, not raced.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const G = core('git.cjs');

let dir, repo, orch, n = 0;
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo, fix_hard_cap: 3 });
});
after(async () => { try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); } });

async function handBack(taskId, workerId, worktree, result) {
  await orch.worker.write({ id: workerId, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${workerId}`, last_event_at: Date.now(), worktree });
  const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: workerId }), embed: false });
  try {
    const a = await orch.task.assign({ task_id: taskId, worker_id: workerId });
    await c.lease.release({ lease_id: a.new_lease.id, reason: 'done', result });
  } finally { await c.close(); }
}

// Work done in its own tree and judged done, and a review of it refuted. No fix yet.
async function refutedWork() {
  const name = `w${++n}`;
  let w = await orch.task.create({ spec: `${name} work`, acceptance: PASS, files_owned: [`src/${name}.cjs`] });
  w = await orch.task.worktreeCreate({ task_id: w.id });
  write(w.worktree.path, `src/${name}.cjs`, 'work\n');
  commit(w.worktree.path, `${name} work`);
  await handBack(w.id, `c-${name}`, w.worktree.path, { branch: w.worktree.branch });
  assert.strictEqual((await orch.task.evaluate({ task_id: w.id })).state, 'done');
  const r = await orch.task.create({ spec: `review ${name}`, depends_on: [w.id], acceptance: { verdict: true } });
  await handBack(r.id, `j-${name}`, dir, { verdict: 'refuted', summary: 's', findings: [] });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  return { w, r, stop: () => orch.worker.write({ id: `c-${name}`, substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: `s-c-${name}`, last_event_at: Date.now(), worktree: w.worktree.path }) };
}

const fixesOf = async (id) => (await orch.task.list({})).tasks.filter((t) => t.repairs === id);
const tick = () => new Promise((res) => setImmediate(res));

test('two calls for one review make one fix, however they interleave around the git check', async () => {
  const { w, r } = await refutedWork();
  const real = G.worktrees;
  let calls = 0, release;
  const gate = new Promise((res) => { release = res; });
  G.worktrees = async (...a) => { calls += 1; await gate; return real(...a); }; // every call waits: both are inside the await
  try {
    const p1 = orch.task.fixFromReview({ review_id: r.id });
    const p2 = orch.task.fixFromReview({ review_id: r.id });
    for (let i = 0; i < 2000 && calls < 2; i++) await tick();
    assert.strictEqual(calls, 2, 'both calls are inside the git check');
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.strictEqual(a.id, b.id, 'one fix');
    assert.strictEqual([a, b].filter((x) => x.existing).length, 1, 'the other call is told it already existed');
  } finally { G.worktrees = real; release(); }
  assert.strictEqual((await fixesOf(w.id)).length, 1);
});

test('a tree removed while the git check ran is not handed out', async () => {
  const { w, r, stop } = await refutedWork();
  await stop();
  const real = G.worktrees;
  let calls = 0, release, enter;
  const gate = new Promise((res) => { release = res; });
  const entered = new Promise((res) => { enter = res; });
  G.worktrees = async (...a) => { calls += 1; const list = await real(...a); if (calls === 1) { enter(); await gate; } return list; }; // only the fix's check waits, after git has said the tree is listed
  let f;
  try {
    const p = orch.task.fixFromReview({ review_id: r.id });
    await entered;
    await orch.task.worktreeRemove({ task_id: w.id });
    release();
    f = await p.catch((e) => e);
  } finally { G.worktrees = real; release(); }
  // Refused (the tree is gone on disk by the time the check ends) or made with no tree: never made with the removed one.
  if (f.code) assert.strictEqual(f.code, 'E_PRECONDITION'); else assert.ok(!f.worktree, `the removed tree was handed to the fix: ${JSON.stringify(f.worktree)}`);
});

test('a tree left on another branch is still the worker\'s tree and is handed to the fix', async () => {
  const { w, r } = await refutedWork();
  git(w.worktree.path, 'checkout', '-q', '--detach');
  const f = await orch.task.fixFromReview({ review_id: r.id });
  assert.strictEqual(f.worktree.path, w.worktree.path);
  assert.strictEqual(f.worktree.inherited_from, w.id);
});

test('a tree git does not list is refused, and a removal in flight is E_BUSY before git is asked', async () => {
  const gone = await refutedWork();
  git(repo, 'worktree', 'remove', '--force', gone.w.worktree.path);
  await rejectsCode(orch.task.fixFromReview({ review_id: gone.r.id }), 'E_PRECONDITION');

  const busy = await refutedWork();
  await busy.stop();
  const realRun = G.run, realList = G.worktrees;
  let release, started, listed = 0;
  const gate = new Promise((res) => { release = res; });
  const began = new Promise((res) => { started = res; });
  G.run = async (cwd, args, opts) => { if (args[0] === 'worktree' && args[1] === 'remove') { started(); await gate; } return realRun(cwd, args, opts); };
  let removal;
  try {
    removal = orch.task.worktreeRemove({ task_id: busy.w.id });
    await began;
    G.worktrees = async (...a) => { listed += 1; return realList(...a); };
    const e = await rejectsCode(orch.task.fixFromReview({ review_id: busy.r.id }), 'E_BUSY');
    assert.strictEqual(e.detail.op, 'worktree_remove');
    assert.strictEqual(listed, 0, 'git was not asked whether the tree is listed');
  } finally { G.worktrees = realList; release(); if (removal) await removal; G.run = realRun; }
});
