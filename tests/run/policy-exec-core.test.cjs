'use strict';
require('../helpers/tmp.cjs');
// policy-exec-core.test.cjs — the policy executor against the REAL core: an in-process Engine on a sandbox store, git repositories built in
// the test, workers that hand back through their own cores. The claim, the stamp (acted_by, trigger, policy_rev) and the policyAs view are
// the core's own (policy-steps.cjs, policy-stamp.cjs); only the delivery of a task to a worker (compose's message) is left out, because no
// process runs. One test per step (fix, re_review, integrate), the orchestrator acting first, and a paused run. No model, no sleep.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { makeRepo, write, commit, guarded } = require('../core/worktree-helpers.cjs');
const { createPolicyExecutor } = require('../../src/run/policy-exec.cjs');

const test = guarded(nodeTest);
const { openCore } = core('index.cjs');
const RUN = 'test-run';
const PLAN = { fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

// A sandbox store, the orchestrator's core and its harness view, an operator core, and workers by id.
async function env() {
  const dir = sandbox();
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  const op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  const e = { dir, orch, op, h: orch.harness(), workers: new Map() };
  e.raw = (sql, ...a) => orch.owner.engine.store.p(sql).all(...a);
  e.worker = async (id, worktree = dir) => {
    if (e.workers.has(id)) return e.workers.get(id);
    await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree });
    const c = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
    e.workers.set(id, c);
    return c;
  };
  // The adapter's task_assign over the stamped view, without the message to a process.
  e.exec = (extra = {}, c = e.h) => { const x = createPolicyExecutor({ core: c, runId: RUN, assignFor: (stepCore) => async (a) => stepCore.task.assign(a), closeWaitMs: 0, identity: { pid: process.pid, created: 'own' }, ...extra }); x.arm(); return x; };
  e.close = async () => {
    for (const c of e.workers.values()) await c.close();
    await op.close();
    try { await orch.shutdownOwner(); } finally { await orch.close(); if (process.env.BELAY_KEEP_SANDBOX) require("node:fs").cpSync(`${dir}/data`, `${process.env.BELAY_KEEP_SANDBOX}/${require("node:path").basename(dir)}`, { recursive: true }); cleanup(dir); }
  };
  return e;
}

// The worker hands back what it did and belay evaluates it as the run manager does (trigger 'release').
async function handBack(e, workerId, task, result = { branch: 'b', head: 'h' }, tree = null) {
  const w = await e.worker(workerId, tree || e.dir);
  const a = await e.orch.task.assign({ task_id: task.id, worker_id: workerId });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result });
  return e.h.task.evaluate({ task_id: task.id, ...(tree ? {} : { worktree: e.dir }), trigger: 'release' });
}
// A work task under the plan, judged `verdict` by `judge`. -> { work, review }
async function judged(e, label, verdict, { builder = `build-${label}`, judge = `judge-${label}`, work, tree = null } = {}) {
  const t = work || await e.orch.task.create({ spec: `${label} work`, acceptance: PASS, policy: PLAN });
  assert.strictEqual((await handBack(e, builder, t, undefined, tree)).state, 'done');
  const review = await e.orch.task.create({ spec: `${label} review`, depends_on: [t.id], acceptance: { verdict: true } });
  const findings = verdict === 'refuted' ? [{ severity: 'blocking', clause: 'a', note: `${label} finding` }] : [];
  await handBack(e, judge, review, { verdict, summary: `${label} ${verdict}`, findings });
  return { work: t, review, builder, judge };
}
const stepsOf = (e) => e.raw('SELECT seq, step, outcome, row_ref, error, trigger_table, trigger_id, trigger_seq FROM policy_step ORDER BY seq');
const latest = (e, table, id) => e.raw(`SELECT * FROM ${table} WHERE id = ? ORDER BY seq DESC LIMIT 1`, id)[0];

