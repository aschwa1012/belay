'use strict';
require('../helpers/tmp.cjs');
// policy-exec.test.cjs — ADR 0072 decisions 1, 6 and 8: the policy executor's three v1 steps (fix to the builder, re_review to the
// refuter, integrate on a hold), its claim-first rule, the pause, the halt, a restart between a claim and its effect, the orchestrator
// acting first, and the close. The core is a scripted in-memory stand-in with the real claim semantics (one row per trigger, a claim
// finished once, a stamped view only for an open claim); no model, no process, no sleep. Each effect the stand-in records names the claim
// it was made under, so a test can say which step made which call.

const test = require('node:test');
const assert = require('node:assert');
const { createPolicyExecutor } = require('../../src/run/policy-exec.cjs');

const RUN = 'r1';
const PLAN = { review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
let nextSeq = 100;
const task = (id, over = {}) => ({ id, seq: nextSeq++, run_id: RUN, state: 'open', policy: null, policy_rev: null, depends_on: [], repairs: null, results: null, handoff: null, lease: null, review: null, integration: null, acceptance: {}, written_at: 50, ...over });
const rel = (over = {}) => ({ trigger: 'release', evaluated_at: 20, executable: true, passed: true, checks: [], ...over });
const by = (w) => ({ by: w, at: 10 });
const verdict = (holds) => ({ kind: 'verdict', executable: true, passed: holds, detail: { verdict: holds ? 'holds' : 'refuted', summary: 's', findings: [] } });const review = (id, work, rv = 'rv', holds = false) => task(id, { state: holds ? 'done' : 'released', depends_on: [work], acceptance: { verdict: true }, handoff: by(rv), results: rel({ passed: holds, checks: [verdict(holds)] }), spec: 'Review the work.' });
const work = (id, rv, over = {}) => task(id, { state: 'done', policy: PLAN, policy_rev: 1, handoff: by('b1'), results: rel(), review: rv, ...over });
const refuted = (rid = 'R') => ({ state: 'refuted', review_id: rid, rounds_left: 1 });
const idle = (id) => ({ id, state: 'idle', substrate: 'claude-code', pid_alive: true });
const err = (code, message) => Object.assign(new Error(message), { code });

// The stand-in. `s.calls` is every call as { m, step } (step: the claim seq of a stamped call, else null).
function store({ tasks = [], steps = [], integrations = [], workers = [idle('b1'), idle('rv')], run = { id: RUN, paused_at: null, ended_at: null } } = {}) {
  const s = { tasks, integrations, workers, run, calls: [], rows: steps.map((r) => ({ ...r })), script: {}, madeSeq: 0 };
  const rec = (m, step = null, args) => s.calls.push({ m, step, args });
  const keyOf = (r) => `${r.step}|${r.trigger_table}|${r.trigger_id}|${r.trigger_seq}`;
  s.row = (seq) => s.rows.find((r) => r.seq === seq);
  const open = (seq) => { const r = s.row(seq); if (!r || r.outcome !== 'started') throw err('E_ARGS', `step ${seq} is not an open claim`); return r; };
  const reads = (step) => ({
    task: {
      list: async () => { rec('task.list', step); return { tasks: s.tasks }; },
      get: async (a) => { rec('task.get', step); return s.tasks.find((t) => t.id === a.task_id); },
      fixFromReview: async (a) => { rec('task.fixFromReview', step, a); return s.script.fix ? s.script.fix(a) : { id: 'F1', seq: 900 }; },
      create: async (a) => { rec('task.create', step, a); return s.script.create ? s.script.create(a) : { id: 'RR1', seq: 901 }; },
      assign: async (a) => { rec('task.assign', step, a); return s.script.assign ? s.script.assign(a) : { delivered: { sent: true }, new_lease: { id: 'L1' } }; },
    },
    integration: { merge: async (a) => { rec('integration.merge', step, a); return s.script.merge ? s.script.merge(a) : { id: 'I1', state: 'merged', passed: true }; } },
    worker: { list: async () => { rec('worker.list', step); return { workers: s.workers }; } },
  });
  s.core = {
    ...reads(null),
    run: { get: async () => { rec('run.get'); return { run: s.run }; } },
    integration: { list: async () => { rec('integration.list'); return { integrations: s.integrations }; }, merge: async () => { throw err('E_ROLE', 'not stamped'); } },
    policy: {
      list: async () => { rec('policy.list'); return { rows: s.rows.slice() }; },
      claim: async (a) => {
        rec('policy.claim', null, a);
        const row = { seq: s.rows.length + 1, run_id: RUN, task_id: a.task_id || null, step: a.step, trigger_table: a.trigger.table, trigger_id: a.trigger.id, trigger_seq: a.trigger.seq, policy_rev: a.policy_rev ?? null, outcome: 'started', worker_id: a.worker_id || null };
        const there = s.rows.find((r) => keyOf(r) === keyOf(row));
        if (there) return { row: there, existing: true };
        s.rows.push(row);
        return { row, existing: false };
      },
      finish: async (a) => {
        rec('policy.finish', null, a);
        const r = open(a.seq);
        if ((a.outcome === 'done' || a.outcome === 'superseded') && !a.row_ref) throw err('E_ARGS', 'row_ref needed');
        if ((a.outcome === 'exception' || a.outcome === 'skipped') && !a.error) throw err('E_ARGS', 'error needed');
        Object.assign(r, { outcome: a.outcome, row_ref: a.row_ref || null, error: a.error || null, finished_at: 1000 });
        return { row: r };
      },
    },
    policyAs: (seq) => { open(seq); return Object.freeze(reads(seq)); },
  };
  s.assignFor = (stepCore) => async (a) => stepCore.task.assign(a); // the adapter's assign, over the stamped view
  s.exec = (extra = {}) => { const e = createPolicyExecutor({ core: s.core, runId: RUN, assignFor: s.assignFor, closeWaitMs: 0, identity: { pid: process.pid, created: 't' }, ...extra }); e.arm(); return e; };
  s.writes = () => s.calls.filter((c) => ['task.fixFromReview', 'task.create', 'task.assign', 'integration.merge', 'policy.claim'].includes(c.m));
  s.noneStarted = () => assert.deepStrictEqual(s.rows.filter((r) => r.outcome === 'started'), [], 'no claim is left started');
  return s;
}

// W refuted by R (builder b1, refuter rv).
const refutedWork = (extra = {}) => store({ tasks: [work('W', refuted()), review('R', 'W')], ...extra });

test('fix: a refuted review is claimed, the fix is made under the claim and assigned to the builder, and the claim names the fix', async () => {
  const s = refutedWork();
  const out = await s.exec().tick();
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome, x.row_ref]), [['fix', 'done', 'task:F1']]);
  const claim = s.calls.find((c) => c.m === 'policy.claim');
  assert.deepStrictEqual(claim.args.trigger, { table: 'task', id: 'R', seq: s.tasks[1].seq });
  assert.strictEqual(claim.args.policy_rev, 1);
  const fixCall = s.calls.find((c) => c.m === 'task.fixFromReview');
  assert.deepStrictEqual([fixCall.step, fixCall.args], [1, { review_id: 'R' }], 'made under the claim, with nothing but the review');
  const as = s.calls.find((c) => c.m === 'task.assign');
  assert.deepStrictEqual([as.step, as.args], [1, { task_id: 'F1', worker_id: 'b1' }], 'to the one who built what was judged');
  assert.strictEqual(s.row(1).outcome, 'done');
  s.noneStarted();
});

