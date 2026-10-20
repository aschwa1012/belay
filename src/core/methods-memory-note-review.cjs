'use strict';
// methods-memory-note-review.cjs — wave 4: a note is judged on its own by a reviewer other than its writer, and belay applies
// the verdict (ADR 0044 decision 5, ADR 0047). Three methods:
//   memory.noteVerdicts    harness only: applies `confirmed` / `refuted` verdicts to notes, after the citation check
//   memory.noteRefutation  read: what a refuted note's wake carries
//   memory.reviewBrief     read: the notes a review task should judge, and the refuted notes its tasks' workers were shown
//
// Two routes reach noteVerdicts, and the reviewer is never taken from the call's words:
//   { review_task_id }                   a review task's own hand-back (`result.memory_verdicts`); the reviewer is the worker
//                                        that handed it back, which belay proved when it took the lease
//   { job: { worker_id, reviewed_task_id }, verdicts }   the short review job the run manager started; the worker row is belay's
// Each verdict is applied or refused on its own, and each outcome is a `note_review` receipt. `confirmed` sets status verified,
// `refuted` sets refuted, both with the receipt `review:<ref>`, status_by harness, and the verdict, reason and cites go on the
// note's body so a later reader can see why. The citation check is the one gate on meaning: a quote that is not in the reviewed
// task's recorded evidence is `E_CITATION` and changes nothing. A writer never judges its own note, and neither does a worker
// that held a lease on the note's task. A refuted note leaves the index, the corpus and a project search that filters status.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { validId } = require('./memory-rows.cjs');
const { projectOf } = require('./memory-reach.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');
const CC = require('./memory-citations.cjs');
const F = require('./note-review-facts.cjs');
const { heldLeaseOn } = require('./verdict.cjs');
const RV = require('./note-report-verdicts.cjs');
const { hiddenParts } = require('./note-shown.cjs');

const VERDICTS = ['confirmed', 'refuted', 'unsupported'];
const REASON_MAX = 500;
const VERDICTS_MAX = 50;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ID_COLS = 'id, title, text, namespace, type, status, status_receipt, task_id, written_by, run_id, body';

const bad = (message, detail) => err('E_ARGS', message, detail);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const parse = (t) => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } };

function guard(E, caller) {
  if (caller.role === 'orchestrator' && caller.channel !== 'harness') {
    throw err('E_ROLE', 'memory.noteVerdicts is belay\'s: the run manager applies a reviewer\'s verdicts, the orchestrator model cannot', { role: caller.role });
  }
}

// The route: who reviewed, under what reference, which tasks' notes it may judge, and the verdicts as stated.
function routeOf(E, args, caller) {
  if (args.review_task_id !== undefined) {
    if (args.job !== undefined || args.verdicts !== undefined) throw bad('memory.noteVerdicts takes review_task_id, or job and verdicts, not both');
    const t = rows.current(E.store, 'task', args.review_task_id);
    if (!t) throw err('E_NOT_FOUND', `no task ${args.review_task_id}`, { task_id: args.review_task_id });
    if (!t.acceptance || t.acceptance.verdict !== true) throw bad(`task ${t.id} is not a review task (its acceptance has no verdict)`, { task_id: t.id });
    const h = t.handoff;
    const lease = h && typeof h.lease_id === 'string' ? rows.currentLeaseForTask(E.store, t.id) : null;
    if (!h || !lease || lease.id !== h.lease_id || lease.released_at == null || lease.holder_role !== 'worker' || lease.holder !== h.by) {
      throw bad(`task ${t.id} has no current released hand-back from a worker, so there is no reviewer to attribute verdicts to`, { task_id: t.id });
    }
    const r = h.result && isObj(h.result) ? h.result : null;
    const list = r && r.memory_verdicts;
    return { reviewer: h.by, ref: t.id, keyBase: `review:${t.id}@${h.at}`, scope: Array.isArray(t.depends_on) ? t.depends_on : [], capped: true, verdicts: list === undefined ? null : list, reportVerdicts: r && r.report_verdicts !== undefined ? r.report_verdicts : null, task_id: t.id };
  }
  const j = args.job;
  if (!isObj(j) || !validId(j.worker_id) || !validId(j.reviewed_task_id)) throw bad('memory.noteVerdicts needs review_task_id, or job { worker_id, reviewed_task_id } with verdicts');
  if (!j.worker_id.startsWith('notereview-')) throw bad(`job.worker_id ${j.worker_id} is not a review job (its id starts notereview-)`, { worker_id: j.worker_id });
  if (j.worker_id !== `notereview-${j.reviewed_task_id}`) throw bad(`job.worker_id ${j.worker_id} is not the review job of task ${j.reviewed_task_id}`, { worker_id: j.worker_id });
  const jw = rows.current(E.store, 'worker', j.worker_id);
  if (!jw) throw err('E_NOT_FOUND', `no worker row ${j.worker_id}: a review job is a worker belay spawned`, { worker_id: j.worker_id });
  if (caller && caller.run_id && jw.run_id && jw.run_id !== caller.run_id) throw bad(`worker ${j.worker_id} belongs to another run`, { worker_id: j.worker_id });
  return { reviewer: j.worker_id, ref: j.worker_id, keyBase: `review:${j.worker_id}`, scope: [j.reviewed_task_id], verdicts: args.verdicts === undefined ? null : args.verdicts, reportVerdicts: args.report_verdicts === undefined ? null : args.report_verdicts, task_id: j.reviewed_task_id };
}

