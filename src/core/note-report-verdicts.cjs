'use strict';
// note-report-verdicts.cjs — a worker's report that a note is WRONG, judged by the task's reviewer. The note is already held for the archive
// review from the moment of the report (memory-report-hold.cjs); the reviewer's verdict is ADVICE recorded on that hold, per report, with its cites:
//   reportsAbout(E, taskIds, project)   a read: the open reports the tasks made about OTHER notes, for a reviewer's brief (each with its key)
//   unjudgedReports(E, project)         a read: reports no verdict has been applied to and no hold covers, for the operator (notices)
//   applyReportVerdicts(...)            the write: `report_verdicts: [{ id, report?, verdict: upheld|rejected, cites, reason }]`
// An upheld or rejected verdict is a `note_review` receipt keyed `<review>:report:<note id>:<report key>`, an entry in the hold's `report_verdicts`
// (which raises its revision) and a mark on the note (`report_judgments`, and `report_rejected` for a rejection). Neither archives or releases the
// note: the archive reviewer reads the verdict with the report and decides. A report is addressed by its key (report-marks.cjs), so a note that two
// reviewed tasks reported takes two verdicts, and a legacy report with no sequence number is addressed like any other. The same citation check and
// independence rule as a note verdict: a reviewer never judges a report about a note it wrote, or one it made or whose task it worked.
// A self-report (the writer reporting its own note) is listed and judged by an independent reviewer like any other.
// An upheld verdict on a note with no active hold (older data) writes the hold, with the verdict on it.

const path = require('node:path');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { validId } = require('./memory-rows.cjs');
const ENDED_TASK = new Set(['done', 'released', 'cancelled']); // a task whose reports may be judged; cancelled: ADR 0058
const CC = require('./memory-citations.cjs');
const C = require('./lifecycle-common.cjs');
const N = require('./methods-memory-notes.cjs');
const { loadNote, activeHoldOf, activeHoldsOf } = require('./memory-facts.cjs');
const RM = require('./report-marks.cjs');
const RH = require('./memory-report-hold.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');
const { heldLeaseOn } = require('./verdict.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');

const VERDICTS = ['upheld', 'rejected'];
const REASON_MAX = 500;
const KEY_MAX = 300;
const REPORTS_MAX = 8;          // reports shown to one reviewer (the hand-back is 4,096 bytes)
const JUDGMENTS_KEEP = 20;
const REJECTED_KEEP = 10;
const VERDICTS_KEEP = 20;       // verdicts kept on a hold
const REPORT_GROUNDS = ['reported', 'report_confirmed'];
const bad = (message, detail) => err('E_ARGS', message, detail);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const parse = (t) => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } };

const judged = (b, w) => (b.report_judgments || []).some((j) => j && RM.sameReport(j, w));
const isReportHold = (h) => !!h && REPORT_GROUNDS.includes(h.b.ground);

// The head commit a worker of the task recorded.
function headOf(E, taskId) {
  const w = rows.currentAll(E.store, 'worker').find((x) => x.task_id === taskId && x.head_sha);
  return w ? w.head_sha : null;
}

// The open reports (not judged, not settled, on a live non-refuted note of the project that is not held for another reason) that these tasks made.
// One entry per (note, report). A writer's report on its own note is included.
function openReports(E, taskIds, project) {
  if (!taskIds.length || !project) return [];
  const marks = taskIds.map(() => '?').join(', ');
  const found = E.store.p(`SELECT id, title, text, namespace, written_by, task_id, status, body FROM memory_entries WHERE type = 'note' AND namespace = ?
    AND EXISTS (SELECT 1 FROM json_each(memory_entries.body, '$.reported_wrong') WHERE json_extract(value, '$.task_id') IN (${marks})) ORDER BY created_at, id LIMIT 200`).all(`project/${project}`, ...taskIds);
  const holds = activeHoldsOf(E, project);
  const out = [];
  for (const n of found) {
    const b = parse(n.body);
    if ((n.status || 'unverified') === 'refuted') continue;
    const hold = holds.get(n.id) || null;
    if (hold && !isReportHold(hold)) continue; // held for another reason: that hold has its own review
    for (const w of b.reported_wrong || []) {
      if (!w || !taskIds.includes(w.task_id) || RM.isSettled(b, w) || judged(b, w)) continue;
      out.push({ n, b, w, hold });
    }
  }
  return out;
}