test('level-triggered: the next pass finds the trigger taken and writes nothing', async () => {
  const s = refutedWork();
  const e = s.exec();
  await e.tick();
  const before = s.writes().length;
  const out = await e.tick();
  assert.deepStrictEqual(out.steps, []);
  assert.strictEqual(s.writes().length, before, 'no second claim and no second effect');
});

test('no plan, nothing armed: the executor reads nothing; armed with no plan on any task: only the two reads', async () => {
  const s = refutedWork();
  const idleExec = createPolicyExecutor({ core: s.core, runId: RUN, assignFor: s.assignFor });
  assert.strictEqual(await idleExec.tick(), null);
  assert.strictEqual(s.calls.length, 0, 'unarmed: no core call at all');
  const n = store({ tasks: [task('A', { state: 'done' })] });
  await n.exec().tick();
  assert.deepStrictEqual(n.calls.map((c) => c.m), ['policy.list', 'task.list']);
});

test('re_review: a done fix with no review gets one that depends on it, assigned to the worker that refuted', async () => {
  const W = work('W', { state: 'pending', review_id: 'R', rounds_left: 1 });
  const F = task('F1', { state: 'done', repairs: 'W', acted_by: 'policy', depends_on: ['W'], handoff: by('b1'), results: rel(), answers: ['R'] });
  const s = store({ tasks: [W, review('R', 'W'), F] });
  const out = await s.exec().tick();
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome, x.row_ref]), [['re_review', 'done', 'task:RR1']]);
  const made = s.calls.find((c) => c.m === 'task.create');
  assert.deepStrictEqual([made.args.depends_on, made.args.acceptance], [['F1'], { verdict: true }]);
  assert.strictEqual(made.step, 1);
  assert.deepStrictEqual(s.calls.find((c) => c.m === 'task.assign').args, { task_id: 'RR1', worker_id: 'rv' }, 'to the refuter, not the builder');
  s.noneStarted();
});

