'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// done-wake.test.cjs — ADR 0074 amendment 4, "implementation done": the plan-first run's one routine wake. The condition, clause by clause, from
// store rows alone; the watcher sends it once per state, and a later fix and merge make a new one.

const { test } = require('node:test');
const assert = require('node:assert');
const { doneOf, wakeOf } = require('../../src/run/done-wake.cjs');
const PW = require('../../src/run/policy-wakes.cjs');

const RUN = 'r1';
const PLAN = { build: { worker: 'b1' }, review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const work = (id, over = {}) => ({ id, seq: 10, run_id: RUN, state: 'done', policy: PLAN, policy_rev: 1, depends_on: [], repairs: null, lease: null, acceptance: { commands: [] }, review: { review_id: `R-${id}`, state: 'holds' }, integration: { state: 'merged' }, results: { trigger: 'release', executable: true, passed: true, checks: [] }, ...over });
const review = (id, of) => ({ id, seq: 11, run_id: RUN, state: 'done', policy: null, depends_on: [of], repairs: null, lease: null, acceptance: { verdict: true }, results: { trigger: 'release', executable: true, passed: true, checks: [{ kind: 'verdict', executable: true, passed: true }] }, handoff: { by: 'rv' } });
const merged = (over = {}) => ({ id: 'i1', seq: 20, run_id: RUN, state: 'merged', passed: true, into_branch: `belay/integrate/${RUN}`, head_sha: '0123456789abcdef', ...over });
const snap = (over = {}) => ({ runId: RUN, tasks: [work('A'), review('R-A', 'A'), work('B'), review('R-B', 'B')], integrations: [merged()], steps: [], ...over });

test('done: every task done, every planned work reviewed and merged, the newest integration passed, nothing halted, due or in flight', () => {
  const d = doneOf(snap());
  assert.ok(d, 'done');
  assert.strictEqual(d.n, 2);
  assert.strictEqual(d.key, 'i1@20');
  assert.match(d.text, /^belay: implementation done: 2 planned tasks done, reviewed and merged into belay\/integrate\/r1 at 0123456789ab, checks passed\. Decide whether you are done\.$/);
  assert.ok(Buffer.byteLength(d.text) <= PW.WAKE_TEXT_MAX, 'one wake line inside the wake cap');
  assert.deepStrictEqual(wakeOf(RUN, d), { event: 'policy_done', worker_id: `done:${RUN}`, turn: 0, seq: null, key: 'i1@20', text: d.text });
});

test('not done, clause by clause', () => {
  assert.strictEqual(doneOf(snap({ tasks: [work('A', { state: 'released' }), review('R-A', 'A')] })), null, '1: a task not done');
  assert.strictEqual(doneOf(snap({ tasks: [work('A'), review('R-A', 'A'), { ...work('C'), policy: null, state: 'open' }] })), null, '1: any task of the run, planned or not');
  assert.strictEqual(doneOf(snap({ tasks: [work('A', { review: { review_id: 'R-A', state: 'refuted' } }), review('R-A', 'A')] })), null, '2: a review that does not hold');
  assert.strictEqual(doneOf(snap({ tasks: [work('A', { integration: { state: 'conflict' } }), review('R-A', 'A')] })), null, '2: not merged');
  assert.strictEqual(doneOf(snap({ integrations: [merged({ passed: false })] })), null, '3: the merged head failed its checks');
  assert.strictEqual(doneOf(snap({ integrations: [merged(), merged({ id: 'i2', seq: 30, state: 'conflict', passed: null })] })), null, '3: the newest integration is not a clean merge');
  assert.strictEqual(doneOf(snap({ integrations: [] })), null, '3: nothing merged at all');
  assert.strictEqual(doneOf(snap({ steps: [{ run_id: RUN, seq: 5, step: 'integrate', outcome: 'started' }] })), null, '4: a step in flight');
  assert.strictEqual(doneOf(snap({ tasks: [work('A'), review('R-A', 'A'), { ...work('B'), state: 'open' }] }), [{ exception: 'E8', task_id: 'B', lifted: false }]), null, '4: a halted task still open');
  assert.strictEqual(doneOf(snap({ tasks: [{ ...work('A'), policy: null }, review('R-A', 'A')] })), null, 'no planned work: a run with no plan is never "done" by belay');
  assert.strictEqual(doneOf(snap({ tasks: [work('A'), review('R-A', 'A'), { ...work('X'), state: 'cancelled', integration: null }] })) && true, true, 'a cancelled task does not count');
});

test('the watcher sends the done wake once per state; a later merge makes a new one', async () => {
  let s = snap();
  const core = {
    task: { list: async () => ({ tasks: s.tasks }) },
    integration: { list: async () => ({ integrations: s.integrations }) },
    policy: { list: async () => ({ rows: s.steps, last_seq: 0 }) },
    memory: { events: async () => ({ events: [] }) },
  };
  const w = PW.createPolicyWatcher({ core, runId: RUN, enabled: true });
  const dones = (evs) => evs.filter((e) => e.event === 'policy_done');
  assert.strictEqual(dones(await w.poll()).length, 1);
  assert.strictEqual(dones(await w.poll()).length, 0, 'the same state: no second wake');
  s = snap({ integrations: [merged(), merged({ id: 'i2', seq: 40, head_sha: 'feedfacecafe0000' })] });
  const again = dones(await w.poll());
  assert.strictEqual(again.length, 1);
  assert.match(again[0].text, /at feedfacecafe/);
  assert.strictEqual(require('../../src/run/wake.cjs').wakeText(again[0]), again[0].text, 'the wake text is passed through as written');
  assert.ok(require('../../src/run/digest-wake.cjs').ridesDigest(again[0]), 'the digest follows the done wake');
});

test('the digest follows an exception or the done wake, not a routine wake', () => {
  const { ridesDigest } = require('../../src/run/digest-wake.cjs');
  assert.ok(ridesDigest({ event: 'evaluated', exception: 'E5' }));
  assert.ok(ridesDigest({ event: 'death', worker_id: 'w' }), 'a death is E4');
  assert.ok(ridesDigest({ event: 'budget_pause' }), 'E9');
  assert.ok(!ridesDigest({ event: 'turn_end', worker_id: 'w', turn: 2 }), 'a routine turn end carries none');
});

test('the run branch only; a merge whose checks were not run is done and says so; a plan that merges nothing needs no merge', () => {
  // A merge the orchestrator made into its own branch is not the run branch's newest.
  const other = merged({ id: 'iX', seq: 99, into_branch: 'release/1.0', passed: false });
  assert.ok(doneOf(snap({ integrations: [merged(), other] })), 'another branch does not decide');
  assert.strictEqual(doneOf(snap({ integrations: [other] })), null, 'nothing merged into the run branch: not done');
  // evaluate: false leaves passed null: done, and the wake says the checks were not run.
  const notRun = doneOf(snap({ integrations: [merged({ passed: null })] }));
  assert.ok(notRun);
  assert.strictEqual(notRun.checks, 'not_run');
  assert.match(notRun.text, /checks not run on the merged head\./);
  assert.ok(doneOf(snap({ integrations: [merged({ state: 'evaluated' })] })), 'evaluated: merged, then checked');
  // A plan without integrate: reviews hold and tasks are done; no merge is needed.
  const noMerge = { ...PLAN }; delete noMerge.integrate;
  const tasks = [work('A', { policy: noMerge, integration: null }), review('R-A', 'A')];
  const d = doneOf({ runId: RUN, tasks, integrations: [], steps: [] });
  assert.ok(d);
  assert.strictEqual(d.checks, 'none');
  assert.match(d.text, /1 planned task done and reviewed; the plan merges nothing\./);
});

test('a refuted review a later review settled does not hold done back; an undecided one does', () => {
  const refuted = { ...review('R-old', 'A'), state: 'released', results: { trigger: 'release', evaluated_at: 5, executable: true, passed: false, checks: [{ kind: 'verdict', executable: true, passed: false }] } };
  assert.ok(doneOf(snap({ tasks: [work('A'), refuted, review('R-A', 'A')] })), 'A is decided by R-A: R-old is settled');
  const open = { ...review('R-new', 'A'), state: 'assigned', results: null };
  assert.strictEqual(doneOf(snap({ tasks: [work('A'), review('R-A', 'A'), open] })), null, 'a review with no verdict yet holds it back');
});

test('should-fix findings left on a follow-up\'s own review are named in the done wake, as the work\'s are', () => {
  const sf = (id, of) => ({ ...review(id, of), results: { trigger: 'release', evaluated_at: 9, executable: true, passed: true, checks: [{ kind: 'verdict', executable: true, passed: true, detail: { verdict: 'holds', summary: 's', findings: [{ severity: 'should-fix', title: 'tidy it' }] } }] } });
  const F = work('F', { follows_up: { review_id: 'R-A', review_ids: ['R-A'], task_id: 'A', root: 'A' }, depends_on: ['A'], review: { review_id: 'R-F', state: 'holds' } });
  const tasks = [work('A'), sf('R-A', 'A'), F, sf('R-F', 'F')];
  const d = doneOf(snap({ tasks }));
  assert.ok(d, 'done');
  assert.deepStrictEqual(d.should_fix_left, ['F'], 'A\'s findings were followed up by F; F\'s own were left');
  assert.match(d.text, /Should-fix findings left on 1 task \(see its review\)\./);
});

test('a halt on a finished task does not hold the done wake back, and the wake names it; a halt on work still open does', () => {
  const E1 = [{ exception: 'E1', task_id: 'A', field: 're_review', lifted: false }];
  const d = doneOf(snap(), E1);
  assert.ok(d, 'every task is done, reviewed and merged: the halt on A holds nothing back');
  assert.match(d.text, /1 (finished task still halted by an unlifted exception|halt unlifted)\./);
  assert.ok(Buffer.byteLength(d.text) <= PW.WAKE_TEXT_MAX);
  const open = snap({ tasks: [work('A'), review('R-A', 'A'), work('B', { state: 'open' })] });
  assert.strictEqual(doneOf(open, [{ exception: 'E1', task_id: 'B', lifted: false }]), null, 'work still open: no done wake');
  assert.strictEqual(doneOf(open, E1), null, 'and a halt elsewhere does not make it done');
  assert.strictEqual(doneOf(snap(), [{ exception: 'E1', task_id: 'A', field: 'review', lifted: false }]), null, 'a missing review is work the plan never did: it holds');
  assert.strictEqual(doneOf(snap(), [{ exception: 'E8', task_id: 'A', field: 'fix', lifted: false }]), null, 'a failed step holds');
  assert.strictEqual(doneOf(snap({ steps: [{ run_id: RUN, seq: 5, step: 'integrate', outcome: 'started' }] }), E1), null, 'a step in flight still holds it back');
});