test('fix: a refuted review makes the fix under the claim and assigns it to the builder; every row is stamped with the claim\'s trigger', async () => {
  const e = await env();
  try {
    const { work, review, builder } = await judged(e, 'f', 'refuted');
    const out = await e.exec().tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['fix', 'done']]);
    const fixes = e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id);
    assert.strictEqual(fixes.length, 1);
    const fixRow = latest(e, 'task', fixes[0].id);
    assert.strictEqual(stepsOf(e)[0].row_ref, `task:${fixes[0].id}`);
    assert.strictEqual(stepsOf(e)[0].trigger_id, review.id);
    const lease = e.raw('SELECT holder, acted_by, trigger FROM lease WHERE task_id = ? ORDER BY seq', fixes[0].id)[0];
    assert.deepStrictEqual([lease.holder, lease.acted_by], [builder, 'policy'], 'to the one who built the work');
    assert.strictEqual(e.raw("SELECT acted_by FROM task WHERE id = ? ORDER BY seq", fixes[0].id)[0].acted_by, 'policy');
    assert.ok(fixRow);
    assert.deepStrictEqual((await e.exec().tick()).steps, [], 'the next pass finds the trigger taken');
    assert.strictEqual(e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id).length, 1);
  } finally { await e.close(); }
});

test('re_review: a done fix gets a review that depends on it, assigned to the worker that refuted, stamped by the step', async () => {
  const e = await env();
  try {
    const { work, builder, judge } = await judged(e, 'r', 'refuted');
    const x = e.exec();
    await x.tick(); // the fix, assigned to the builder
    const fix = e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id)[0];
    const w = await e.worker(builder);
    const lease = latest(e, 'lease', e.raw('SELECT id FROM lease WHERE task_id = ?', fix.id)[0].id);
    await w.lease.release({ lease_id: lease.id, reason: 'done', result: { branch: 'b', head: 'h2' } });
    assert.strictEqual((await e.h.task.evaluate({ task_id: fix.id, worktree: e.dir, trigger: 'release' })).state, 'done');
    const out = await x.tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['re_review', 'done']]);
    const made = out.steps[0].row_ref.replace('task:', '');
    const row = latest(e, 'task', made);
    assert.deepStrictEqual([row.acted_by, JSON.parse(row.depends_on), JSON.parse(row.acceptance).verdict], ['policy', [fix.id], true]);
    const l = e.raw('SELECT holder, acted_by FROM lease WHERE task_id = ? ORDER BY seq', made)[0];
    assert.deepStrictEqual([l.holder, l.acted_by], [judge, 'policy'], 'to the refuter, not the builder');
    assert.deepStrictEqual((await x.tick()).steps, []);
  } finally { await e.close(); }
});

test('integrate: a held, done work is merged into the run\'s own branch by the step, and the claim names the integration row', async () => {
  const e = await env();
  try {
    const repo = makeRepo(e.dir);
    const t = await e.orch.task.create({ spec: 'write a.txt', acceptance: PASS, policy: PLAN });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
    write(wt.path, 'a.txt', 'a\n'); commit(wt.path, `task ${t.id}`);
    const { work } = await judged(e, 'i', 'holds', { work: t, tree: wt.path });
    // the work was handed back from its tree
    assert.strictEqual(latest(e, 'task', work.id).state, 'done');
    const out = await e.exec().tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['integrate', 'done']]);
    const id = out.steps[0].row_ref.replace('integration:', '');
    const row = latest(e, 'integration', id);
    assert.deepStrictEqual([row.into_branch, row.acted_by], [`belay/integrate/${RUN}`, 'policy']);
    assert.deepStrictEqual((await e.exec().tick()).steps, []);
  } finally { await e.close(); }
});

test('the orchestrator acting first: its fix stands, the claim ends superseded naming it, and no second fix or assignment is made', async () => {
  const e = await env();
  try {
    const { work, review } = await judged(e, 's', 'refuted');
    const mine = await e.orch.task.fixFromReview({ review_id: review.id });
    const out = await e.exec().tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome, s.row_ref]), [['fix', 'superseded', `task:${mine.id}`]]);
    assert.strictEqual(e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id).length, 1);
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM lease WHERE acted_by = 'policy'")[0].n, 0, 'the step assigned nothing');
  } finally { await e.close(); }
});

