'use strict';
// note-report-verdicts.cjs — a worker's report that a note is WRONG, judged by the task's reviewer (or the Haiku note-review job).
// "Is a note wrong about the world?" needs evidence and context, so it is the reviewer's, with cites, never the scrubber's.
//   reportsAbout(E, taskIds, project)   a read: the open reports the tasks made about OTHER notes, for a reviewer's brief
//   unjudgedReports(E, project)         a read: reports no verdict has been applied to, for the operator (notices, `belay memory proposals`)
//   applyReportVerdicts(...)            the write: `report_verdicts: [{ id, verdict: upheld|rejected, cites, reason }]`
// An upheld report creates a `wrong` hold on the reported note (the note stays visible with its warning; only the Opus archive
// reviewer archives it). A rejected report is a `report_rejected` receipt on the note. Same citation check and same independence rule
// as a note verdict; a reviewer never judges a report about a note it wrote, and never one it made or whose task it worked. An upheld
// report against a note a review VERIFIED needs the task's reviewer: the Haiku job's upheld verdict there is a recommendation only,
// recorded on the note and listed for the operator, and creates no hold. Each outcome is a `note_review` receipt keyed
// `<review>:report:<note id>`, so a second application is a no-op.

const path = require('node:path');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { validId } = require('./memory-rows.cjs');
const CC = require('./memory-citations.cjs');
const C = require('./lifecycle-common.cjs');
const N = require('./methods-memory-notes.cjs');
const { loadNote } = require('./memory-facts.cjs');
const { holdWrongFromReport } = require('./memory-report-hold.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');
const { heldLeaseOn } = require('./verdict.cjs');

const VERDICTS = ['upheld', 'rejected'];
const REASON_MAX = 500;
const REPORTS_MAX = 8;          // reports shown to one reviewer (the hand-back is 4,096 bytes)
const JUDGMENTS_KEEP = 20;
const REJECTED_KEEP = 10;
const RECOMMENDED_KEEP = 10;
const JOB_PREFIX = 'notereview-';
const bad = (message, detail) => err('E_ARGS', message, detail);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const parse = (t) => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } };

const judged = (b, w) => (b.report_judgments || []).some((j) => j && j.task_id === w.task_id && j.report_at === w.at);

// The head commit a worker of the task recorded.
function headOf(E, taskId) {
  const w = rows.currentAll(E.store, 'worker').find((x) => x.task_id === taskId && x.head_sha);
  return w ? w.head_sha : null;
}

// The open reports (not judged, on a live non-held note of the project, made by someone other than the note's writer) that these
// tasks made. One entry per (note, report).
function openReports(E, taskIds, project) {
  if (!taskIds.length || !project) return [];
  const marks = taskIds.map(() => '?').join(', ');
  const found = E.store.p(`SELECT id, title, text, namespace, written_by, task_id, status, body FROM memory_entries WHERE type = 'note' AND namespace = ?
    AND EXISTS (SELECT 1 FROM json_each(memory_entries.body, '$.reported_wrong') WHERE json_extract(value, '$.task_id') IN (${marks})) ORDER BY created_at, id LIMIT 200`).all(`project/${project}`, ...taskIds);
  const out = [];
  for (const n of found) {
    const b = parse(n.body);
    if (b.held || (n.status || 'unverified') === 'refuted') continue;
    for (const w of b.reported_wrong || []) {
      if (!w || !taskIds.includes(w.task_id) || w.by === n.written_by || judged(b, w)) continue;
      out.push({ n, b, w });
    }
  }
  return out;
}

// For a reviewer's brief: each reported note's row facts, the report, and the reporter task's head sha.
function reportsAbout(E, taskIds, project) {
  return openReports(E, taskIds, project).slice(0, REPORTS_MAX).map(({ n, b, w }) => ({
    note: { id: n.id, title: n.title, kind: b.kind || null, basis: b.basis || null, task_id: n.task_id, written_by: n.written_by, status: n.status || 'unverified', evidence: Array.isArray(b.evidence) ? b.evidence.slice(0, 1) : [] },
    report: { task_id: w.task_id, by: w.by, why: w.why, replaced_by: w.replaced_by || null, at: w.at },
    head_sha: headOf(E, w.task_id),
  }));
}

// Reports nobody has judged: the reporter's task has ended and the note carries no judgment for the report (`report_judgments`). That is the
// only test. A review task or a note-review job that ran and left the report out (or had its verdict refused) judged nothing, so the report
// stays here until a verdict is applied or the operator looks (notices, `belay memory proposals`). A read.
function unjudgedReports(E, project) {
  if (!project) return [];
  let found;
  try {
    found = E.store.p(`SELECT id, title, written_by, status, body FROM memory_entries WHERE type = 'note' AND namespace = ?
      AND json_array_length(COALESCE(json_extract(body, '$.reported_wrong'), '[]')) > 0 ORDER BY created_at, id LIMIT 500`).all(`project/${project}`);
  } catch { return []; }
  if (!found.length) return [];
  const tasks = new Map(rows.currentAll(E.store, 'task').map((t) => [t.id, t]));
  const out = [];
  for (const n of found) {
    const b = parse(n.body);
    if (b.held || (n.status || 'unverified') === 'refuted') continue;
    for (const w of b.reported_wrong || []) {
      const t = w && tasks.get(w.task_id);
      if (!t || w.by === n.written_by || judged(b, w) || !['done', 'released'].includes(t.state)) continue;
      out.push({ id: n.id, title: n.title, task_id: w.task_id, run_id: w.run_id || null, by: w.by, why: w.why, at: w.at });
    }
  }
  return out;
}

