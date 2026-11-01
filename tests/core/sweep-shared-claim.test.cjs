'use strict';
// sweep-shared-claim.test.cjs — task.worktreeSweep and task.worktreeRemove on one tree two tasks share (a work task and its fix):
// a removal held inside its git call while the sweep reaches the same tree must not be removed a second time. The sweep waits for
// the removal in flight, as a second task.worktreeRemove does, and both report the true outcome. A seam on git.cjs holds the
// removal's first worktree listing; nothing sleeps and nothing is loaded. Real core, a sandbox store, a throwaway repository.

require('../helpers/tmp.cjs');
const { test: nodeTest, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit, guarded } = require('./worktree-helpers.cjs');
const test = guarded(nodeTest);

const { openCore } = core('index.cjs');
const G = core('git.cjs');

let dir, repo, orch, op;
const workers = new Map();

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
  op = await openCore({ dataDir: `${dir}/data`, caller: callerFor('operator'), embed: false });
});

after(async () => {
  for (const c of workers.values()) await c.close();
  try { await orch.shutdownOwner(); } finally { await op.close(); await orch.close(); cleanup(dir); }
});

async function handBack(taskId, workerId, worktree, result) {
  if (!workers.has(workerId)) {
    await orch.worker.write({ id: workerId, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${workerId}`, last_event_at: Date.now(), worktree });
    workers.set(workerId, await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: workerId }), embed: false }));
  }
  const a = await orch.task.assign({ task_id: taskId, worker_id: workerId });
  return workers.get(workerId).lease.release({ lease_id: a.new_lease.id, reason: 'done', result });
}

// A done work task with a tree, and its fix (cancelled) sharing that tree and branch, the coder stopped: both removable.
async function sharedTree(name) {
  let w = await orch.task.create({ spec: `${name} work`, acceptance: { files_within_owned: true }, files_owned: [`src/${name}.cjs`] });
  w = await orch.task.worktreeCreate({ task_id: w.id });
  write(w.worktree.path, `src/${name}.cjs`, 'work\n');
  commit(w.worktree.path, `${name} work`);
  await handBack(w.id, `c-${name}`, w.worktree.path, { branch: w.worktree.branch });
  assert.strictEqual((await orch.task.evaluate({ task_id: w.id })).state, 'done');
  const r = await orch.task.create({ spec: `review ${name}`, depends_on: [w.id], acceptance: { verdict: true } });
  await handBack(r.id, `j-${name}`, dir, { verdict: 'refuted', summary: 's', findings: [] });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  const f = await orch.task.fixFromReview({ review_id: r.id });
  await orch.task.cancel({ task_id: f.id });
  await orch.worker.write({ id: `c-${name}`, substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: `s-c-${name}`, last_event_at: Date.now(), worktree: w.worktree.path });
  return { w, f };
}

// The removal goes through `via`; the sweep passes the group's first task to its removal, so one of the two orders has the sweep
// and the removal on different tasks, and only then can the per-task lock not hide a double removal.
async function sweepDuringRemoval(name, pick) {
  const { w, f } = await sharedTree(name);
  const via = pick(w, f);
  const realList = G.worktrees, realRun = G.run;
  let release, held, reached, armed = false, calls = 0;
  const gate = new Promise((r) => { release = r; });
  const heldAt = new Promise((r) => { held = r; });
  const sweepAt = new Promise((r) => { reached = r; }); // the sweep has read the tree's ignored files: its removal call is next
  G.worktrees = async (...a) => { if (armed && ++calls === 1) { held(); await gate; } return realList(...a); };
  G.run = async (cwd, args, ...a) => { const out = await realRun(cwd, args, ...a); if (armed && args.includes('--ignored=matching')) reached(); return out; };
  try {
    armed = true;
    const pr = orch.task.worktreeRemove({ task_id: via.id }); // held inside its first worktree listing
    await Promise.race([heldAt, pr.then(() => { throw new Error('the removal ended before reaching the held git call'); })]);
    const ps = op.task.worktreeSweep({ run_id: 'test-run' });
    await Promise.race([sweepAt, ps.then(() => { throw new Error('the sweep ended before reaching the tree'); })]);
    await new Promise(setImmediate); // the sweep's own call is made or waiting; the removal is still held
    release();
    const [rr, rs] = await Promise.allSettled([pr, ps]);
    assert.strictEqual(rr.status, 'fulfilled', rr.reason && rr.reason.message);
    assert.strictEqual(rs.status, 'fulfilled', rs.reason && rs.reason.message);
    assert.ok(rr.value.worktree.removed_at && !rr.value.removal.already && !rr.value.removal.already_gone, 'the held removal removes the tree itself');
    const mine = (list) => list.filter((x) => x.task_ids.includes(w.id));
    assert.deepStrictEqual([mine(rs.value.removed).length, mine(rs.value.failed).length], [0, 0], `the sweep removes nothing a second time: ${JSON.stringify(rs.value)}`);
    assert.strictEqual(mine(rs.value.kept).length, 1, 'the sweep reports the tree as removed by another call');
    assert.ok(!fs.existsSync(w.worktree.path));
    for (const id of [w.id, f.id]) assert.ok((await orch.task.get({ task_id: id })).worktree.removed_at, `task ${id} records the removal`);
  } finally { release(); G.worktrees = realList; G.run = realRun; }
}

test('a sweep that reaches a shared tree while the work task\'s removal is in flight waits for it', () => sweepDuringRemoval('sweep-w', (w) => w));
test('a sweep that reaches a shared tree while the fix task\'s removal is in flight waits for it', () => sweepDuringRemoval('sweep-f', (w, f) => f));