test('a paused run takes no claim against the real run row, and takes the step once it resumes', async () => {
  const e = await env();
  try {
    await judged(e, 'p', 'refuted');
    await e.orch.run.setPaused({ paused: true });
    const x = e.exec();
    const held = await x.tick();
    assert.strictEqual(held.held, 'paused');
    assert.deepStrictEqual(stepsOf(e), []);
    await e.orch.run.setPaused({ paused: false });
    assert.deepStrictEqual((await x.tick()).steps.map((s) => s.step), ['fix']);
  } finally { await e.close(); }
});

const PW = require('../../src/run/policy-wakes.cjs');
const halted = async (e) => { const tasks = (await e.h.task.list({})).tasks; const steps = (await e.h.policy.list({})).rows; return PW.haltedIds(PW.derive({ runId: RUN, tasks, integrations: [], steps, failures: [] }), tasks); };

test('a fix a step wrote stays under its work\'s plan after the worker\'s hand-back resets its stamp; an orchestrator\'s fix does not', async () => {
  const e = await env();
  try {
    const { work, review, builder } = await judged(e, 'h', 'refuted');
    await e.exec().tick();
    const fix = e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id)[0].id;
    const w = await e.worker(builder);
    await w.lease.release({ lease_id: e.raw('SELECT id FROM lease WHERE task_id = ?', fix)[0].id, reason: 'done', result: { branch: 'b', head: 'h2' } });
    await e.h.task.evaluate({ task_id: fix, worktree: e.dir, trigger: 'release' });
    const tasks = (await e.h.task.list({})).tasks;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const row = byId.get(fix);
    assert.strictEqual(row.acted_by, null, 'the hand-back and the evaluation reset the stamp');
    assert.strictEqual(row.policy_made, true, 'the first version was the step\'s');
    assert.deepStrictEqual(PW.policyOf(row, byId), PLAN);
    // the orchestrator's own fix of another refuted review resolves its own plan
    const other = await judged(e, 'h2', 'refuted');
    const mine = await e.orch.task.fixFromReview({ review_id: other.review.id });
    const again = new Map((await e.h.task.list({})).tasks.map((t) => [t.id, t]));
    assert.strictEqual(again.get(mine.id).policy_made, false);
    assert.strictEqual(PW.policyOf(again.get(mine.id), again), null);
    assert.ok(review);
  } finally { await e.close(); }
});

test('a step claimed at plan rev 1 that fails halts its task, and an amend to rev 2 lifts the halt', async () => {
  const e = await env();
  try {
    const { work } = await judged(e, 'a', 'refuted');
    await e.orch.worker.write({ id: 'build-a', substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: 's-build-a', last_event_at: Date.now(), worktree: e.dir });
    const x = e.exec();
    await x.tick();
    const [s] = stepsOf(e);
    assert.strictEqual(s.outcome, 'exception');
    assert.strictEqual(e.raw('SELECT policy_rev FROM policy_step WHERE seq = ?', s.seq)[0].policy_rev, 1, 'claimed at the plan\'s revision');
    assert.ok((await halted(e)).has(work.id), 'halted');
    await e.orch.task.create({ id: work.id, amend: true, policy: PLAN });
    assert.strictEqual(latest(e, 'task', work.id).policy_rev, 2);
    assert.ok(!(await halted(e)).has(work.id), 'the amend lifts it');
  } finally { await e.close(); }
});

test('a worker\'s view of a task shows neither the plan nor that a policy step made it', async () => {
  const e = await env();
  try {
    const { work } = await judged(e, 'v', 'refuted');
    await e.exec().tick();
    const fix = e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id)[0].id;
    const w = await e.worker('build-v');
    for (const t of [(await w.task.get({ task_id: fix })), (await w.task.get({ task_id: work.id })), ...(await w.task.list({})).tasks]) {
      assert.ok(!('policy_made' in t) && !('policy' in t) && !('policy_rev' in t), t.id);
    }
    assert.strictEqual((await e.h.task.get({ task_id: fix })).policy_made, true, 'the orchestrator sees it');
  } finally { await e.close(); }
});