// Upheld reports the Haiku job could only recommend (the note is review-verified): listed for the operator while the note stays live
// and unheld. A read.
function recommendedReports(E, project) {
  if (!project) return [];
  let found;
  try {
    found = E.store.p(`SELECT id, title, status, body FROM memory_entries WHERE type = 'note' AND namespace = ?
      AND json_array_length(COALESCE(json_extract(body, '$.report_recommended'), '[]')) > 0 ORDER BY created_at, id LIMIT 200`).all(`project/${project}`);
  } catch { return []; }
  const out = [];
  for (const n of found) {
    const b = parse(n.body);
    if (b.held || (n.status || 'unverified') === 'refuted') continue;
    for (const r of b.report_recommended || []) if (r) out.push({ id: n.id, title: n.title, task_id: r.task_id, by: r.by, why: r.why, reason: r.reason, at: r.at, recommended: true });
  }
  return out;
}

function shapeOne(v) {
  if (!isObj(v)) throw bad('a report verdict must be an object { id, verdict, cites, reason }');
  for (const k of Object.keys(v)) if (!['id', 'verdict', 'cites', 'reason'].includes(k)) throw bad(`report verdict.${k} is not a field; use id, verdict, cites, reason`);
  if (!validId(v.id)) throw bad('report verdict.id must be the id of the reported note');
  if (!VERDICTS.includes(v.verdict)) throw bad(`report verdict.verdict must be one of ${VERDICTS.join(', ')}`);
  if (typeof v.reason !== 'string' || !v.reason.trim() || Buffer.byteLength(v.reason) > REASON_MAX) throw bad(`report verdict.reason must be a non-empty string of at most ${REASON_MAX} bytes`);
  const c = CC.checkShape(v.cites);
  if (c.error) throw bad(`report verdict.${c.error}`);
  return { id: v.id, verdict: v.verdict, reason: v.reason.replace(/\s+/g, ' ').trim(), cites: c.cites };
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

// The whole list, checked before anything is written (all or nothing): an array of at most REPORTS_MAX * 2, each a well-formed verdict,
// no note twice. Returns the shaped verdicts, or [] when there are none. noteVerdicts calls it before it applies a single note verdict.
function validateReportVerdicts(list) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list) || list.length > REPORTS_MAX * 2) throw bad(`report_verdicts must be an array of at most ${REPORTS_MAX * 2} verdicts`);
  const seen = new Set();
  return list.map((raw, i) => {
    let v;
    try { v = shapeOne(raw); } catch (e) { throw bad(`report_verdicts[${i}]: ${e.message}`, { field: 'report_verdicts', index: i }); }
    if (seen.has(v.id)) throw bad(`report_verdicts[${i}]: note ${v.id} has two report verdicts in one review`, { field: 'report_verdicts', index: i, id: v.id });
    seen.add(v.id);
    return v;
  });
}

