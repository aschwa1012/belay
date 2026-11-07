'use strict';
require('../helpers/tmp.cjs');
// stall-wake-red.test.cjs — a red branch withholds every other integrate in due() (policy-rounds.cjs redOf) while the plan carries its fix
// round. A work held that way is the plan's, so a task depending on it is not "no policy step due" on each absorbed hand-back.

const test = require('node:test');
const assert = require('node:assert');
const { due } = require('../../src/run/policy-exec.cjs');
const { untaken } = require('../../src/run/stall-wake.cjs');

const T = (id, over = {}) => ({ id, seq: 100, run_id: 'r1', state: 'open', policy: null, policy_rev: null, depends_on: [], repairs: null, results: null, handoff: null, lease: null, review: null, integration: null, written_at: 50, ...over });
const PLAN = { build: { worker: 'b1' }, review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const rel = (at) => ({ trigger: 'release', evaluated_at: at, executable: true, passed: true, checks: [] });

// X merged and its checks failed (red), its fix F1 is open. B is held, reviewed and not merged. C depends on B and is open.
function rows() {
  const i1 = { id: 'i1', run_id: 'r1', seq: 30, state: 'evaluated', into_branch: 'belay/integrate/r1', acted_by: 'policy', passed: false, task_ids: ['X'], checks: [{ argv: ['npm', 'test'], task_ids: ['X'], passed: false, exit_code: 1 }] };
  const X = T('X', { seq: 5, state: 'done', policy: PLAN, policy_rev: 1, handoff: { by: 'bx', at: 1 }, results: rel(2), review: { state: 'holds', review_id: 'RX' }, integration: { state: 'merged', id: 'i1', passed: false } });
  const RX = T('RX', { seq: 6, state: 'done', acceptance: { verdict: true }, depends_on: ['X'], handoff: { by: 'rv', at: 3 }, results: rel(4) });
  const B = T('B', { seq: 7, state: 'done', policy: PLAN, policy_rev: 1, handoff: { by: 'bw', at: 1 }, results: rel(2), review: { state: 'holds', review_id: 'RB' }, integration: { state: 'not_merged', into: null } });
  const RB = T('RB', { seq: 8, state: 'done', acceptance: { verdict: true }, depends_on: ['B'], handoff: { by: 'rv', at: 3 }, results: rel(4) });
  const F1 = T('F1', { seq: 40, state: 'assigned', repairs: 'X', depends_on: ['X'] });
  const C = T('C', { seq: 50, policy: PLAN, policy_rev: 1, depends_on: ['B'] });
  const steps = [{ seq: 50, run_id: 'r1', step: 'fix_checks', task_id: 'X', outcome: 'done', row_ref: 'task:F1', trigger_table: 'integration', trigger_id: 'i1', trigger_seq: 30, at: 35 }];
  return { runId: 'r1', tasks: [X, RX, B, RB, F1, C], integrations: [i1], steps, roundSteps: steps, failures: [], rounds: { caps: { max: 2, hard: null } } };
}

test('a work the red hold withholds is carried: the task depending on it is not named while the fix round runs', () => {
  const snap = rows();
  assert.deepStrictEqual(due(snap).filter((c) => c.step === 'integrate'), [], 'due() withholds B behind the red');
  assert.deepStrictEqual(untaken(snap), [], 'the plan carries B to its merge, so C is not free');
});

test('with the red gone (the fix cancelled) nothing carries B and C is named only if B is not due either', () => {
  const snap = rows();
  snap.tasks.find((t) => t.id === 'F1').state = 'cancelled';
  assert.deepStrictEqual(due(snap).filter((c) => c.step === 'integrate').map((c) => c.task_id), ['B'], 'the hold is released: B is due again');
  assert.deepStrictEqual(untaken(snap), [], 'B is due, so it is carried the ordinary way');
});

test('at the fix cap nothing is at work on the red: what waits behind the held work is named again', () => {
  const snap = rows();
  snap.tasks = snap.tasks.filter((t) => t.id !== 'F1'); snap.steps = []; snap.roundSteps = [];
  snap.rounds = { caps: { max: 0, hard: null } };
  assert.deepStrictEqual(due(snap), [], 'at the cap the plan takes no step (E2 is raised)');
  assert.deepStrictEqual(untaken(snap), ['C'], 'the safety net names C: nobody is carrying B');
});

test('a work held for its commit fix whose fix was cancelled carries nothing: its dependent is named', () => {
  const rel2 = rel(2);
  const W = T('W', { seq: 5, state: 'done', policy: PLAN, policy_rev: 1, handoff: { by: 'bw', at: 1 }, results: { ...rel2, uncommitted: true, uncommitted_paths: ['a.txt'] }, review: { state: 'holds', review_id: 'RW' }, integration: { state: 'not_merged', into: null } });
  const F = T('F', { seq: 9, state: 'cancelled', repairs: 'W', depends_on: ['W'] });
  const RW = T('RW', { seq: 8, state: 'done', acceptance: { verdict: true }, depends_on: ['W'], handoff: { by: 'rv', at: 3 }, results: rel(4) });
  const D = T('D', { seq: 50, policy: PLAN, policy_rev: 1, depends_on: ['W'] });
  const steps = [{ seq: 1, run_id: 'r1', step: 'fix_commit', task_id: 'W', outcome: 'done', row_ref: 'task:F', trigger_table: 'task', trigger_id: 'W', trigger_seq: 5, at: 6 }];
  const snap = { runId: 'r1', tasks: [W, RW, F, D], integrations: [], steps, roundSteps: steps, failures: [], rounds: { caps: { max: 2, hard: null } } };
  const held = require('../../src/run/policy-rounds.cjs');
  const rf = held.ctxOf({ runId: 'r1', tasks: snap.tasks, steps, failures: [], caps: snap.rounds.caps, integrations: [] });
  assert.ok(held.commitHeld(W, rf), 'W is held for its commit fix');
  assert.ok(untaken(snap).includes('D'), 'nothing is at work on the commit hold: D is named');
});

test('an open fix on an unrelated task does not silence a red X at the cap: C is still named', () => {
  const snap = rows();
  snap.tasks = snap.tasks.filter((t) => t.id !== 'F1'); snap.steps = []; snap.roundSteps = [];
  snap.rounds = { caps: { max: 0, hard: null } };
  const U = T('U', { seq: 60, state: 'done', policy: PLAN, policy_rev: 1, handoff: { by: 'bu', at: 1 }, results: rel(2), review: { state: 'refuted', review_id: 'RU' } });
  snap.tasks.push(U, T('FU', { seq: 61, state: 'assigned', repairs: 'U', depends_on: ['U'] }));
  assert.deepStrictEqual(untaken(snap), ['C'], 'the fix of U carries U, not the hold on X');
});