test('re_review: a review of the fix that already exists is the orchestrator\'s, and the step is superseded by it', async () => {
  const W = work('W', { state: 'pending', review_id: 'R', rounds_left: 1 });
  const F = task('F1', { state: 'done', repairs: 'W', acted_by: 'policy', depends_on: ['W'], handoff: by('b1'), results: rel(), answers: ['R'] });
  const mine = task('RX', { state: 'open', depends_on: ['F1'], acceptance: { verdict: true } });
  // the review appears after the pass read the list: the claim is taken, then the fresh read finds it
  const s = store({ tasks: [W, review('R', 'W'), F] });
  const list = s.core.task.list;
  let n = 0;
  s.core.task.list = async (a) => { const r = await list(a); n += 1; if (n <= 2) return r; return { tasks: [...r.tasks, mine] }; };
  const reads = s.core.policyAs;
  s.core.policyAs = (seq) => { const v = reads(seq); return Object.freeze({ ...v, task: { ...v.task, list: s.core.task.list } }); };
  const out = await s.exec().tick();
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome, x.row_ref]), [['re_review', 'superseded', 'task:RX']]);
  assert.strictEqual(s.calls.filter((c) => c.m === 'task.create').length, 0, 'it made no second review');
});

test('integrate: a held, done, unmerged work is merged with its done fixes and nothing else, into no named branch', async () => {
  const F = task('F1', { state: 'done', repairs: 'W', acted_by: 'policy', depends_on: ['W'] });
  const s = store({ tasks: [work('W', { state: 'holds', review_id: 'R2', rounds_left: 1 }), review('R2', 'F1', 'rv', true), F] });
  const out = await s.exec().tick();
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome, x.row_ref]), [['integrate', 'done', 'integration:I1']]);
  const m = s.calls.find((c) => c.m === 'integration.merge');
  assert.deepStrictEqual([m.step, m.args], [1, { task_ids: ['W', 'F1'] }], 'no into, force, approval or take_over');
  s.noneStarted();
});

test('integrate: a conflict is a finished step naming its row; a failed merge and failed checks are exceptions that keep the row', async () => {
  for (const [row, outcome] of [[{ id: 'I1', state: 'conflict', conflict: { files: ['a'] } }, 'done'], [{ id: 'I1', state: 'failed', error: { message: 'x' } }, 'exception'], [{ id: 'I1', state: 'merged', passed: false }, 'exception']]) {
    const s = store({ tasks: [work('W', { state: 'holds', review_id: 'R2', rounds_left: 1 }), review('R2', 'W', 'rv', true)] });
    s.script.merge = async () => row;
    const out = await s.exec().tick();
    assert.deepStrictEqual([out.steps[0].outcome, out.steps[0].row_ref], [outcome, 'integration:I1'], row.state);
    s.noneStarted();
  }
});

test('integrate waits for a dependency that has not landed, and takes it when it has', async () => {
  const D = work('D', null, { integration: { state: 'not_merged' } });
  const W = work('W', { state: 'holds', review_id: 'R2', rounds_left: 1 }, { depends_on: ['D'] });
  const s = store({ tasks: [D, W, review('R2', 'W', 'rv', true)] });
  const e = s.exec();
  assert.deepStrictEqual((await e.tick()).steps, []);
  D.integration = { state: 'merged' };
  assert.deepStrictEqual((await e.tick()).steps.map((x) => x.step), ['integrate']);
});