// The harness view with some calls replaced: over.policy(group) -> the policy group to use.
const wrap = (h, over) => new Proxy({}, { get: (_, k) => (over[k] ? over[k](h[k]) : h[k]) });
const fixesOf = (e, id) => e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', id);

test('a plan amended away between the claim and the effect: the step is skipped and writes nothing', async () => {
  const e = await env();
  try {
    const { work } = await judged(e, 'm', 'refuted');
    const amendAfterClaim = wrap(e.h, { policy: (p) => ({ ...p, claim: async (a) => { const r = await p.claim(a); await e.orch.task.create({ id: work.id, amend: true, policy: null }); return r; } }) });
    const out = await e.exec({}, amendAfterClaim).tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['fix', 'skipped']]);
    assert.match(stepsOf(e)[0].error, /no longer due|plan/);
    assert.strictEqual(fixesOf(e, work.id).length, 0, 'no fix was made');
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM lease WHERE acted_by = 'policy'")[0].n, 0);
  } finally { await e.close(); }
});

test('a plan revision that moved between the claim and the effect skips the step', async () => {
  const e = await env();
  try {
    const { work } = await judged(e, 'n', 'refuted');
    const amend = wrap(e.h, { policy: (p) => ({ ...p, claim: async (a) => { const r = await p.claim(a); await e.orch.task.create({ id: work.id, amend: true, policy: PLAN }); return r; } }) });
    const out = await e.exec({}, amend).tick();
    assert.deepStrictEqual(out.steps.map((s) => s.outcome), ['skipped']);
    assert.match(stepsOf(e)[0].error, /rev 1 to rev 2/);
    assert.strictEqual(fixesOf(e, work.id).length, 0);
  } finally { await e.close(); }
});

test('a plan revision that moved to the same plan leaves the step claimable: the next pass takes it once', async () => {
  const e = await env();
  try {
    const { work } = await judged(e, 'r', 'refuted');
    const amend = wrap(e.h, { policy: (p) => ({ ...p, claim: async (a) => { const r = await p.claim(a); await e.orch.task.create({ id: work.id, amend: true, policy: PLAN }); return r; } }) });
    assert.deepStrictEqual((await e.exec({}, amend).tick()).steps.map((s) => s.outcome), ['skipped']);
    const second = await e.exec().tick();
    assert.deepStrictEqual(second.steps.map((s) => [s.step, s.outcome]), [['fix', 'done']], 'a not-now skip is retaken');
    assert.strictEqual(stepsOf(e).length, 1, 'the same claim row, reopened');
    assert.strictEqual(fixesOf(e, work.id).length, 1);
    assert.deepStrictEqual((await e.exec().tick()).steps, [], 'and not again');
  } finally { await e.close(); }
});

test('an integrate skipped because another integration was merging is taken once that merge is over', async () => {
  const e = await env();
  try {
    const repo = makeRepo(e.dir);
    const t = await e.orch.task.create({ spec: 'write a.txt', acceptance: PASS, policy: PLAN });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
    write(wt.path, 'a.txt', 'a\n'); commit(wt.path, `task ${t.id}`);
    const { work } = await judged(e, 'g', 'holds', { work: t, tree: wt.path });
    let calls = 0;
    const merging = wrap(e.h, { integration: (i) => ({ ...i, list: async (a) => { calls++; const r = await i.list(a); return calls === 2 ? { integrations: [{ id: 'other', run_id: RUN, state: 'merging', task_ids: ['x'] }] } : r; } }) });
    assert.deepStrictEqual((await e.exec({}, merging).tick()).steps.map((s) => [s.step, s.outcome]), [['integrate', 'skipped']]);
    const second = await e.exec().tick();
    assert.deepStrictEqual(second.steps.map((s) => [s.step, s.outcome]), [['integrate', 'done']]);
    assert.strictEqual(latest(e, 'task', work.id).state, 'done');
    assert.deepStrictEqual((await e.exec().tick()).steps, []);
  } finally { await e.close(); }
});