// For a reviewer's brief: each reported note's row facts, the report with its key, the hold it is on, and the reporter task's head sha.
function reportsAbout(E, taskIds, project) {
  return openReports(E, taskIds, project).slice(0, REPORTS_MAX).map(({ n, b, w, hold }) => ({
    note: { id: n.id, title: n.title, kind: b.kind || null, basis: b.basis || null, task_id: n.task_id, written_by: n.written_by, status: n.status || 'unverified', evidence: Array.isArray(b.evidence) ? b.evidence.slice(0, 1) : [] },
    report: { key: RM.reportKey(w), task_id: w.task_id, by: w.by, why: w.why, replaced_by: w.replaced_by || null, at: w.at, ...(w.by === n.written_by ? { self_report: true } : {}) },
    held: hold ? { row: hold.id, kind: hold.b.kind } : null,
    head_sha: headOf(E, w.task_id),
  }));
}

// Reports nobody has judged and no hold covers: the reporter's task has ended and the note carries no judgment for the report. A note with an active
// hold of ground reported (or the older report_confirmed) is not listed: its reports wait on the archive review, which is counted as a hold. A note
// whose pointer names a hold that is no longer active is listed, with that row (nothing is repaired from a read). A read.
function unjudgedReports(E, project) {
  if (!project) return [];
  let found;
  try {
    found = E.store.p(`SELECT id, title, written_by, status, body FROM memory_entries WHERE type = 'note' AND namespace = ?
      AND json_array_length(COALESCE(json_extract(body, '$.reported_wrong'), '[]')) > 0 ORDER BY created_at, id LIMIT 500`).all(`project/${project}`);
  } catch { return []; }
  if (!found.length) return [];
  const tasks = new Map(rows.currentAll(E.store, 'task').map((t) => [t.id, t]));
  const holds = activeHoldsOf(E, project);
  const out = [];
  for (const n of found) {
    const b = parse(n.body);
    if ((n.status || 'unverified') === 'refuted') continue;
    const hold = holds.get(n.id) || null;
    if (isReportHold(hold)) continue;
    const stale = !hold && b.held && b.held.row ? b.held.row : null;
    for (const w of b.reported_wrong || []) {
      const t = w && tasks.get(w.task_id);
      if (!t || RM.isSettled(b, w) || judged(b, w) || !ENDED_TASK.has(t.state)) continue;
      out.push({ id: n.id, title: n.title, task_id: w.task_id, run_id: w.run_id || null, by: w.by, why: w.why, at: w.at, report_key: RM.reportKey(w), ...(w.by === n.written_by ? { self_report: true } : {}), ...(stale ? { stale_pointer: stale } : {}) });
    }
  }
  return out;
}

function shapeOne(v) {
  if (!isObj(v)) throw bad('a report verdict must be an object { id, report, verdict, cites, reason }');
  for (const k of Object.keys(v)) if (!['id', 'report', 'verdict', 'cites', 'reason'].includes(k)) throw bad(`report verdict.${k} is not a field; use id, report, verdict, cites, reason`);
  if (!validId(v.id)) throw bad('report verdict.id must be the id of the reported note');
  if (v.report !== undefined && v.report !== null && (typeof v.report !== 'string' || !v.report.trim() || Buffer.byteLength(v.report) > KEY_MAX)) throw bad(`report verdict.report must be the report key as listed (at most ${KEY_MAX} bytes)`);
  if (!VERDICTS.includes(v.verdict)) throw bad(`report verdict.verdict must be one of ${VERDICTS.join(', ')}`);
  if (typeof v.reason !== 'string' || !v.reason.trim() || Buffer.byteLength(v.reason) > REASON_MAX) throw bad(`report verdict.reason must be a non-empty string of at most ${REASON_MAX} bytes`);
  const c = CC.checkShape(v.cites);
  if (c.error) throw bad(`report verdict.${c.error}`);
  return { id: v.id, report: v.report ? v.report.trim() : null, verdict: v.verdict, reason: v.reason.replace(/\s+/g, ' ').trim(), cites: c.cites };
}