test('pause: a paused run takes no claim; at resume one pass takes the triggers that arrived, in row order', async () => {
  const W1 = work('W1', refuted('R1'), { handoff: by('b1') });
  const W2 = work('W2', refuted('R2'), { handoff: by('b2') });
  const R2 = review('R2', 'W2'); const R1 = review('R1', 'W1'); // R2 was written first
  const s = store({ tasks: [W1, W2, R2, R1], workers: [idle('b1'), idle('b2'), idle('rv')] });
  s.run.paused_at = 5;
  const e = s.exec();
  const held = await e.tick();
  assert.strictEqual(held.held, 'paused');
  assert.deepStrictEqual(s.writes(), [], 'nothing claimed, nothing made');
  s.run.paused_at = null;
  const out = await e.tick();
  assert.deepStrictEqual(out.steps.map((x) => x.task_id), ['W2', 'W1'], 'in the order the triggers were written');
  s.noneStarted();
});

test('pause: a pause that begins mid-pass stops the next claim; an ended run takes none', async () => {
  const s = store({ tasks: [work('W1', refuted('R1')), review('R1', 'W1'), work('W2', refuted('R2'), { handoff: by('b2') }), review('R2', 'W2')], workers: [idle('b1'), idle('b2'), idle('rv')] });
  s.script.fix = async () => { s.run.paused_at = 9; return { id: 'F1' }; };
  const out = await s.exec().tick();
  assert.strictEqual(out.steps.length, 1);
  assert.strictEqual(out.held, 'paused');
  const e = store({ tasks: [work('W', refuted()), review('R', 'W')], run: { id: RUN, paused_at: null, ended_at: 7 } });
  assert.strictEqual((await e.exec().tick()).held, 'ended');
  assert.deepStrictEqual(e.writes(), []);
});

test('halt: a task with a failed step takes no further step until a later row of its own lifts the halt', async () => {
  const W = work('W', refuted(), { written_at: 50 });
  const failed = { seq: 1, run_id: RUN, task_id: 'W', step: 're_review', trigger_table: 'task', trigger_id: 'Z', trigger_seq: 1, outcome: 'exception', error: 'boom', policy_rev: 1, at: 60, finished_at: 61 };
  const s = store({ tasks: [W, review('R', 'W')], steps: [failed] });
  const e = s.exec();
  assert.deepStrictEqual((await e.tick()).steps, [], 'halted');
  assert.deepStrictEqual(s.writes(), []);
  W.policy_rev = 2; // the orchestrator amended the plan
  assert.deepStrictEqual((await e.tick()).steps.map((x) => x.step), ['fix']);
});

test('halt: a step that fails halts the task for the rest of the pass', async () => {
  const W = work('W', refuted());
  const R = review('R', 'W'); // written before the fix, so its trigger sorts first
  const F = task('F1', { state: 'done', repairs: 'W', acted_by: 'policy', depends_on: ['W'], results: rel(), handoff: by('b1'), answers: ['R'] });
  const s = store({ tasks: [W, R, F] }); // a fix is due and so is a re_review: the first fails
  s.script.fix = async () => { throw err('E_PRECONDITION', 'no'); };
  const out = await s.exec().tick();
  assert.deepStrictEqual(out.steps.map((x) => [x.step, x.outcome]), [['fix', 'exception']], 'the re_review on the same task is not taken');
});

test('restart between claim and effect: the claim left started is finished as an exception, its effect is not repeated, and it is not claimed again', async () => {
  const R = review('R', 'W');
  const left = { seq: 1, run_id: RUN, task_id: 'W', step: 'fix', trigger_table: 'task', trigger_id: 'R', trigger_seq: R.seq, outcome: 'started' };
  const s = store({ tasks: [work('W', refuted()), R], steps: [left] });
  const out = await s.exec().tick(); // a fresh executor: it remembers nothing but the rows
  assert.deepStrictEqual(out.swept, [1]);
  assert.strictEqual(s.row(1).outcome, 'exception');
  assert.match(s.row(1).error, /interrupted/);
  assert.deepStrictEqual(s.writes(), [], 'no second claim, no fix, no assignment');
  assert.strictEqual(s.rows.length, 1);
  s.noneStarted();
});

