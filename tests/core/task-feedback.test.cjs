'use strict';
// task-feedback.test.cjs — ADR 0058 in the core: what the orchestrator prompt asked the orchestrator to remember about tasks,
// the store now does. Real core against a sandbox store, as handoff-verdict.test.cjs does.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch;
const workers = new Map();
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, max_fix_rounds: 2 });
});

after(async () => {
  for (const c of workers.values()) await c.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function worker(id) {
  if (workers.has(id)) return workers.get(id);
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now() });
  const c = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.set(id, c);
  return c;
}

const rejects = async (p, code, re) => {
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
};

async function handBack(taskId, workerId, result) {
  const w = await worker(workerId);
  const a = await orch.task.assign({ task_id: taskId, worker_id: workerId });
  return w.lease.release({ lease_id: a.new_lease.id, reason: 'done', ...(result ? { result } : {}) });
}

// Work task `t` done by `coder`, then a review over it refuted by `judge`.
async function refutedReviewOf(t, coder, judge) {
  await handBack(t.id, coder, { branch: 'b', head: 'h' });
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id, worktree: dir })).state, 'done');
  const r = await orch.task.create({ spec: `review ${t.id}`, depends_on: [t.id], acceptance: { verdict: true } });
  await handBack(r.id, judge, { verdict: 'refuted', summary: 'the retry never fires', findings: [{ severity: 'blocking', clause: 'a', note: 'retry' }] });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  return r;
}

test('fix_from_review: the fix depends on and repairs the judged task, takes its acceptance and files, and quotes the findings', async () => {
  const w = await orch.task.create({ spec: 'add the retry', acceptance: PASS, files_owned: ['src/retry.cjs'] });
  const r = await refutedReviewOf(w, 'c-1', 'j-1');
  const f = await orch.task.fixFromReview({ review_id: r.id });
  assert.deepStrictEqual([f.state, f.depends_on, f.repairs, f.from_review], ['open', [w.id], w.id, r.id]);
  assert.deepStrictEqual([f.acceptance, f.files_owned], [PASS, ['src/retry.cjs']]);
  assert.match(f.spec, /the retry never fires/);
  assert.match(f.spec, /"clause":"a"/);
  // A fix of a fix depends on the fix the second review judged, and repairs the original work: one cap counts both.
  const r2 = await refutedReviewOf(f, 'c-2', 'j-2');
  const f2 = await orch.task.fixFromReview({ review_id: r2.id, spec: 'try again' });
  assert.deepStrictEqual([f2.depends_on, f2.repairs, f2.spec], [[f.id], w.id, 'try again']);
  // max_fix_rounds 2: the third round is refused and nothing is written.
  const r3 = await refutedReviewOf(f2, 'c-3', 'j-3');
  const before = (await orch.task.list({})).tasks.length;
  await rejects(orch.task.fixFromReview({ review_id: r3.id }), 'E_FIX_ROUNDS', /max_fix_rounds is 2/);
  assert.strictEqual((await orch.task.list({})).tasks.length, before);
});

test('fix_from_review: refuses a task that is not a review, a review not evaluated refuted, and an unknown id', async () => {
  const w = await orch.task.create({ spec: 'plain work', acceptance: PASS });
  await rejects(orch.task.fixFromReview({ review_id: w.id }), 'E_ARGS', /not a review task/);
  await handBack(w.id, 'c-4');
  await orch.task.evaluate({ task_id: w.id, worktree: dir });
  const r = await orch.task.create({ spec: 'review', depends_on: [w.id], acceptance: { verdict: true } });
  await rejects(orch.task.fixFromReview({ review_id: r.id }), 'E_PRECONDITION', /evaluate it first/);
  await handBack(r.id, 'j-4', { verdict: 'holds', summary: 'fine' });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  await rejects(orch.task.fixFromReview({ review_id: r.id }), 'E_PRECONDITION', /not last evaluated refuted/);
  await rejects(orch.task.fixFromReview({ review_id: 'no-such' }), 'E_NOT_FOUND');
});

test('handoff acceptance: a research task is done when its hand-back carries each required field, and not before', async () => {
  const acceptance = { handoff: { required: ['findings', 'summary'] } };
  for (const bad of [{ required: [] }, { required: 'findings' }, { required: [''] }, []]) {
    await rejects(orch.task.create({ spec: 'bad', acceptance: { handoff: bad } }), 'E_ARGS', /handoff must be/);
  }
  const t = await orch.task.create({ spec: 'find out why', acceptance });
  const none = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  const check = (row) => row.results.checks.find((c) => c.kind === 'handoff');
  assert.deepStrictEqual([none.state, check(none).executable], ['open', false], 'no hand-back yet: not executable');
  await handBack(t.id, 'r-1', { findings: [], summary: 'nothing found' });
  const thin = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  assert.deepStrictEqual([thin.state, check(thin).executable, check(thin).passed, check(thin).detail.missing], ['released', true, false, ['findings']]);
  // Reassigned, the old hand-back is stale until the new holder releases.
  await worker('r-2');
  await orch.task.assign({ task_id: t.id, worker_id: 'r-2' });
  assert.match(check(await orch.task.evaluate({ task_id: t.id, worktree: dir })).detail.reason, /stale/);
  const lease = (await orch.task.get({ task_id: t.id })).lease;
  await workers.get('r-2').lease.release({ lease_id: lease.id, result: { findings: ['the cache key omits the locale'], summary: 'found it' } });
  const ok = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  assert.deepStrictEqual([ok.state, check(ok).passed, check(ok).detail.by], ['done', true, 'r-2']);
});