test('a retake after the plan moved runs under the new revision: the claim and the lease carry it, and a failed retake halts the task', async () => {
  const e = await env();
  try {
    const a = await judged(e, 'v', 'refuted');
    const amendOnce = (work) => wrap(e.h, { policy: (p) => ({ ...p, claim: async (x) => { const r = await p.claim(x); await e.orch.task.create({ id: work.id, amend: true, policy: PLAN }); return r; } }) });
    assert.deepStrictEqual((await e.exec({}, amendOnce(a.work)).tick()).steps.map((s) => s.outcome), ['skipped']);
    const rev = latest(e, 'task', a.work.id).policy_rev;
    assert.strictEqual(rev, 2);
    assert.deepStrictEqual((await e.exec().tick()).steps.map((s) => s.outcome), ['done']);
    assert.strictEqual(e.raw('SELECT policy_rev FROM policy_step')[0].policy_rev, rev, 'the claim carries the revision the step ran under');
    const fx = fixesOf(e, a.work.id)[0];
    assert.strictEqual(e.raw('SELECT policy_rev FROM lease WHERE task_id = ? ORDER BY seq', fx.id)[0].policy_rev, rev, 'and so does the lease');
  } finally { await e.close(); }
});

test('a retake that fails after the plan moved is an E8 that is not lifted, and halts the task', async () => {
  const e = await env();
  try {
    const { work, builder } = await judged(e, 'u', 'refuted');
    const amend = wrap(e.h, { policy: (p) => ({ ...p, claim: async (x) => { const r = await p.claim(x); await e.orch.task.create({ id: work.id, amend: true, policy: PLAN }); return r; } }) });
    assert.deepStrictEqual((await e.exec({}, amend).tick()).steps.map((s) => s.outcome), ['skipped']);
    await e.orch.worker.write({ id: builder, substrate: 'claude-code', pid: process.pid, state: 'dead', session_id: `s-${builder}`, last_event_at: Date.now(), worktree: e.dir });
    assert.deepStrictEqual((await e.exec().tick()).steps.map((s) => s.outcome), ['exception']);
    const tasks = (await e.h.task.list({})).tasks; const steps = (await e.h.policy.list({})).rows;
    const ex = PW.derive({ runId: RUN, tasks, integrations: [], steps, failures: [], revisions: await PW.readRevisions(e.h.policy, RUN, tasks) });
    assert.deepStrictEqual(ex.map((x) => [x.exception, !!x.lifted]), [['E8', false]]);
    assert.ok(PW.haltedIds(ex, tasks).has(work.id));
  } finally { await e.close(); }
});

test('a pause between the claim and the first write skips the step as paused; the resume reopens the claim and the step completes once', async () => {
  const e = await env();
  try {
    const { work } = await judged(e, 'q', 'refuted');
    const pauseAfterClaim = wrap(e.h, { policy: (p) => ({ ...p, claim: async (a) => { const r = await p.claim(a); await e.orch.run.setPaused({ paused: true }); return r; } }) });
    const first = await e.exec({}, pauseAfterClaim).tick();
    assert.deepStrictEqual(first.steps.map((s) => s.outcome), ['skipped']);
    assert.match(stepsOf(e)[0].error, /^E_PAUSED/);
    assert.strictEqual(fixesOf(e, work.id).length, 0);
    await e.orch.run.setPaused({ paused: false });
    const second = await e.exec().tick();
    assert.deepStrictEqual(second.steps.map((s) => [s.step, s.outcome]), [['fix', 'done']]);
    assert.strictEqual(stepsOf(e).length, 1, 'the same claim row, reopened');
    assert.strictEqual(stepsOf(e)[0].outcome, 'done');
    assert.strictEqual(fixesOf(e, work.id).length, 1);
    assert.deepStrictEqual((await e.exec().tick()).steps, [], 'and not again');
  } finally { await e.close(); }
});