function shapeOne(v) {
  if (!isObj(v)) throw bad('a verdict must be an object { id, verdict, cites, reason }');
  for (const k of Object.keys(v)) if (!['id', 'verdict', 'cites', 'reason'].includes(k)) throw bad(`verdict.${k} is not a field; use id, verdict, cites, reason`);
  if (!validId(v.id)) throw bad('verdict.id must be a note id');
  if (!VERDICTS.includes(v.verdict)) throw bad(`verdict.verdict must be one of ${VERDICTS.join(', ')}`);
  if (typeof v.reason !== 'string' || !v.reason.trim() || Buffer.byteLength(v.reason) > REASON_MAX) throw bad(`verdict.reason must be a non-empty string of at most ${REASON_MAX} bytes`);
  // `unsupported` means no single place proves or disproves the note, so it needs a reason and takes cites only if there are some.
  const none = v.verdict === 'unsupported' && (v.cites === undefined || (Array.isArray(v.cites) && !v.cites.length));
  const c = none ? { cites: [] } : CC.checkShape(v.cites);
  if (c.error) throw bad(`verdict.${c.error}`);
  return { id: v.id, verdict: v.verdict, reason: v.reason.replace(/\s+/g, ' ').trim(), cites: c.cites };
}

const codeOf = (e) => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');

// Checks that need the store but no file: the note, its place, the scope and independence. Returns the note row.
function admit(E, caller, route, v) {
  const n = E.store.p(`SELECT ${ID_COLS} FROM memory_entries WHERE id = ?`).get(v.id);
  if (!n || n.type !== 'note') throw err('E_NOT_FOUND', `no note ${v.id}`, { id: v.id });
  const project = caller.run_id ? projectOf(E, caller) : null;
  if (n.namespace.startsWith('pending/')) throw bad(`note ${n.id} is pending, so it hides nothing and needs no review; its writer resolves it first`, { id: n.id });
  if (project && n.namespace !== `project/${project}`) throw bad(`note ${n.id} is in ${n.namespace}, not in this run's project`, { id: n.id });
  if (!route.scope.includes(n.task_id)) throw bad(`note ${n.id} was written for task ${n.task_id || 'none'}, which this review does not cover (${route.scope.join(', ') || 'no tasks'})`, { id: n.id, task_id: n.task_id });
  if (n.written_by === `worker:${route.reviewer}`) throw err('E_ROLE', `worker ${route.reviewer} wrote note ${n.id} and cannot review it`, { id: n.id, reason: 'independence' });
  const held = heldLeaseOn(E.store, route.reviewer, [n.task_id]);
  if (held) throw err('E_ROLE', `worker ${route.reviewer} held lease ${held.id} on task ${n.task_id}, which wrote note ${n.id}; a worker that did the work cannot review its notes`, { id: n.id, reason: 'independence', lease_id: held.id });
  const status = n.status || 'unverified';
  if (status === 'refuted' && v.verdict === 'confirmed') throw bad(`note ${n.id} is refuted; a refuted note is changed back only by the operator`, { id: n.id });
  // A confirmed note is shown to later workers as reviewed, so it is confirmed only on what the reviewer saw. A review task's brief caps a note
  // (note-shown.cjs); the review job reads every field from its notes file.
  if (v.verdict === 'confirmed' && route.capped) {
    const hidden = hiddenParts({ text: n.text, when: parse(n.body).when, evidence: parse(n.body).evidence });
    if (hidden.length) throw bad(`note ${n.id} was shown to the reviewer in part (${hidden.join('; ')}), so it cannot be confirmed; refute it on a value that was shown, or leave it unreviewed`, { id: n.id, reason: 'hidden_fields', hidden });
  }
  return n;
}

