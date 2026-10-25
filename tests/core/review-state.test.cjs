'use strict';
// review-state.test.cjs — ADR 0060 decision 1: task.list and task.get carry `review`, where the work stands with its reviewers,
// derived from the review and fix task rows on every read. A work task stays `done` when its review is refuted; `review` is
// what says so. Real core against a sandbox store.

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

let k = 0;
async function handBack(taskId, result) {
  const id = `w-${++k}`;
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now() });
  const w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.set(id, w);
  const a = await orch.task.assign({ task_id: taskId, worker_id: id });
  return w.lease.release({ lease_id: a.new_lease.id, reason: 'done', ...(result ? { result } : {}) });
}

async function doneWork(task) {
  await handBack(task.id, { branch: 'b' });
  assert.strictEqual((await orch.task.evaluate({ task_id: task.id, worktree: dir })).state, 'done');
}

async function judge(task, verdict) {
  const r = await orch.task.create({ spec: `review ${task.id}`, depends_on: [task.id], acceptance: { verdict: true } });
  if (verdict) {
    await handBack(r.id, { verdict, summary: 's', findings: [] });
    await orch.task.evaluate({ task_id: r.id, worktree: dir });
  }
  return r;
}

const reviewOf = async (id) => (await orch.task.get({ task_id: id })).review;
const listed = async (id, states) => (await orch.task.list(states ? { states } : {})).tasks.find((t) => t.id === id).review;

test('work with no review reads null; a review not yet judged reads pending; one that holds reads holds', async () => {
  const w = await orch.task.create({ spec: 'work a', acceptance: PASS });
  await doneWork(w);
  assert.strictEqual(await reviewOf(w.id), null);
  const r = await judge(w, null);
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'pending', review_id: r.id, rounds: 0, rounds_left: 2 });
  assert.strictEqual(await reviewOf(r.id), null, 'a review task has no review of its own');
  const r2 = await orch.task.create({ spec: 'second review', depends_on: [w.id], acceptance: { verdict: true } });
  await orch.task.cancel({ task_id: r2.id });
  // A hand-back with no summary is a verdict check that is not executable: still pending, never refuted.
  await handBack(r.id, { verdict: 'refuted' });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  assert.strictEqual((await reviewOf(w.id)).state, 'pending');
  await handBack(r.id, { verdict: 'holds', summary: 'fine' });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'holds', review_id: r.id, rounds: 0, rounds_left: 2 }, 'a cancelled later review judged nothing');
});

test('refuted three times with max_fix_rounds 2: the work stays done and reads refuted with no rounds left, on list and get alike', async () => {
  const w = await orch.task.create({ spec: 'work b', acceptance: PASS });
  await doneWork(w);
  let r = await judge(w, 'refuted');
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'refuted', review_id: r.id, rounds: 0, rounds_left: 2 });
  let fix;
  for (let n = 1; n <= 2; n++) {
    fix = await orch.task.fixFromReview({ review_id: r.id });
    assert.deepStrictEqual(await reviewOf(w.id), { state: 'refuted', review_id: r.id, rounds: n, rounds_left: 2 - n }, `fix ${n} made, not yet reviewed`);
    await doneWork(fix);
    r = await judge(fix, 'refuted');
  }
  const want = { state: 'refuted', review_id: r.id, rounds: 2, rounds_left: 0 };
  assert.strictEqual((await orch.task.get({ task_id: w.id })).state, 'done', 'the work task itself stays done');
  assert.deepStrictEqual(await reviewOf(w.id), want);
  assert.deepStrictEqual(await reviewOf(fix.id), want, 'a fix reads the same chain');
  assert.deepStrictEqual(await listed(w.id), want);
  assert.deepStrictEqual(await listed(w.id, ['done']), want, 'a state filter does not hide the reviews the state is derived from');
});

test('a fix whose review holds turns the whole chain to holds', async () => {
  const w = await orch.task.create({ spec: 'work c', acceptance: PASS });
  await doneWork(w);
  const r = await judge(w, 'refuted');
  const fix = await orch.task.fixFromReview({ review_id: r.id });
  await doneWork(fix);
  const r2 = await judge(fix, 'holds');
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'holds', review_id: r2.id, rounds: 1, rounds_left: 1 });
});

