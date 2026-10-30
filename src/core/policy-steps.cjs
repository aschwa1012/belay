'use strict';
// policy-steps.cjs -- the policy step store (ADR 0072 decisions 2 and 3, storage only). One row per (run, trigger, step): the claim
// is the INSERT, and the table's UNIQUE key is what serializes the run's executor and the orchestrator, so a second claim of one
// trigger cannot write a second row whoever makes it and however the two interleave. The executor that acts on a claim lives in
// src/run; this module only records.
//   policy.claim   { task_id?, step, trigger: { table, id, seq? }, policy_rev?, worker_id?, turn? } -> { row, existing }
//   policy.finish  { seq, outcome, row_ref? | error? }                                              -> { row }
//   policy.list    { run_id?, since_seq?, limit? }                                                  -> { rows, last_seq }
// claim and finish are the harness channel's (the run manager's executor), never a tool call; list is a read. The run is the
// caller's own, never an argument (invariant 3). A claim opens at outcome `started`; finish moves it once, to one of OUTCOMES, and
// names what the step wrote (`row_ref`) or why it did not (`error`): no step is a success without an effect (invariant 5).
// This is the one orchestration table that is updated: its UNIQUE key allows one row per trigger, so the row is the claim and
// finish is its single UPDATE (guarded by `outcome = 'started'`, so a second finish changes nothing and is refused).

const { err } = require('./errors.cjs');

const OUTCOMES = ['done', 'exception', 'superseded', 'skipped'];
const NEEDS_REF = new Set(['done', 'superseded']); // the row the step (or the orchestrator, when it acted first) wrote
const NEEDS_WHY = new Set(['exception', 'skipped']);
const STEP_RE = /^[a-z][a-z_]{0,31}$/;
const TEXT_MAX = 1000;
const LIST_DEFAULT = 500;
const LIST_MAX = 2000;

// Fault injection (tests only): awaited after a claim has been validated and before its INSERT, so a test can stall one claimant while
// another claims the same trigger. The INSERT's UNIQUE key, not any check made before it, is what the tests prove.
const hooks = { beforeInsert: null };
const setHooksForTest = (h) => { hooks.beforeInsert = h && h.beforeInsert ? h.beforeInsert : null; };

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isInt = (v) => Number.isInteger(v);

function harnessOnly(caller, method) {
  if (caller.channel !== 'harness') throw err('E_ROLE', `${method} is the run manager's: a policy step is claimed and finished by belay, never by a tool call`, { role: caller.role, channel: caller.channel || 'tool' });
}

function unknownFields(a, allowed, method) {
  for (const k of Object.keys(a)) if (!allowed.includes(k)) throw err('E_ARGS', `${method}: ${k} is not an argument`, { field: k });
}

const byKey = (E, run_id, t, step) => E.store.p('SELECT * FROM policy_step WHERE run_id = ? AND trigger_table = ? AND trigger_id = ? AND trigger_seq = ? AND step = ?').get(run_id, t.table, t.id, t.seq, step);