// Inside a transaction (the caller's): sets the status of a note on a confirmed or refuted verdict. The archive reviewer's verify and refute use it too.
function applyOneIn(E, caller, route, v, n) {
  const at = Date.now();
  const receipt = `review:${route.ref}`;
  const status = v.verdict === 'confirmed' ? 'verified' : 'refuted';
  const common = { run_id: caller.run_id || n.run_id, worker_id: route.reviewer, task_id: n.task_id, key: `${route.keyBase}:${n.id}` };
  {
    // The status is read again inside the write: the citation check awaited a file, and another review may have landed since
    // admit() looked. A refuted note is never confirmed back, and the answer's previous_status is what was really there.
    const cur = E.store.p('SELECT status FROM memory_entries WHERE id = ?').get(n.id);
    if (!cur) throw err('E_NOT_FOUND', `no note ${n.id}`, { id: n.id });
    const previous = cur.status || 'unverified';
    if (previous === 'refuted' && v.verdict === 'confirmed') throw bad(`note ${n.id} was refuted while this verdict was being checked; a refuted note is changed back only by the operator`, { id: n.id });
    E.store.p('UPDATE memory_entries SET status = ?, status_receipt = ?, status_by = ?, status_at = ? WHERE id = ?').run(status, receipt, E.memoryWriter(caller), at, n.id);
    E.store.patchBody(n.id, (b) => { b.review = { verdict: v.verdict, by: route.reviewer, ref: route.ref, at, reason: v.reason, cites: v.cites }; return b; });
    const ev = recordEventSync(E, caller, { kind: 'note_review', ok: true, ...common, row_ids: [n.id], newest_row_id: n.id, message: `${v.verdict}: ${v.reason}`.slice(0, 300) });
    if (v.verdict === 'refuted') recordEventSync(E, caller, { kind: 'note_refuted', ok: true, ...common, key: `refuted:${n.id}`, row_ids: [n.id], newest_row_id: n.id, message: `note ${n.id} refuted by review ${route.ref}` });
    return { id: n.id, verdict: v.verdict, applied: true, status, previous_status: previous, status_receipt: receipt, status_by: E.memoryWriter(caller), status_at: at, event_id: ev.id };
  }
}
const applyOne = (E, caller, route, v, n) => E.store.tx(() => applyOneIn(E, caller, route, v, n));

