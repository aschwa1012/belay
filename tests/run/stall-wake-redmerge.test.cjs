'use strict';
require('../helpers/tmp.cjs');
// stall-wake-redmerge.test.cjs — a dependency merged with failed checks is not landed: the executor's build gate waits for its re-merge, so the stalled wake must
// not name the task waiting behind it (policy-carried.cjs reads the same mergedOk as the gate).

const test = require('node:test');
const assert = require('node:assert');
const { due } = require('../../src/run/policy-exec.cjs');
const { untaken } = require('../../src/run/stall-wake.cjs');

const T = (id, over = {}) => ({ id, seq: 100, run_id: 'r1', state: 'open', policy: null, policy_rev: null, depends_on: [], repairs: null, results: null, handoff: null, lease: null, review: null, integration: null, written_at: 1, ...over });
const PLAN = { build: { worker: 'b1' }, review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const rel = (at) => ({ trigger: 'release', evaluated_at: at, executable: true, passed: true, checks: [] });

function rows(passed) {
  const X = T('X', { seq: 5, state: 'done', policy: PLAN, policy_rev: 1, handoff: { by: 'bx', at: 1 }, results: rel(2), review: { state: 'holds', review_id: 'RX' }, integration: { state: 'merged', id: 'i1', passed } });
  const RX = T('RX', { seq: 6, state: 'done', acceptance: { verdict: true }, depends_on: ['X'], handoff: { by: 'rv', at: 3 }, results: rel(4) });
  const C = T('C', { seq: 50, policy: PLAN, policy_rev: 1, depends_on: ['X'] });
  const i1 = { id: 'i1', run_id: 'r1', seq: 30, state: 'evaluated', into_branch: 'belay/integrate/r1', acted_by: 'policy', passed, task_ids: ['X'], checks: [] };
  const steps = [{ seq: 60, run_id: 'r1', step: 'integrate', task_id: 'X', outcome: 'started', trigger_table: 'task', trigger_id: 'X', trigger_seq: 5, at: 40 }];
  return { runId: 'r1', tasks: [X, RX, C], integrations: [i1], steps, roundSteps: steps, failures: [], rounds: { caps: { max: 2, hard: null } } };
}

test('a dependency merged with failed checks and being re-merged is not landed: its dependent is not named stalled', () => {
  const snap = rows(false);
  assert.deepStrictEqual(due(snap).filter((c) => c.task_id === 'C'), [], 'the build gate waits for the re-merge');
  assert.deepStrictEqual(untaken(snap), [], 'the plan is carrying C behind X, so the wake names nothing');
});

test('a dependency merged green is landed: a dependent nothing carries is named', () => {
  const snap = rows(true);
  snap.steps = []; snap.roundSteps = [];
  assert.deepStrictEqual(due(snap).filter((c) => c.task_id === 'C').map((c) => c.step), ['build']);
  assert.deepStrictEqual(untaken(snap), [], 'C is due, so the plan carries it the ordinary way');
});