test('the orchestrator acting first: a fix that already answers the review, or an assignment it made, ends the claim superseded naming that row', async () => {
  const a = refutedWork();
  a.script.fix = async () => ({ id: 'F9', existing: true, superseded: true });
  const o1 = await a.exec().tick();
  assert.deepStrictEqual(o1.steps.map((x) => [x.outcome, x.row_ref]), [['superseded', 'task:F9']]);
  assert.strictEqual(a.calls.filter((c) => c.m === 'task.assign').length, 0, 'it did not assign again');
  const b = refutedWork();
  b.script.assign = async () => ({ existing: true, superseded: true, new_lease: { id: 'L9' } });
  const o2 = await b.exec().tick();
  assert.deepStrictEqual(o2.steps.map((x) => [x.outcome, x.row_ref]), [['superseded', 'lease:L9']]);
  a.noneStarted(); b.noneStarted();
});

test('a step that fails is an exception that is not retried: a refusal, a dead or busy builder, a worker not told', async () => {
  const cases = [
    ['E_FIX_ROUNDS', (s) => { s.script.fix = async () => { throw err('E_FIX_ROUNDS', 'past the cap'); }; }, /E_FIX_ROUNDS: past the cap/, null],
    ['dead builder', (s) => { s.workers[0] = { id: 'b1', state: 'dead', pid_alive: false }; }, /builder b1 is dead/, null],
    ['busy builder', (s) => { s.tasks.push(task('T9', { state: 'open', lease: { id: 'L', holder: 'b1', expired: false } })); }, /builder b1 is busy with task T9/, null],
    ['not told', (s) => { s.script.assign = async () => ({ delivered: { sent: false, reason: 'no channel' }, new_lease: { id: 'L1' } }); }, /not told: no channel/, 'task:F1'],
    ['assign refused', (s) => { s.script.assign = async () => { throw err('E_WORKER_NOT_LIVE', 'gone'); }; }, /E_WORKER_NOT_LIVE/, 'task:F1'],
  ];
  for (const [name, arrange, pattern, ref] of cases) {
    const s = refutedWork();
    arrange(s);
    const e = s.exec();
    const out = await e.tick();
    assert.strictEqual(out.steps[0].outcome, 'exception', name);
    assert.match(s.row(1).error, pattern, name);
    assert.strictEqual(s.row(1).row_ref, ref, name);
    if (name === 'dead builder' || name === 'busy builder') assert.strictEqual(s.calls.filter((c) => c.m === 'task.fixFromReview').length, 0, `${name}: no fix was made for a worker that cannot take it`);
    const n = s.writes().length;
    await e.tick();
    assert.strictEqual(s.writes().length, n, `${name}: not retried`);
    s.noneStarted();
  }
});

test('a fact that changed between the pass and the claim ends the claim skipped, with a reason, and writes nothing', async () => {
  const s = refutedWork();
  const get = s.core.policyAs;
  s.core.policyAs = (seq) => { const v = get(seq); return Object.freeze({ ...v, task: { ...v.task, get: async () => ({ ...s.tasks[0], review: { state: 'holds', review_id: 'R', rounds_left: 1 } }) } }); };
  const out = await s.exec().tick();
  assert.strictEqual(out.steps[0].outcome, 'skipped');
  assert.match(s.row(1).error, /no longer/);
  assert.strictEqual(s.calls.filter((c) => c.m === 'task.fixFromReview').length, 0);
});

test('close: no claim after it, and a step still in flight sends no further call to the store', async () => {
  const s = refutedWork();
  let release; let reached;
  const held = new Promise((r) => { release = r; });
  const there = new Promise((r) => { reached = r; });
  s.script.fix = async () => { reached(); await held; return { id: 'F1' }; };
  const e = s.exec();
  const pending = e.tick();
  await there;
  await e.close(); // closeWaitMs 0: the step is cut loose
  const callsAtClose = s.calls.length;
  release();
  await pending.catch(() => {});
  assert.deepStrictEqual(s.calls.slice(callsAtClose).map((c) => c.m), [], 'nothing reached the store after the close');
  assert.strictEqual(s.row(1).outcome, 'started', 'the claim is left for the next life to finish');
  assert.strictEqual(await e.tick(), null);
});