async function noteVerdicts(E, caller, args) {
  guard(E, caller);
  const route = routeOf(E, args || {}, caller);
  if (!REF_RE.test(route.ref)) throw bad(`review reference ${route.ref} is not a valid receipt reference`);
  const out = { reviewer: route.reviewer, ref: route.ref, applied: [], refused: [], already: [], unjudged: [], refused_open: [] };
  if (route.verdicts === null) { out.no_verdicts = true; }
  else if (!Array.isArray(route.verdicts) || route.verdicts.length > VERDICTS_MAX) throw bad(`memory_verdicts must be an array of at most ${VERDICTS_MAX} verdicts`);
  RV.validateReportVerdicts(route.reportVerdicts); // all or nothing: a malformed report list is refused before any note verdict is written
  const seen = new Set(), refusedIds = new Set();
  for (const [index, raw] of (route.verdicts || []).entries()) {
    const idOf = isObj(raw) && typeof raw.id === 'string' ? raw.id : null;
    const refuse = (e, n) => {
      const message = String(e.message).slice(0, 300);
      if (idOf) refusedIds.add(idOf);
      out.refused.push({ index, id: idOf, code: codeOf(e), message, ...(e.detail ? { detail: e.detail } : {}) });
      try {
        recordEventSync(E, caller, { kind: 'note_review', ok: false, code: codeOf(e), run_id: (n && n.run_id) || caller.run_id, worker_id: route.reviewer, task_id: (n && n.task_id) || undefined, key: `${route.keyBase}:${idOf || index}`, row_ids: idOf ? [idOf] : undefined, message });
      } catch { /* the refusal itself is in the answer */ }
    };
    let n = null;
    try {
      const v = shapeOne(raw);
      if (seen.has(v.id)) throw bad(`note ${v.id} has two verdicts in one review`, { id: v.id });
      seen.add(v.id);
      const done = E.store.p("SELECT id FROM memory_event WHERE kind = 'note_review' AND ok = 1 AND key = ?").get(`${route.keyBase}:${v.id}`);
      if (done) { out.already.push({ id: v.id, event_id: done.id }); continue; }
      n = admit(E, caller, route, v);
      const chk = v.cites.length === 0 ? { ok: true } : await CC.checkTaskCites(E, n.task_id, v.cites, { title: n.title, when: parse(n.body).when, text: n.text, evidence: parse(n.body).evidence });
      if (!chk.ok) throw err('E_CITATION', `note ${n.id}: ${chk.failures.length} of ${v.cites.length} cites are not in the evidence task ${n.task_id} recorded; the verdict is dropped (${chk.failures.map((f) => `cites[${f.index}] ${f.where}: ${f.reason}`).join(' | ')})`.slice(0, 600), { id: n.id, failures: chk.failures });
      out.applied.push(v.verdict === 'unsupported' ? require('./note-unsupported.cjs').queueUnsupported(E, caller, route, v, n) : applyOne(E, caller, route, v, n));
    } catch (e) { refuse(e, n); }
  }
  if (out.applied.length) E.noteWrite();
  const judged = new Set([...seen]);
  const proj = caller.run_id ? projectOf(E, caller) : null;
  // A note whose verdict was refused is counted once, in `refused`, never also in `unjudged`. It has no status change, so it stays under
  // review and the next review is offered it again; `refused_open` names those ids so that does not depend on `unjudged`.
  const under = F.notesUnderReview(E, route.scope, proj).map((x) => x.id);
  out.refused_open = under.filter((id) => refusedIds.has(id));
  out.unjudged = under.filter((id) => !judged.has(id) && !refusedIds.has(id));
  await RV.applyReportVerdicts(E, caller, route, route.reportVerdicts, proj, out); // reports of "wrong" about other notes: upheld holds, rejected leaves a receipt
  return out;
}

// The facts a refuted note's wake carries (note-review-facts.cjs). A read.
async function noteRefutation(E, caller, args) {
  if (!validId(args && args.note_id)) throw bad('memory.noteRefutation needs a note_id');
  const r = F.refutationOf(E, args.note_id);
  if (!r) throw err('E_NOT_FOUND', `no note ${args.note_id}`, { id: args.note_id });
  return r;
}

// For a review task's brief: the notes to judge, and the refuted notes any worker of the reviewed tasks was shown. A read;
// a task that is not a review task has neither.
async function reviewBrief(E, caller, args) {
  const proj = caller.run_id ? projectOf(E, caller) : null;
  if (args && args.reviewed_task_id !== undefined) { // the review job's form: the task whose notes are judged, which has no review task
    if (!validId(args.reviewed_task_id) || !rows.current(E.store, 'task', args.reviewed_task_id)) throw err('E_NOT_FOUND', `no task ${args.reviewed_task_id}`, { task_id: args.reviewed_task_id });
    return { reviewed_tasks: [args.reviewed_task_id], notes: F.notesUnderReview(E, [args.reviewed_task_id], proj), refuted_shown: F.refutedShownTo(E, [args.reviewed_task_id]), reports: RV.reportsAbout(E, [args.reviewed_task_id], proj) };
  }
  const t = rows.current(E.store, 'task', args && args.task_id);
  if (!t) throw err('E_NOT_FOUND', `no task ${args && args.task_id}`, { task_id: args && args.task_id });
  if (!t.acceptance || t.acceptance.verdict !== true) return { task_id: t.id, review: false, notes: [], refuted_shown: [], reports: [] };
  const deps = Array.isArray(t.depends_on) ? t.depends_on : [];
  return { task_id: t.id, review: true, reviewed_tasks: deps, notes: F.notesUnderReview(E, deps, proj), refuted_shown: F.refutedShownTo(E, deps), reports: RV.reportsAbout(E, deps, proj) };
}

module.exports = { noteVerdicts, noteRefutation, reviewBrief, applyOneIn };