// A task-style cite (`stream`, `stream:<worker id>`) in the held row's own style (`stream:<absolute file>`), so the archive reviewer can
// read it back. A file cite is unchanged.
function heldCites(E, taskId, cites) {
  const workers = rows.currentAll(E.store, 'worker').filter((w) => w.task_id === taskId);
  const file = (w) => path.join(E.dataDir, 'workers', w, 'stream.jsonl').replace(/\\/g, '/');
  return cites.map((c) => {
    if (c.where !== 'stream' && !c.where.startsWith('stream:')) return c;
    const only = c.where === 'stream' ? null : c.where.slice(7);
    const pool = only ? workers.filter((x) => x.id === only) : workers;
    const w = pool.find((x) => CC.streamResultHas(file(x.id), c.quote).found) || pool[0];
    return { where: `stream:${file(w ? w.id : String(only))}`, quote: c.quote };
  });
}

// The whole list, checked before anything is written (all or nothing): an array of at most REPORTS_MAX * 2, each a well-formed verdict, no
// (note, report) twice. Returns the shaped verdicts, or [] when there are none. noteVerdicts calls it before it applies a single note verdict.
function validateReportVerdicts(list) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list) || list.length > REPORTS_MAX * 2) throw bad(`report_verdicts must be an array of at most ${REPORTS_MAX * 2} verdicts`);
  const seen = new Set();
  return list.map((raw, i) => {
    let v;
    try { v = shapeOne(raw); } catch (e) { throw bad(`report_verdicts[${i}]: ${e.message}`, { field: 'report_verdicts', index: i }); }
    const k = `${v.id}|${v.report || ''}`;
    if (seen.has(k)) throw bad(`report_verdicts[${i}]: note ${v.id}${v.report ? ` report ${v.report}` : ''} has two report verdicts in one review`, { field: 'report_verdicts', index: i, id: v.id });
    seen.add(k);
    return v;
  });
}

