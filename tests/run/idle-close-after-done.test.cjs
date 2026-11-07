'use strict';
require('../helpers/tmp.cjs');
// idle-close-after-done.test.cjs — once the done wake has gone and the rows still read done, the idle close tells the orchestrator nothing more
// about trees that are only off their branch: that would be one more model turn at full context for a finished run. A tree with uncommitted work is
// still told, and without a done wake the pre-close notice goes as before. `doneCurrent` is tested on the real watcher.

const test = require('node:test');
const assert = require('node:assert');
const { idleClose } = require('../../src/run/orchestrator-idle-close.cjs');
const { createPreCloseNotice } = require('../../src/run/pre-close-wake.cjs');
const PW = require('../../src/run/policy-wakes.cjs');

const RUN = 'r1';
const PLAN = { build: { worker: 'b1' }, review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const work = (id, over = {}) => ({ id, seq: 10, run_id: RUN, state: 'done', policy: PLAN, policy_rev: 1, depends_on: [], repairs: null, lease: null, acceptance: { commands: [] }, review: { review_id: `R-${id}`, state: 'holds' }, integration: { state: 'merged' }, results: { trigger: 'release', executable: true, passed: true, checks: [] }, ...over });
const review = (id, of) => ({ id, seq: 11, run_id: RUN, state: 'done', policy: null, depends_on: [of], repairs: null, lease: null, acceptance: { verdict: true }, results: { trigger: 'release', executable: true, passed: true, checks: [{ kind: 'verdict', executable: true, passed: true }] }, handoff: { by: 'rv' } });
const merged = (over = {}) => ({ id: 'i1', seq: 20, run_id: RUN, state: 'merged', passed: true, into_branch: `belay/integrate/${RUN}`, head_sha: '0123456789abcdef', ...over });
const snap = (over = {}) => ({ runId: RUN, tasks: [work('A'), review('R-A', 'A'), work('B'), review('R-B', 'B')], integrations: [merged()], steps: [], ...over });

const offBranch = { path: 'C:/wt/a', reason: 'head_off_branch', detail: 'HEAD is main, not its branch', task_ids: ['A'] };
const dirty = { path: 'C:/wt/b', reason: 'dirty', paths: ['x.txt'], task_ids: ['B'] };
const sweepCore = (kept) => ({ task: { worktreeSweep: async () => ({ kept }) } });

test('doneCurrent: false before the done wake, true once it went and the rows still read done, false after anything moved', async () => {
  let s = snap();
  const core = { task: { list: async () => ({ tasks: s.tasks }) }, integration: { list: async () => ({ integrations: s.integrations }) }, policy: { list: async () => ({ rows: s.steps, last_seq: 0 }) }, memory: { events: async () => ({ events: [] }) } };
  const w = PW.createPolicyWatcher({ core, runId: RUN, enabled: true });
  assert.strictEqual(w.doneCurrent(), false, 'before any poll');
  const out = await w.poll({});
  assert.ok(out.some((e) => e.event === 'policy_done'), 'the done wake went');
  assert.strictEqual(w.doneCurrent(), true);
  s = snap({ tasks: [...s.tasks, { ...work('C'), state: 'open', integration: null, review: null }] });
  await w.poll({});
  assert.strictEqual(w.doneCurrent(), false, 'a task moved: not done any more');
});

test('after the done wake the pre-close check says nothing for trees only off their branch, and still tells of uncommitted work', async () => {
  assert.strictEqual((await createPreCloseNotice({ core: sweepCore([offBranch]), runId: RUN }).check({ afterDone: true })).wake, null);
  assert.strictEqual((await createPreCloseNotice({ core: sweepCore([]), runId: RUN }).check({ afterDone: true })).wake, null);
  const mixed = await createPreCloseNotice({ core: sweepCore([offBranch, dirty]), runId: RUN }).check({ afterDone: true });
  assert.strictEqual(mixed.wake && mixed.wake.event, 'pre_close', 'one tree has uncommitted work');
  const before = await createPreCloseNotice({ core: sweepCore([offBranch]), runId: RUN }).check({ afterDone: false });
  assert.strictEqual(before.wake && before.wake.event, 'pre_close', 'without a done wake it goes as before');
});

test('the idle close hands the pre-close check whether the done wake is current', async () => {
  const seen = [];
  const mk = (cur) => ({
    state: { pendingWrites: [], idle: true }, rows: [], runId: RUN, pending_deaths: [], turnAtCall: 1, hold: { isPaused: () => false }, awaitingWakeIds: () => [],
    callWatcher: { holds: () => [] }, recordHold() {}, writeWake() {}, closeThenKillOnDeadline() {},
    preClose: { check: async (o) => { seen.push(o.afterDone); return { ran: true, wake: null }; } },
    policyWatcher: { snapshot: () => null, active: () => [], doneCurrent: () => cur },
  });
  await idleClose(mk(true)); await idleClose(mk(false));
  assert.deepStrictEqual(seen, [true, false]);
});