// A second review over the same task, judged by its own worker.
async function verdict(r, v) {
  await handBack(r.id, { verdict: v, summary: 's', findings: [] });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
}

test('two reviewers: the decision made last decides, not the review made last, and a refutation no fix answers beats a holds', async () => {
  // The later-created review holds first; the earlier one refutes after it: refuted.
  const w = await orch.task.create({ spec: 'work d', acceptance: PASS });
  await doneWork(w);
  const r1 = await judge(w, null), r2 = await judge(w, null);
  await verdict(r2, 'holds');
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'holds', review_id: r2.id, rounds: 0, rounds_left: 2 });
  await verdict(r1, 'refuted');
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'refuted', review_id: r1.id, rounds: 0, rounds_left: 2 });
  // A fix answers r1, and nothing has judged the fix yet: the last decision, r1's refutation, still reads, never r2's older holds.
  await orch.task.fixFromReview({ review_id: r1.id });
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'refuted', review_id: r1.id, rounds: 1, rounds_left: 1 });
  // The other order: refuted first, then a holds; no fix answers the refutation, so it still decides.
  const v = await orch.task.create({ spec: 'work e', acceptance: PASS });
  await doneWork(v);
  const q1 = await judge(v, null), q2 = await judge(v, null);
  await verdict(q1, 'refuted');
  await verdict(q2, 'holds');
  assert.deepStrictEqual(await reviewOf(v.id), { state: 'refuted', review_id: q1.id, rounds: 0, rounds_left: 2 });
  // A fix takes it on; the refutation stands while the fix's review is under way (only a decision on it answers), and once that
  // review holds the chain holds.
  const fix = await orch.task.fixFromReview({ review_id: q1.id });
  await doneWork(fix);
  const q3 = await judge(fix, null);
  assert.deepStrictEqual(await reviewOf(v.id), { state: 'refuted', review_id: q1.id, rounds: 1, rounds_left: 1 });
  await verdict(q3, 'holds');
  assert.deepStrictEqual(await reviewOf(v.id), { state: 'holds', review_id: q3.id, rounds: 1, rounds_left: 1 });
});

test('rounds_left across runs: it is what the run of the newest fix would allow next, as task.create would answer', async () => {
  const w = await orch.task.create({ spec: 'work f', acceptance: PASS });
  await doneWork(w);
  const f1 = await orch.task.fixFromReview({ review_id: (await judge(w, 'refuted')).id });
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'refuted', review_id: (await reviewOf(w.id)).review_id, rounds: 1, rounds_left: 1 });
  // Another run, capped at 1, takes the next round: two rounds in all, none left in that run.
  const other = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-b' }), embed: false });
  workers.set('run-b', other);
  await other.run.attach({ adapter_pid: process.pid, max_fix_rounds: 1 });
  await doneWork(f1);
  const r2 = await judge(f1, 'refuted');
  const f2 = await other.task.fixFromReview({ review_id: r2.id });
  await doneWork(f2);
  const r3 = await judge(f2, 'refuted');
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'refuted', review_id: r3.id, rounds: 2, rounds_left: 0 });
  await assert.rejects(other.task.fixFromReview({ review_id: r3.id }), (e) => e.code === 'E_FIX_ROUNDS');
});

async function said(r, v, summary) {
  await handBack(r.id, { verdict: v, summary, findings: [{ severity: 'blocking', clause: 'a', note: `${summary}-finding` }] });
  await orch.task.evaluate({ task_id: r.id, worktree: dir });
}

