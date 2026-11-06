'use strict';
require('../helpers/tmp.cjs');
// stall-wake-plan-first.test.cjs — the stalled wake under plan-first (ADR 0074 amendment 3), where belay itself dispatches a planned task by a
// `build` step. The plan-first due() lists a build for an open, ready planned task until a build claim for that task is in the steps it is
// given (done, started or superseded); without the steps it lists it still. A task a build step took whose builder then died is open again,
// and belay neither halts nor respawns it: it is the orchestrator's, so the stalled wake must name it, not count it as carried by the plan.
// The plan-first due() is not on this branch, so its contract is modelled here over the real one, installed before stall-wake.cjs loads.

const test = require('node:test');
const assert = require('node:assert');

const PE = require('../../src/run/policy-exec.cjs');
const realDue = PE.due;
const TAKEN = new Set(['done', 'started', 'superseded']);
PE.due = (snap) => {
  const tasks = snap.tasks || [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const took = new Set((snap.steps || []).filter((s) => s.step === 'build' && TAKEN.has(s.outcome)).map((s) => s.task_id));
  const builds = tasks.filter((t) => t.run_id === snap.runId && t.state === 'open' && t.policy && !took.has(t.id)
    && (t.depends_on || []).every((d) => byId.get(d) && byId.get(d).state === 'done'))
    .map((t) => ({ step: 'build', task_id: t.id, trigger: { table: 'task', id: t.id, seq: t.seq } }));
  return realDue(snap).concat(builds);
};
const { createStallWatcher, untaken } = require('../../src/run/stall-wake.cjs');

const RUN = 'r1';
const PLAN = { build: { spawn: { worker_id: 'coder' } }, fix: 'builder', integrate: 'on_hold' };
const task = (o) => ({ seq: 1, run_id: RUN, state: 'open', policy: PLAN, depends_on: [], repairs: null, lease: null, review: null, integration: null, handoff: null, results: null, written_at: 1, ...o });
const released = (by) => ({ handoff: { by, at: 10 }, results: { trigger: 'release', evaluated_at: 20, executable: true, passed: true, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: true, exit_code: 0 }] } });
const tasks = () => [
  task({ id: 't-done', state: 'done', seq: 5, ...released('coder-a') }),
  task({ id: 't-orphan', seq: 7 }), // a build step took it; its builder died and the lease went back: open again
  task({ id: 't-queued', seq: 8 }), // no build taken yet: the plan carries it
];
const buildTook = { seq: 3, run_id: RUN, step: 'build', task_id: 't-orphan', outcome: 'done', trigger_table: 'task', trigger_id: 't-orphan', trigger_seq: 2, finished_at: 900 };

test('plan-first: a task a build step took, whose builder died, is named by the stalled wake; one the plan still carries is not', () => {
  const snap = { runId: RUN, tasks: tasks(), integrations: [], steps: [buildTook] };
  assert.deepStrictEqual(untaken(snap), ['t-orphan']);
  const w = createStallWatcher({ core: null, runId: RUN });
  const [ev] = w.poll({ absorbed: [{ worker_id: 'coder-a', task_ids: ['t-done'] }], pending: new Map() }, snap);
  assert.ok(ev, 'a wake after the hand-back');
  assert.deepStrictEqual(ev.task_ids, ['t-orphan']);
  assert.match(ev.text, /no policy step due: t-orphan\.$/);
});

test('plan-first: with no build taken, every open ready planned task is carried by the plan, and no wake is sent', () => {
  const snap = { runId: RUN, tasks: tasks(), integrations: [], steps: [] };
  assert.deepStrictEqual(untaken(snap), []);
  assert.deepStrictEqual(createStallWatcher({ core: null, runId: RUN }).poll({ absorbed: [{ worker_id: 'coder-a', task_ids: ['t-done'] }], pending: new Map() }, snap), []);
});