// `route`: { reviewer, ref, keyBase, scope }. Fills `out.report_verdicts` = { applied, refused, already, unjudged, refused_open }; `unjudged` leaves out refused ids, `refused_open` names the refused reports still open. One bad verdict is
// a refusal of its own and a receipt, never a throw.
async function applyReportVerdicts(E, caller, route, list, project, out) {
  const res = out.report_verdicts = { applied: [], refused: [], already: [], unjudged: [], refused_open: [] };
  if (list === null || list === undefined) res.none = true;
  else validateReportVerdicts(list); // a caller that skipped the early check still never writes from a malformed list
  const seen = new Set(), refusedIds = new Set();
  for (const [index, raw] of (list || []).entries()) {
    const idOf = isObj(raw) && typeof raw.id === 'string' ? raw.id : null;
    const key = `${route.keyBase}:report:${idOf || index}`;
    const refuse = (e) => {
      E.assertRunOpen(caller, 'memory.noteVerdicts'); // a refusal receipt is a write: none after the run ended (audit D42)
      const message = String(e.message).slice(0, 300), code = e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL';
      if (idOf) refusedIds.add(idOf);
      res.refused.push({ index, id: idOf, code, message });
      try { recordEventSync(E, caller, { kind: 'note_review', ok: false, code, run_id: caller.run_id, worker_id: route.reviewer, key, row_ids: idOf ? [idOf] : undefined, message: `report verdict: ${message}`.slice(0, 300) }); } catch { /* the refusal is in the answer */ }
    };
    try {
      const v = shapeOne(raw);
      if (seen.has(v.id)) throw bad(`note ${v.id} has two report verdicts in one review`, { id: v.id });
      seen.add(v.id);
      const done = E.store.p("SELECT id FROM memory_event WHERE kind = 'note_review' AND ok = 1 AND key = ?").get(`${route.keyBase}:report:${v.id}`);
      if (done) { res.already.push({ id: v.id, event_id: done.id }); continue; }
      const note = loadNote(E, v.id);
      if (!note || note.type !== 'note') throw err('E_NOT_FOUND', `no note ${v.id}`, { id: v.id });
      if (!project || note.namespace !== `project/${project}`) throw bad(`note ${v.id} is in ${note.namespace}, not live in this run's project`, { id: v.id });
      if ((note.status || 'unverified') === 'refuted') throw bad(`note ${v.id} is already refuted`, { id: v.id });
      const report = (note.b.reported_wrong || []).filter((w) => w && route.scope.includes(w.task_id) && w.by !== note.written_by && !judged(note.b, w)).pop();
      if (!report) throw bad(`note ${v.id} has no open report from a task this review covers (${route.scope.join(', ') || 'no tasks'})`, { id: v.id });
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
      const outcome = E.store.tx(() => {
        // Everything that decides is read again here, in the transaction: a second application of the same review answers "already".
        const done2 = E.store.p("SELECT id FROM memory_event WHERE kind = 'note_review' AND ok = 1 AND key = ?").get(key);
        if (done2) return { already: true, event_id: done2.id };
        const fresh = loadNote(E, v.id);
        if (!fresh || fresh.namespace !== `project/${project}`) throw err('E_NOT_FOUND', `note ${v.id} left the project while the cites were checked`, { id: v.id });
        if (judged(fresh.b, report)) return { already: true, event_id: null };
        const at = Date.now();
        // An upheld report against a note a review verified needs that review's task reviewer; the Haiku job only recommends.
        const recommend = v.verdict === 'upheld' && route.reviewer.startsWith(JOB_PREFIX) && (fresh.status || 'unverified') === 'verified';
        const mark = { task_id: report.task_id, report_at: report.at, verdict: recommend ? 'recommended' : v.verdict, ref: route.ref, by: route.reviewer, at };
        let heldRow = null;
        if (v.verdict === 'upheld' && !recommend) {
          heldRow = holdWrongFromReport(E, caller, {
            project, runId: caller.run_id, headSha: headOf(E, report.task_id), reviewer: route.reviewer, ref: route.ref,
            report: { by: report.by, task_id: report.task_id, why: report.why, replaced_by: report.replaced_by || null, at: report.at },
          }, fresh, { reason: red.reason, cites: red.cites });
        }
        E.store.patchBody(v.id, (b) => {
          b.report_judgments = [...(b.report_judgments || []), mark].slice(-JUDGMENTS_KEEP);
          if (v.verdict === 'rejected') b.report_rejected = [...(b.report_rejected || []), { ...mark, reason: red.reason, cites: red.cites, why: report.why }].slice(-REJECTED_KEEP);
          if (recommend) b.report_recommended = [...(b.report_recommended || []), { ...mark, reason: red.reason, cites: red.cites, why: report.why }].slice(-RECOMMENDED_KEEP);
          return N.fitBody(b);
        });
        const ev = recordEventSync(E, caller, { kind: 'note_review', ok: true, run_id: caller.run_id, worker_id: route.reviewer, task_id: report.task_id, key, row_ids: [v.id], newest_row_id: heldRow ? heldRow.id : v.id, message: `report ${recommend ? 'upheld (a recommendation only: a review verified this note)' : v.verdict}: ${red.reason}`.slice(0, 300) });
        return { id: v.id, verdict: v.verdict, applied: true, ...(heldRow ? { held: C.rowOut(E, heldRow.id) } : { receipt: recommend ? 'report_recommended' : 'report_rejected' }), ...(recommend ? { recommended_only: true } : {}), event_id: ev.id };
      });
      if (outcome.already) res.already.push({ id: v.id, event_id: outcome.event_id }); else res.applied.push(outcome);
    } catch (e) { if (e && e.detail && e.detail.run_ended) throw e; refuse(e); }
  }
  if (res.applied.length) E.noteWrite();
  // A refused report is counted once, in `refused`; it stays open (no judgment was marked), so `refused_open` names it for the next review.
  const open = [...new Set(openReports(E, route.scope, project).map((r) => r.n.id))].filter((id) => !res.applied.some((a) => a.id === id) && !res.already.some((a) => a.id === id));
  res.refused_open = open.filter((id) => refusedIds.has(id));
  res.unjudged = open.filter((id) => !refusedIds.has(id));
  return res;
}

module.exports = { headOf, reportsAbout, unjudgedReports, recommendedReports, applyReportVerdicts, validateReportVerdicts, openReports, REPORTS_MAX };
