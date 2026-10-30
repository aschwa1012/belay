'use strict';
// policy-stamp.cjs -- who took a step (ADR 0072 decisions 2, 3 and 5). A row of task, lease or integration carries `acted_by` ('policy' or
// null), the `trigger` the step acted on and the plan's `policy_rev`. Three rules, all here:
//   1. A stamp comes from one place: the open claim (policy_step row, outcome `started`, this run's) that the harness caller names in
//      `caller.policy_step`. rows.append asks `overrides` for every task, lease and integration row, so no argument and no spread of an
//      earlier row can set or carry a stamp. A write the policy step did not make is stamped null (policy_rev carried on a task, which is
//      the plan's revision there; `policy` is carried by the writers' own spread).
//   2. `caller.policy_step` exists only on the harness channel (engine.cjs validateCaller refuses it elsewhere) and is set only by
//      core-views.cjs `policyAs(seq)`, code that holds the Core object. A model's tool call cannot reach it.
//   3. A call that finds its step's effect already written does not write a second one. The orchestrator's call after a policy step answers
//      the policy step's row with `existing: true`. A policy step's call after the orchestrator's is `onOrchestratorFirst`'s: by default
//      the orchestrator's row stands, the answer carries `superseded: true`, and the executor finishes the claim `superseded` naming that row.
// The seams for tests: `setHooksForTest({ at, onOrchestratorFirst })`. `at(point, info)` is awaited at the points named in `pause`, where a
// test stalls one writer between its read and its write to force an interleaving; `onOrchestratorFirst` replaces the tie-break.

const { err } = require('./errors.cjs');

const hooks = { at: null, onOrchestratorFirst: null };
const setHooksForTest = (h) => { hooks.at = h && h.at ? h.at : null; hooks.onOrchestratorFirst = h && h.onOrchestratorFirst ? h.onOrchestratorFirst : null; };

// The record's open question (0072 Q1): when the orchestrator acted first, its row stands and the step is logged superseded. One function to
// change once the operator rules: answer `{ ...answer, superseded: true }`, or throw to refuse the step.
function orchestratorWins(E, caller, existing, answer) { return { ...answer, superseded: true }; }

// The policy step this caller acts for: the seq of its claim, or null for every other caller.
function stepOf(caller) {
  return caller && caller.channel === 'harness' && Number.isInteger(caller.policy_step) ? caller.policy_step : null;
}

function claimRow(store, caller, seq, anyOutcome = false) {
  const c = store.p('SELECT * FROM policy_step WHERE seq = ?').get(seq);
  if (!c || c.run_id !== caller.run_id) throw err('E_ARGS', `policy step ${seq} is not a claim of this run, so nothing is written for it`, { policy_step: seq });
  if (!anyOutcome && c.outcome !== 'started') throw err('E_ARGS', `policy step ${seq} is already finished (${c.outcome}); a step acts once, between its claim and its finish`, { policy_step: seq, outcome: c.outcome });
  return c;
}

// The open claim the caller names, or null when it names none. A claim that is not open is E_ARGS, and nothing has been written yet when a
// method calls this at its start.
function openClaim(E, caller) {
  const seq = stepOf(caller);
  return seq === null ? null : claimRow(E.store, caller, seq);
}

// The stamp columns of one row about to be written (rows.append). A policy write takes the claim's trigger and revision; any other write
// resets them, which is what keeps a writer that copies the current row from carrying acted_by: 'policy' onto an orchestrator's row.
function overrides(store, table, values) {
  const out = { acted_by: null, trigger: null, policy_rev: table === 'task' && values.policy_rev !== undefined ? values.policy_rev : null };
  const caller = require('./held-guard.cjs').callerNow();
  const seq = stepOf(caller);
  if (seq === null) return out;
  // The claim is checked open when the call starts (openClaim), before any effect. By the time the row is written the effect has happened, and
  // a row that records it is always written (invariant 5), so a claim finished meanwhile still stamps it.
  const c = claimRow(store, caller, seq, true);
  out.acted_by = 'policy';
  out.trigger = { table: c.trigger_table, id: c.trigger_id, seq: c.trigger_seq };
  // A task's policy_rev is the plan's revision (ADR 0071), carried from the row; the claim's revision is the step's, on lease and integration rows.
  if (table !== 'task' && c.policy_rev != null) out.policy_rev = c.policy_rev;
  return out;
}

// Whether the row `table:id` was first written by a policy step. A later version of the row (a renewed lease, an evaluated task, a lease
// released) is the writer of that version and carries no stamp, so the question is put to the version that began the row.
function byPolicy(store, table, id) {
  const first = store.p(`SELECT acted_by FROM ${table} WHERE id = ? ORDER BY seq LIMIT 1`).get(id);
  return !!first && first.acted_by === 'policy';
}

// A step's effect already stands as the row `table:id` (a task, lease or integration row). `answer` is what to return for it, `existing: true`
// in it. The orchestrator's call is answered with it. A policy step's call is answered the same when a policy step wrote the row; when the
// orchestrator did, the tie-break decides.
function duplicate(E, caller, table, id, answer) {
  if (stepOf(caller) === null || byPolicy(E.store, table, id)) return answer;
  return (hooks.onOrchestratorFirst || orchestratorWins)(E, caller, { table, id }, answer);
}

// A fault-injection point (tests only): awaited between a method's last read and its write.
async function pause(point, info) { if (hooks.at) await hooks.at(point, info); }

module.exports = { stepOf, openClaim, overrides, duplicate, byPolicy, pause, orchestratorWins, setHooksForTest };