test('a panel: a refutation stands over a later holds, while its fix is open and after the fix is cancelled; a cancelled fix answers nothing', async () => {
  const w = await orch.task.create({ spec: 'work g', acceptance: PASS });
  await doneWork(w);
  const b = await judge(w, null), a = await judge(w, null);
  await said(b, 'refuted', 'b-says');
  await said(a, 'holds', 'a-says');
  assert.deepStrictEqual((await reviewOf(w.id)).state, 'refuted');
  const f = await orch.task.fixFromReview({ review_id: b.id });
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'refuted', review_id: b.id, rounds: 1, rounds_left: 1 }, 'the fix is open: b stands');
  await orch.task.cancel({ task_id: f.id });
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'refuted', review_id: b.id, rounds: 1, rounds_left: 1 }, 'cancelled: b stands, and the round is spent');
  // The next fix takes b in again with a new refutation c: the cancelled fix covered nothing.
  const c = await judge(w, null);
  await said(c, 'refuted', 'c-says');
  const f2 = await orch.task.fixFromReview({ review_id: c.id });
  assert.deepStrictEqual(f2.answers, [b.id, c.id]);
});

test('two refuters: one fix takes in both, either review returns it, and a refutation decided after the fix needs its own round', async () => {
  const w = await orch.task.create({ spec: 'work h', acceptance: PASS });
  await doneWork(w);
  const r1 = await judge(w, null), r2 = await judge(w, null);
  await said(r1, 'refuted', 'first-refuter');
  await said(r2, 'refuted', 'second-refuter');
  const f = await orch.task.fixFromReview({ review_id: r1.id });
  assert.deepStrictEqual(f.answers, [r1.id, r2.id]);
  assert.match(f.spec, /first-refuter-finding/);
  assert.match(f.spec, /second-refuter-finding/);
  const again = await orch.task.fixFromReview({ review_id: r2.id });
  assert.deepStrictEqual([again.id, again.existing], [f.id, true], 'the second refuter is already in the open fix');
  // A third refutation, decided after the fix was made, is not in it: while that fix is still open it gets a fix of its own.
  const r3 = await judge(w, null);
  await said(r3, 'refuted', 'late-refuter');
  const f2 = await orch.task.fixFromReview({ review_id: r3.id });
  assert.notStrictEqual(f2.id, f.id);
  assert.deepStrictEqual([f2.existing, f2.answers], [undefined, [r3.id]]);
  assert.doesNotMatch(f2.spec, /first-refuter|second-refuter/);
  // f2's review holds: r3 is answered, but r1 and r2 are only f's to answer, and f is not reviewed yet.
  await doneWork(f2);
  await verdict(await judge(f2, null), 'holds');
  assert.deepStrictEqual((await reviewOf(w.id)).state, 'refuted', 'f2 answers r3 only');
  await doneWork(f);
  const fr = await judge(f, null);
  await verdict(fr, 'holds');
  assert.deepStrictEqual(await reviewOf(w.id), { state: 'holds', review_id: fr.id, rounds: 2, rounds_left: 0 });
});

test('a refutation decided in the same millisecond a fix was made is not answered by it (a fix row from before answers)', () => {
  const RS = require('../../src/core/review-state.cjs');
  const done = { state: 'done', results: { evaluated_at: 50, checks: [] } };
  const refuted = (id, dep, at) => ({ id, state: 'released', acceptance: { verdict: true }, depends_on: [dep], results: { evaluated_at: at, checks: [{ kind: 'verdict', executable: true, passed: false }] } });
  const w = { id: 'w', state: 'done', run_id: 'r' };
  const run = (fixBorn) => {
    const r = refuted('rv', 'w', 100);
    const f = { id: 'f', state: 'done', repairs: 'w', depends_on: ['w'], run_id: 'r' }; // no answers: a row from before the field
    const fr = { id: 'fr', ...done, acceptance: { verdict: true }, depends_on: ['f'], results: { evaluated_at: 200, checks: [] } };
    const ix = { born: new Map([['w', { s: 1, at: 1 }], ['rv', { s: 2, at: 2 }], ['f', { s: 3, at: fixBorn }], ['fr', { s: 4, at: 150 }]]),
      reviewsOf: new Map([['w', [r]], ['f', [fr]]]), fixesOf: new Map([['w', [f]]]), caps: new Map() };
    return RS.ofTask(w, ix).state;
  };
  assert.strictEqual(run(100), 'refuted', 'a tie is not an answer');
  assert.strictEqual(run(101), 'holds', 'a fix made after the refutation, whose review held, answers it');
});
