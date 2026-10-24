'use strict';
// methods-memory-note-report.cjs — memory.noteReport: the operator's (and, on the operator's word, the orchestrator's) report that a note is wrong
// (ADR 0047 amendment of 2026-10-21). It is a worker's `reported_wrong` entry made by another hand: the report is marked on the note and the note is held
// for the archive review by `holdReported`, the one function a worker's release uses, in ONE transaction, with the same ground (`reported`), the same
// harness channel for the hold row and the same one-report-per-reporter rule (a repeat replaces that reporter's report).
//   Who: the explicit operator (`belay memory report`) and the orchestrator (the `memory_report` tool). Never a worker: workers report in their
//        hand-back. Never the harness channel (the run's close stages).
//   Identity: from the caller only (invariant 3). The operator is `operator`, the orchestrator is `orchestrator`; the operator's checked peer pid
//        (`peer_pid`, set by the owner's check, never read from a request) is kept on the report as `operator_pid`, for the record only. Nothing in the arguments names a reporter.
//   Proof (invariant 5): the report as written, the hold row (id, kind, rev) or `not_held` with the reason, and the rows as stored.

const { err } = require('./errors.cjs');
const C = require('./lifecycle-common.cjs');
const HG = require('./held-guard.cjs');
const NT = require('./memory-notes.cjs');
const M = require('./methods-memory.cjs');
const N = require('./methods-memory-notes.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');
const { loadNote } = require('./memory-facts.cjs');
const { validId } = require('./memory-rows.cjs');
const { redact } = require('./redact.cjs');

const WHY_MAX = 500;

// Who is reporting: the role of the checked caller, nothing else, so one operator is one reporter. Returns null when the caller may not report.
function reporterOf(caller) {
  if (HG.explicitOperator(caller)) return 'operator';
  if (caller && caller.role === 'orchestrator' && caller.channel !== 'harness') return 'orchestrator';
  return null;
}

async function noteReport(E, caller, args) {
  C.allowKeys(args || {}, ['note_id', 'why', 'replaced_by'], 'memory.noteReport');
  const by = reporterOf(caller);
  if (!by) throw err('E_ROLE', 'memory.noteReport is the operator\'s command (belay memory report) and the orchestrator\'s tool (memory_report); a worker reports in its hand-back, and the run\'s close stages report nothing', { role: caller && caller.role, channel: (caller && caller.channel) || 'tool' });
  return reportNote(E, caller, by, args, null);
}

// The body of a report, for a reporter already identified (`by`: from reporterOf, never from an argument). `cites` is the receipt a status route carries.
async function reportNote(E, caller, by, args, cites) {
  if (!validId(args.note_id)) throw err('E_ARGS', 'memory.noteReport needs note_id, the id of a live note', { field: 'note_id' });
  if (typeof args.why !== 'string' || !args.why.trim() || Buffer.byteLength(args.why, 'utf8') > WHY_MAX) throw err('E_ARGS', `memory.noteReport needs why: a non-empty reason of at most ${WHY_MAX} bytes`, { field: 'why' });
  const rb = args.replaced_by === undefined || args.replaced_by === null ? null : args.replaced_by;
  if (rb !== null && (!validId(rb) || rb === args.note_id)) throw err('E_ARGS', 'memory.noteReport replaced_by must be the id of another note', { field: 'replaced_by' });
  const red = redact(NT.oneLine(args.why));
  const why = red.text;

  // The project is the note's own (a project is never derived from a folder or a cwd). An orchestrator reports only on its own run's project.
  const first = loadNote(E, args.note_id);
  const missing = () => err('E_NOT_FOUND', `note ${args.note_id} is not a live note: ${first ? `it is a ${first.type} in ${first.namespace}` : 'there is no such row'} (reason: not_live)`, { id: args.note_id, reason: 'not_live', state: first ? String(first.namespace).split('/')[0] : 'missing' });
  if (first && first.type !== 'note') throw err('E_ARGS', `row ${args.note_id} is a ${first.type}: not a note, and only a note can be reported`, { field: 'note_id', type: first.type });
  if (!first || !first.namespace.startsWith('project/')) throw missing();
  const project = first.namespace.slice('project/'.length);
  let threshold = DEFAULTS.notes_match_threshold;
  if (by === 'orchestrator') {
    const lv = N.notesLevers(E, caller);
    if (!lv) throw err('E_LEVER_OFF', 'memory.noteReport needs the run\'s memory.notes lever, and this run has it off', { lever: 'notes' });
    if (M.projectOf(E, caller) !== project) throw err('E_ROLE', `note ${first.id} belongs to project ${project}, not this run's`, { id: first.id, role: caller.role });
    threshold = lv.notes_match_threshold;
  }

  const { reportIn } = require('./note-report-in.cjs');
  const out = E.store.tx(() => {
    // Read again inside the transaction: the note may have left the project since the first look.
    const live = loadNote(E, args.note_id);
    if (!live || live.type !== 'note' || live.namespace !== N.projectNs(project)) throw missing();
    return reportIn(E, caller, { note: live.id, project, by, run_id: caller.run_id || null, why, replaced_by: rb, cites, threshold, headSha: null, extra: by === 'operator' && Number.isInteger(caller.peer_pid) ? { operator_pid: caller.peer_pid } : null });
  });
  E.noteWrite();
  const { report, held } = out;
  const proof = held.skipped
    ? { state: 'not_held', reason: held.skipped }
    : { state: held.already_held ? 'already_held' : 'held', hold: { row: held.row, kind: held.kind, rev: held.rev, ...(held.merged ? { merged: held.merged } : {}), ...(held.reclassified ? { reclassified: true } : {}) } };
  return {
    id: args.note_id, project, reported_by: by, ...proof, withheld: out.withheld, withheld_why: out.withheld_why, ...(out.breaker ? { breaker: out.breaker } : {}),
    report: { by: report.by, seq: report.seq, at: report.at, why: report.why, replaced_by: report.replaced_by },
    reports: out.reports, ...(red.redactions && Object.keys(red.redactions).length ? { redacted: Object.values(red.redactions).reduce((a, b) => a + b, 0) } : {}),
    ...(held.skipped ? {} : { held: C.rowOut(E, held.row) }), row: C.rowOut(E, args.note_id),
  };
}

// ADR 0047 amendment (2026-10-22), decision 5: the orchestrator's `refuted` on a note is a report with the receipt as its reason and cite. The status is
// left as it was. `receipt` has passed the receipt checks of memory.setStatus. Returns the answer setStatus gives.
async function reportByStatus(E, caller, id, receipt) {
  let why = redact(NT.oneLine(String(receipt))).text;
  while (Buffer.byteLength(why, 'utf8') > WHY_MAX) why = why.slice(0, -1);
  const out = await reportNote(E, caller, 'orchestrator', { note_id: id, why }, [receipt]);
  const row = out.row;
  return {
    id, status: row.status, receipt: row.status_receipt || null, reported: { seq: out.report.seq }, reported_by: out.reported_by, state: out.state, withheld: out.withheld, withheld_why: out.withheld_why,
    ...(out.state === 'not_held' ? { reason: out.reason } : { hold: out.hold }), reports: out.reports, project: out.project,
  };
}

module.exports = { noteReport, reporterOf, reportByStatus };