async function claim(E, caller, args) {
  harnessOnly(caller, 'policy.claim');
  const a = args || {};
  unknownFields(a, ['task_id', 'step', 'trigger', 'policy_rev', 'worker_id', 'turn', 'caller'], 'policy.claim');
  if (typeof a.step !== 'string' || !STEP_RE.test(a.step)) throw err('E_ARGS', 'policy.claim needs a step name (lower-case letters and underscores)', { field: 'step' });
  const t = a.trigger;
  if (!t || typeof t !== 'object' || !isStr(t.table) || !isStr(t.id) || (t.seq !== undefined && !isInt(t.seq))) throw err('E_ARGS', 'policy.claim needs trigger: { table, id, seq? }, the store row that is the fact the step acts on', { field: 'trigger' });
  for (const k of ['task_id', 'worker_id']) if (a[k] !== undefined && a[k] !== null && !isStr(a[k])) throw err('E_ARGS', `policy.claim ${k} must be a non-empty string`, { field: k });
  for (const k of ['policy_rev', 'turn']) if (a[k] !== undefined && a[k] !== null && !isInt(a[k])) throw err('E_ARGS', `policy.claim ${k} must be an integer`, { field: k });
  const trig = { table: t.table, id: t.id, seq: t.seq === undefined ? 0 : t.seq };
  const run_id = caller.run_id;
  if (hooks.beforeInsert) await hooks.beforeInsert({ run_id, step: a.step, trigger: trig });
  return E.store.tx(() => {
    const info = E.store.p('INSERT OR IGNORE INTO policy_step(run_id, task_id, step, trigger_table, trigger_id, trigger_seq, policy_rev, outcome, worker_id, turn, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run_id, a.task_id || null, a.step, trig.table, trig.id, trig.seq, a.policy_rev === undefined ? null : a.policy_rev, 'started', a.worker_id || null, a.turn === undefined ? null : a.turn, Date.now());
    const existing = Number(info.changes) === 0;
    const row = existing ? byKey(E, run_id, trig, a.step) : E.store.p('SELECT * FROM policy_step WHERE seq = ?').get(Number(info.lastInsertRowid));
    if (!row) throw err('E_INTERNAL', 'policy.claim wrote no row and found none for its trigger', { run_id, step: a.step, trigger: trig });
    if (!existing) E.noteWrite();
    return { row, existing };
  });
}

async function finish(E, caller, args) {
  harnessOnly(caller, 'policy.finish');
  const a = args || {};
  unknownFields(a, ['seq', 'outcome', 'row_ref', 'error', 'caller'], 'policy.finish');
  if (!isInt(a.seq) || a.seq <= 0) throw err('E_ARGS', 'policy.finish needs the seq of the claim it finishes', { field: 'seq' });
  if (!OUTCOMES.includes(a.outcome)) throw err('E_ARGS', `policy.finish outcome must be one of ${OUTCOMES.join(', ')}`, { field: 'outcome' });
  if (NEEDS_REF.has(a.outcome) && !isStr(a.row_ref)) throw err('E_ARGS', `a step finished ${a.outcome} must name the row it wrote (row_ref)`, { field: 'row_ref' });
  if (NEEDS_WHY.has(a.outcome) && !isStr(a.error)) throw err('E_ARGS', `a step finished ${a.outcome} must say why (error)`, { field: 'error' });
  for (const k of ['row_ref', 'error']) if (a[k] !== undefined && a[k] !== null && (typeof a[k] !== 'string' || a[k].length > TEXT_MAX)) throw err('E_ARGS', `policy.finish ${k} must be a string of at most ${TEXT_MAX} characters`, { field: k });
  return E.store.tx(() => {
    const cur = E.store.p('SELECT * FROM policy_step WHERE seq = ?').get(a.seq);
    if (!cur || cur.run_id !== caller.run_id) throw err('E_NOT_FOUND', `no policy step ${a.seq} in this run`, { seq: a.seq });
    if (cur.outcome !== 'started') throw err('E_BUSY', `policy step ${a.seq} is already finished (${cur.outcome}); a step is finished once`, { seq: a.seq, outcome: cur.outcome, reason: 'already_finished' });
    const info = E.store.p("UPDATE policy_step SET outcome = ?, row_ref = ?, error = ?, finished_at = ? WHERE seq = ? AND outcome = 'started'")
      .run(a.outcome, a.row_ref || null, a.error || null, Date.now(), a.seq);
    if (Number(info.changes) !== 1) throw err('E_INTERNAL', `policy step ${a.seq} was not changed`, { seq: a.seq });
    E.noteWrite();
    return { row: E.store.p('SELECT * FROM policy_step WHERE seq = ?').get(a.seq) };
  });
}

// A read: the run's steps in claim order after `since_seq`. A store from before the table answers empty.
async function list(E, caller, args) {
  const a = args || {};
  unknownFields(a, ['run_id', 'since_seq', 'limit', 'caller'], 'policy.list');
  if (a.run_id !== undefined && !isStr(a.run_id)) throw err('E_ARGS', 'policy.list run_id must be a non-empty string', { field: 'run_id' });
  if (a.since_seq !== undefined && (!isInt(a.since_seq) || a.since_seq < 0)) throw err('E_ARGS', 'policy.list since_seq must be a non-negative integer', { field: 'since_seq' });
  if (a.limit !== undefined && (!isInt(a.limit) || a.limit < 1 || a.limit > LIST_MAX)) throw err('E_ARGS', `policy.list limit must be 1 to ${LIST_MAX}`, { field: 'limit' });
  const run_id = a.run_id || caller.run_id;
  let rows = [];
  try { rows = E.store.p('SELECT * FROM policy_step WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(run_id, a.since_seq || 0, a.limit || LIST_DEFAULT); }
  catch (e) { if (!/no such table/i.test(e.message)) throw e; }
  return { rows, last_seq: rows.length ? rows[rows.length - 1].seq : (a.since_seq || 0) };
}

module.exports = { claim, finish, list, OUTCOMES, setHooksForTest };