test('the sweep names the row a dead step wrote (done), or records the interruption when it wrote none (exception)', async () => {
  const e = await env();
  try {
    const { work, review } = await judged(e, 'w', 'refuted');
    // a step whose process ended after the fix was made and before its claim was finished
    const dying = wrap(e.h, { policy: (p) => ({ ...p, finish: async () => { throw Object.assign(new Error('the owner is gone'), { code: 'E_TIMEOUT' }); } }) });
    await e.exec({}, dying).tick();
    const fix = fixesOf(e, work.id)[0].id;
    assert.strictEqual(stepsOf(e)[0].outcome, 'started');
    // a claim that wrote nothing
    const bare = (await e.h.policy.claim({ step: 'integrate', trigger: { table: 'task', id: review.id, seq: 1 }, task_id: work.id })).row.seq;
    await e.exec({ identity: { pid: 999999, created: 'later' }, aliveBy: async () => false }).tick(); // a later adapter life; the first one's process is gone
    const rows = stepsOf(e);
    assert.deepStrictEqual([rows[0].outcome, rows[0].row_ref], ['done', `task:${fix}`]);
    const b = rows.find((r) => r.seq === bare);
    assert.strictEqual(b.outcome, 'exception');
    assert.match(b.error, /interrupted/);
    assert.strictEqual(fixesOf(e, work.id).length, 1, 'nothing was repeated');
  } finally { await e.close(); }
});

test('two executors on one run: a claim whose claimant is alive is not swept by the other; once the claimant is gone it is', async () => {
  const e = await env();
  try {
    const { work, review } = await judged(e, 'l', 'refuted');
    // executor A's step is in flight: claimed, not finished
    const live = (await e.h.policy.claim({ step: 'integrate', trigger: { table: 'task', id: review.id, seq: 1 }, task_id: work.id, claimant_pid: process.pid, claimant_created: 'own' })).row.seq;
    const outcome = () => e.raw('SELECT outcome FROM policy_step WHERE seq = ?', live)[0].outcome;
    const alive = async (pid, created) => pid === process.pid && created === 'own';
    await e.exec({ identity: { pid: 999998, created: 'b' }, aliveBy: alive }).tick(); // executor B, whose first pass sweeps
    assert.strictEqual(outcome(), 'started', 'a live claimant claim is left alone');
    await e.exec({ identity: { pid: 999997, created: 'c' }, aliveBy: async () => false }).tick(); // A is gone
    assert.strictEqual(outcome(), 'exception');
  } finally { await e.close(); }
});

test('the sweep of a fix that died between its task and its assignment is an exception that names the task, and the task is halted', async () => {
  const e = await env();
  try {
    const { work } = await judged(e, 'z', 'refuted');
    const dead = (v) => Object.freeze({ ...v, task: { ...v.task, assign: async () => { throw Object.assign(new Error('the adapter ended'), { code: 'E_TIMEOUT' }); } } });
    const dying = wrap(e.h, {
      policyAs: (orig) => (seq) => dead(orig(seq)),
      policy: (p) => ({ ...p, finish: async () => { throw Object.assign(new Error('the owner is gone'), { code: 'E_TIMEOUT' }); } }),
    });
    await e.exec({}, dying).tick();
    const fix = fixesOf(e, work.id)[0].id;
    assert.strictEqual(stepsOf(e)[0].outcome, 'started');
    assert.strictEqual(e.raw("SELECT COUNT(*) AS n FROM lease WHERE acted_by = 'policy'")[0].n, 0, 'it never assigned');
    await e.exec({ identity: { pid: 999999, created: 'later' }, aliveBy: async () => false }).tick();
    const [s] = stepsOf(e);
    assert.deepStrictEqual([s.outcome, s.row_ref], ['exception', `task:${fix}`]);
    assert.match(s.error, /last write/);
    assert.ok((await halted(e)).has(work.id), 'E8 halts the task and wakes the orchestrator');
  } finally { await e.close(); }
});
