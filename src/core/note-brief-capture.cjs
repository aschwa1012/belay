'use strict';
// note-brief-capture.cjs — the notes a review's brief listed, fixed when the brief is rendered (memory.noteBriefCapture) and read
// back when the verdicts arrive (capturedFor). A reviewer can judge only what it was shown, and what it was shown is a fact of the
// moment the brief was written, so apply time never recomputes it: a note written, reviewed or edited since is not in it.
// One `note_brief` receipt per rendering, keyed brief:<ref>, ref being the review task's id or the review job's worker id. Its row_ids
// hold `<note id>#<shownHash>` for each note listed. The newest receipt for a ref is the brief the reviewer saw.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { validId } = require('./memory-rows.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');
const { shownHash } = require('./note-shown.cjs');

const NOTES_MAX = 50;
const HASH_RE = /^[0-9a-f]{16}$/;
const bad = (message, detail) => err('E_ARGS', message, detail);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const parse = (t) => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } };

// The receipt reference a route's brief is captured under, or throws when the call names no valid review.
function refOf(E, args) {
  if (args.review_task_id !== undefined) {
    const t = rows.current(E.store, 'task', args.review_task_id);
    if (!t) throw err('E_NOT_FOUND', `no task ${args.review_task_id}`, { task_id: args.review_task_id });
    if (!t.acceptance || t.acceptance.verdict !== true) throw bad(`task ${t.id} is not a review task (its acceptance has no verdict)`, { task_id: t.id });
    return { ref: t.id, task_id: t.id };
  }
  const j = args.job;
  if (!isObj(j) || !validId(j.worker_id) || !validId(j.reviewed_task_id) || j.worker_id !== `notereview-${j.reviewed_task_id}`) {
    throw bad('memory.noteBriefCapture needs review_task_id, or job { worker_id, reviewed_task_id } with worker_id notereview-<reviewed_task_id>');
  }
  return { ref: j.worker_id, task_id: j.reviewed_task_id };
}

// args: { review_task_id | job, notes: [{ id, hash }] } hash is shownHash of the note as the brief showed it. Returns the receipt.
async function capture(E, caller, args) {
  if (caller.role === 'orchestrator' && caller.channel !== 'harness') throw err('E_ROLE', 'memory.noteBriefCapture is belay\'s: the run manager fixes a brief, the orchestrator model cannot', { role: caller.role });
  const a = args || {};
  const { ref, task_id } = refOf(E, a);
  if (!Array.isArray(a.notes) || a.notes.length > NOTES_MAX) throw bad(`notes must be an array of at most ${NOTES_MAX} { id, hash }`);
  const seen = new Set();
  const ids = a.notes.map((n, i) => {
    if (!isObj(n) || !validId(n.id) || typeof n.hash !== 'string' || !HASH_RE.test(n.hash)) throw bad(`notes[${i}] must be { id, hash } with a note id and a 16 hex digit shownHash`);
    if (seen.has(n.id)) throw bad(`notes[${i}]: note ${n.id} is listed twice`);
    seen.add(n.id);
    return `${n.id}#${n.hash}`;
  });
  const ev = recordEventSync(E, caller, { kind: 'note_brief', ok: true, key: `brief:${ref}`, task_id, row_ids: ids, message: `brief of ${ref} lists ${ids.length} notes` });
  return { ref, notes: ids.length, event_id: ev.id };
}

// The newest captured brief of a ref: a Map note id -> hash, or null when none was captured.
function capturedFor(E, ref) {
  const r = E.store.p("SELECT row_ids FROM memory_event WHERE kind = 'note_brief' AND ok = 1 AND key = ? ORDER BY seq DESC LIMIT 1").get(`brief:${ref}`);
  if (!r) return null;
  const m = new Map();
  for (const s of parse(r.row_ids) || []) { const i = String(s).lastIndexOf('#'); if (i > 0) m.set(s.slice(0, i), s.slice(i + 1)); }
  return m;
}

// The note row's hash as a reviewer would have been shown it.
const hashOfRow = (n) => { const b = parse(n.body); return shownHash({ title: n.title, when: b.when, text: n.text, evidence: b.evidence }); };

module.exports = { capture, capturedFor, hashOfRow };