// `route`: { reviewer, ref, keyBase, scope }. Fills `out.report_verdicts` = { applied, refused, already, unjudged, refused_open }; `unjudged` leaves out refused
// notes, `refused_open` names the refused reports' notes still open. One bad verdict is a refusal of its own and a receipt, never a throw.
async function applyReportVerdicts(E, caller, route, list, project, out) {
  const res = out.report_verdicts = { applied: [], refused: [], already: [], unjudged: [], refused_open: [] };
  if (list === null || list === undefined) res.none = true;
  else validateReportVerdicts(list); // a caller that skipped the early check still never writes from a malformed list
  const seen = new Set(), refusedIds = new Set();
  const receiptOf = (key) => E.store.p("SELECT id FROM memory_event WHERE kind = 'note_review' AND ok = 1 AND key = ?").get(key);
  for (const [index, raw] of (list || []).entries()) {
    const idOf = isObj(raw) && typeof raw.id === 'string' ? raw.id : null;
    const keyOfRaw = isObj(raw) && typeof raw.report === 'string' ? raw.report : null;
    const refuse = (e) => {
      E.assertRunOpen(caller, 'memory.noteVerdicts'); // a refusal receipt is a write: none after the run ended (audit D42)
      const message = String(e.message).slice(0, 300), code = e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL';
      if (idOf) refusedIds.add(idOf);
      res.refused.push({ index, id: idOf, ...(keyOfRaw ? { report: keyOfRaw } : {}), code, message });
      try { recordEventSync(E, caller, { kind: 'note_review', ok: false, code, run_id: caller.run_id, worker_id: route.reviewer, key: `${route.keyBase}:report:${idOf || index}${keyOfRaw ? `:${keyOfRaw}` : ''}`, row_ids: idOf ? [idOf] : undefined, message: `report verdict: ${message}`.slice(0, 300) }); } catch { /* the refusal is in the answer */ }
    };
    try {
      const v = shapeOne(raw);
      const sk = `${v.id}|${v.report || ''}`;
      if (seen.has(sk)) throw bad(`note ${v.id}${v.report ? ` report ${v.report}` : ''} has two report verdicts in one review`, { id: v.id });
      seen.add(sk);
      const note = loadNote(E, v.id);
      if (!note || note.type !== 'note') throw err('E_NOT_FOUND', `no note ${v.id}`, { id: v.id });
      if (!project || note.namespace !== `project/${project}`) throw bad(`note ${v.id} is in ${note.namespace}, not live in this run's project`, { id: v.id });
      if ((note.status || 'unverified') === 'refuted') throw bad(`note ${v.id} is already refuted`, { id: v.id });
      // The report this verdict is about: the one it names by key, else the note's only open report from a task this review covers.
      const covered = (note.b.reported_wrong || []).filter((w) => w && route.scope.includes(w.task_id) && !RM.isSettled(note.b, w));
      let report;
      if (v.report) {
        report = covered.find((w) => RM.reportKey(w) === v.report);
        if (!report) throw bad(`note ${v.id} has no report ${v.report} from a task this review covers (${covered.map(RM.reportKey).join(', ') || 'none'})`, { id: v.id, report: v.report });
      } else {
        const open = covered.filter((w) => !judged(note.b, w));
        if (!open.length) {
          // Nothing open: this review may have answered already (under the per-report key, or the older per-note key).
          const prior = E.store.p("SELECT id FROM memory_event WHERE kind = 'note_review' AND ok = 1 AND (key = ?1 OR substr(key, 1, length(?2)) = ?2) LIMIT 1").get(`${route.keyBase}:report:${v.id}`, `${route.keyBase}:report:${v.id}:`);
          if (prior) { res.already.push({ id: v.id, event_id: prior.id }); continue; }
          throw bad(`note ${v.id} has no open report from a task this review covers (${route.scope.join(', ') || 'no tasks'})`, { id: v.id });
        }
        if (open.length > 1) throw bad(`note ${v.id} has ${open.length} open reports from tasks this review covers: name one in "report" (${open.map(RM.reportKey).join(', ')})`, { id: v.id, reports: open.map(RM.reportKey) });
        report = open[0];
      }
      const rkey = RM.reportKey(report);
      const key = `${route.keyBase}:report:${v.id}:${rkey}`;
      const done = receiptOf(key);
      if (done) { res.already.push({ id: v.id, report: rkey, event_id: done.id }); continue; }
      // An older receipt under the per-note key answers only the one report its judgment on the note names, never every report on the note.
      const oldDone = receiptOf(`${route.keyBase}:report:${v.id}`);
      if (oldDone && (note.b.report_judgments || []).some((j) => j && j.ref === route.ref && RM.sameReport(j, report))) { res.already.push({ id: v.id, report: rkey, event_id: oldDone.id }); continue; }
      if (judged(note.b, report)) { res.already.push({ id: v.id, report: rkey, event_id: null }); continue; }
      if (note.written_by === `worker:${route.reviewer}`) throw err('E_ROLE', `worker ${route.reviewer} wrote note ${v.id} and cannot judge a report about it`, { id: v.id, reason: 'independence' });
      if (report.worker_id === route.reviewer || report.by === route.reviewer || report.by === `worker:${route.reviewer}`) throw err('E_ROLE', `worker ${route.reviewer} made the report on note ${v.id} and cannot judge it`, { id: v.id, reason: 'independence' });
      const repLease = heldLeaseOn(E.store, route.reviewer, [report.task_id].filter(Boolean));
      if (repLease) throw err('E_ROLE', `worker ${route.reviewer} held lease ${repLease.id} on task ${report.task_id}, which made the report on note ${v.id}; it cannot judge it`, { id: v.id, reason: 'independence', lease_id: repLease.id });
      const lease = heldLeaseOn(E.store, route.reviewer, [note.task_id].filter(Boolean));
      if (lease) throw err('E_ROLE', `worker ${route.reviewer} held lease ${lease.id} on task ${note.task_id}, which wrote note ${v.id}; it cannot judge a report about it`, { id: v.id, reason: 'independence' });
      const chk = await CC.checkTaskCites(E, report.task_id, v.cites, { title: note.title, text: note.text, evidence: note.b.evidence });
      if (!chk.ok) throw err('E_CITATION', `report on note ${v.id}: ${chk.failures.length} of ${v.cites.length} cites are not in the evidence task ${report.task_id} recorded; the verdict is dropped (${chk.failures.map((f) => `cites[${f.index}] ${f.where}: ${f.reason}`).join(' | ')})`.slice(0, 600), { id: v.id, failures: chk.failures });
      E.assertRunOpen(caller, 'memory.noteVerdicts'); // the citation check awaited a file; a run that ended meanwhile takes no verdict (audit D42)
      const red = C.redactEntry({ reason: v.reason, cites: heldCites(E, report.task_id, v.cites) });
      const threshold = (N.notesLevers(E, caller) || DEFAULTS).notes_match_threshold;
      const outcome = E.store.tx(() => {
        // Everything that decides is read again here, in the transaction: a second application of the same review answers "already".
        const done2 = receiptOf(key);
        if (done2) return { already: true, event_id: done2.id };
        const fresh = loadNote(E, v.id);
        if (!fresh || fresh.namespace !== `project/${project}`) throw err('E_NOT_FOUND', `note ${v.id} left the project while the cites were checked`, { id: v.id });
        if (judged(fresh.b, report)) return { already: true, event_id: null };
        const at = Date.now();
        const mark = { task_id: report.task_id, report_at: report.at, report_key: rkey, verdict: v.verdict, ref: route.ref, by: route.reviewer, at };
        const advice = { verdict: v.verdict, by: route.reviewer, ref: route.ref, at, reason: red.reason, cites: red.cites, report_key: rkey };
        E.store.patchBody(v.id, (b) => {
          b.report_judgments = [...(b.report_judgments || []), mark].slice(-JUDGMENTS_KEEP);
          if (v.verdict === 'rejected') b.report_rejected = [...(b.report_rejected || []), { ...mark, reason: red.reason, cites: red.cites, why: report.why }].slice(-REJECTED_KEEP);
          return N.fitBody(b);
        });
        // The verdict goes on the hold. A note with no hold for its reports (older data) is held by an upheld verdict, with the verdict on it.
        let hold = activeHoldOf(E, project, v.id);
        let created = null;
        if (!isReportHold(hold) && v.verdict === 'upheld') {
          const made = RH.holdReported(E, caller, { project, runId: caller.run_id, threshold, headSha: headOf(E, report.task_id) }, loadNote(E, v.id), report);
          if (made.row) { created = made; hold = activeHoldOf(E, project, v.id); }
        }
        let heldInfo = null;
        if (isReportHold(hold)) {
          const next = RH.bumpHold(E, hold.id, (b) => {
            b.report_verdicts = [...(b.report_verdicts || []), advice].slice(-VERDICTS_KEEP);
            b.report_verdicts_total = (Number(b.report_verdicts_total) || 0) + 1;
            return b;
          });
          heldInfo = { row: hold.id, kind: next.kind, rev: next.rev, ...(created ? { created: true } : {}), ...(created && created.merged ? { merged: created.merged } : {}) };
        }
        const ev = recordEventSync(E, caller, { kind: 'note_review', ok: true, run_id: caller.run_id, worker_id: route.reviewer, task_id: report.task_id, key, row_ids: [v.id], newest_row_id: heldInfo ? heldInfo.row : v.id, message: `report ${rkey} ${v.verdict}${heldInfo ? ` (advice on held row ${heldInfo.row})` : ''}: ${red.reason}`.slice(0, 300) });
        return { id: v.id, report: rkey, verdict: v.verdict, applied: true, advice: true, ...(heldInfo ? { held: heldInfo } : { receipt: v.verdict === 'rejected' ? 'report_rejected' : 'report_upheld' }), event_id: ev.id };
      });
      if (outcome.already) res.already.push({ id: v.id, report: rkey, event_id: outcome.event_id }); else res.applied.push(outcome);
    } catch (e) { if (e && e.detail && e.detail.run_ended) throw e; refuse(e); }
  }
  if (res.applied.length) E.noteWrite();
  // A refused report is counted once, in `refused`; it stays open (no judgment was marked), so `refused_open` names its note for the next review.
  const open = [...new Set(openReports(E, route.scope, project).map((r) => r.n.id))];
  res.refused_open = open.filter((id) => refusedIds.has(id));
  res.unjudged = open.filter((id) => !refusedIds.has(id));
  return res;
}

module.exports = { headOf, reportsAbout, unjudgedReports, applyReportVerdicts, validateReportVerdicts, openReports, REPORTS_MAX, ENDED_TASK };
