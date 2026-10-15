'use strict';
// methods-memory-stages.cjs — the two reads the run-close stages are built on (the scrubber and the Opus archive reviewer).
// Both are SELECTs: they answer from a copy of the store and write nothing. The stages are the run manager's; the lists they work
// from are the core's, so the scope of a scrub is never something a model or a stage decides.
//
//   memory.scrubScope   the scrubber's scope for the caller's run, and ONLY these three kinds of item:
//                         1. notes reported wrong in this run (a live note carrying a report whose run is this one);
//                         2. pending notes this run left unresolved, plus any `scrub_owed` item (work an earlier scrub did not do);
//                         3. notes nominated for promotion (memory-nominations.cjs; none until that step is built).
//                       Each item carries the evidence the scrubber is shown: the note, its reports, its stored matches, the notes
//                       they name, and the reporting workers' stream files. Owed items come first.
//   memory.reviewQueue  the project's held queue for the Opus reviewer: each open hold with both notes, the age in runs and whether
//                       the note it stands against was verified by a review. The stage decides from these facts when to run.

const fs = require('node:fs');
const path = require('node:path');
const { err } = require('./errors.cjs');
const L = require('./memory-lifecycle.cjs');
const C = require('./lifecycle-common.cjs');
const M = require('./methods-memory.cjs');
const N = require('./methods-memory-notes.cjs');
const { parse } = require('./memory-facts.cjs');
const { nominationsForScope } = require('./memory-nominations.cjs');

const fwd = p => String(p).split('\\').join('/');
const TEXT_CUT = 1500;
const REPORTS_SHOWN = 5;
const cut = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };

const COLS = 'id, namespace, type, worker_id, written_by, run_id, task_id, title, text, text_hash, embedding_model, dim, body, status, status_receipt, created_at';
function load(E, id) {
  const r = E.store.p(`SELECT ${COLS} FROM memory_entries WHERE id = ?`).get(id);
  return r ? { ...r, b: parse(r.body) } : null;
}

// What the stages show of a note: the row's own fields and its body's facts. Model-written text is cut here and stays data.
function noteFacts(note) {
  const b = note.b;
  return {
    id: note.id, namespace: note.namespace, kind: b.kind || null, basis: b.basis || null, title: cut(note.title, 200), text: cut(note.text, TEXT_CUT),
    evidence: (b.evidence || []).slice(0, 5), applies_to: b.applies_to || [], subjects: b.subjects || [],
    written_by: note.written_by, worker_id: note.worker_id || null, task_id: note.task_id || null, run_id: note.run_id || null,
    status: note.status || 'unverified', status_receipt: note.status_receipt || null, created_at: note.created_at,
    held: b.held ? { row: b.held.row, kind: b.held.kind, of: b.held.of || null, run_id: b.held.run_id } : null,
    seen_total: b.seen_total || 0,
  };
}

// What the scrub receipts say about the ids: `owed` are ids an earlier scrub could not do and no later scrub has handled (the last event
// naming the id decides); `handled` are ids a scrub of THIS run already handled, which the run's scope does not offer again (a second
// scrub of the same run, by hand, does not spend a second model call on the same reports). An owed id is always offered.
function scrubHistory(E, runId) {
  const owed = new Map(), handled = new Set();
  let evs;
  try { evs = E.store.p("SELECT kind, ok, row_ids, run_id, code, message FROM memory_event WHERE kind IN ('scrub_owed', 'scrub_job') ORDER BY seq").all(); } catch { return { owed, handled }; }
  for (const ev of evs) {
    if (ev.kind === 'scrub_job' && !(ev.ok === 1 || ev.ok === true)) continue;
    let ids = [];
    try { ids = JSON.parse(ev.row_ids) || []; } catch { ids = []; }
    for (const id of ids) {
      if (ev.kind === 'scrub_owed') { owed.set(id, { run_id: ev.run_id, code: ev.code || null, message: cut(ev.message, 200) }); handled.delete(id); } else { owed.delete(id); if (ev.run_id === runId) handled.add(id); }
    }
  }
  return { owed, handled };
}

function streamsOf(E, ids) {
  const out = [];
  for (const wid of ids) {
    if (!wid || typeof wid !== 'string') continue;
    const file = fwd(path.join(E.dataDir, 'workers', wid, 'stream.jsonl'));
    if (!out.some(s => s.path === file) && fs.existsSync(file)) out.push({ worker_id: wid, path: file });
  }
  return out;
}

function item(E, note, why) {
  const b = note.b;
  const reports = (b.reported_wrong || []).slice(-REPORTS_SHOWN).map(w => ({ by: w.by, worker_id: w.worker_id || null, task_id: w.task_id || null, run_id: w.run_id || null, why: cut(w.why, 500), replaced_by: w.replaced_by || null, at: w.at || null }));
  const matches = (b.matches || []).map(m => ({ id: m.id, similarity: m.similarity }));
  const related = [];
  for (const rid of new Set([...reports.map(r => r.replaced_by), ...matches.map(m => m.id)].filter(x => typeof x === 'string' && x !== note.id))) {
    const r = load(E, rid);
    if (r && r.type === 'note') related.push(noteFacts(r));
  }
  const workers = [...reports.map(r => r.worker_id), note.worker_id];
  return { id: note.id, state: note.namespace.startsWith('pending/') ? 'pending' : 'live', why: [...why], note: noteFacts(note), reports, matches, related, streams: streamsOf(E, workers) };
}

const ORDER = { owed: 0, reported_wrong: 1, pending: 2, nominated: 3 };

async function scrubScope(E, caller, args) {
  C.allowKeys(args || {}, [], 'memory.scrubScope');
  const project = M.projectOf(E, caller);
  if (!project) throw err('E_ARGS', 'memory.scrubScope: this run has no project, so there are no notes to scrub', { field: 'project' });
  const runId = caller.run_id;
  const byId = new Map();
  const add = (note, why, extra) => {
    if (!note || note.type !== 'note') return;
    if (note.namespace !== N.projectNs(project) && note.namespace !== N.pendingNs(project)) return;
    const have = byId.get(note.id);
    if (have) { if (!have.why.includes(why)) have.why.push(why); Object.assign(have, extra || {}); return; }
    byId.set(note.id, { ...item(E, note, [why]), ...(extra || {}) });
  };
  const history = scrubHistory(E, runId);
  for (const [id, o] of history.owed) add(load(E, id), 'owed', { owed: o });
  const addNew = (id, why, extra) => { if (!history.handled.has(id)) add(load(E, id), why, extra); };
  const reported = E.store.p(`SELECT id FROM memory_entries WHERE type = 'note' AND namespace = ? AND EXISTS
    (SELECT 1 FROM json_each(memory_entries.body, '$.reported_wrong') WHERE json_extract(value, '$.run_id') = ?) ORDER BY created_at, id`).all(N.projectNs(project), runId);
  for (const r of reported) addNew(r.id, 'reported_wrong');
  const pending = E.store.p("SELECT id FROM memory_entries WHERE type = 'note' AND namespace = ? AND run_id = ? ORDER BY created_at, id").all(N.pendingNs(project), runId);
  for (const r of pending) addNew(r.id, 'pending');
  for (const nom of nominationsForScope(E, project) || []) addNew(nom.id, 'nominated', { nomination: nom.facts || null });
  const items = [...byId.values()].sort((a, b) => Math.min(...a.why.map(w => ORDER[w])) - Math.min(...b.why.map(w => ORDER[w])));
  const counts = { items: items.length, owed: 0, reported_wrong: 0, pending: 0, nominated: 0 };
  for (const it of items) for (const w of it.why) counts[w] += 1;
  return { project, run_id: runId, items, counts };
}

const QUEUE_LIMIT = 500;
async function reviewQueue(E, caller, args) {
  C.allowKeys(args || {}, [], 'memory.reviewQueue');
  const project = M.projectOf(E, caller);
  if (!project) throw err('E_ARGS', 'memory.reviewQueue: this run has no project, so there is no held queue', { field: 'project' });
  const rows = E.store.p(`SELECT id, run_id, created_at, body FROM memory_entries WHERE namespace = ? AND type = 'held' AND written_by = 'harness'
    AND json_extract(body, '$.state') = 'held' ORDER BY created_at, id LIMIT ${QUEUE_LIMIT}`).all(L.nsOf('held', project));
  const held = [];
  for (const r of rows) {
    const b = parse(r.body);
    const note = load(E, b.note_id);
    if (!note || note.namespace !== N.projectNs(project)) continue; // a hold whose note left the project is the apply-time refusal's business
    const of = b.of ? load(E, b.of) : null;
    let waited = 0;
    try { waited = Number(E.store.p('SELECT COUNT(DISTINCT id) AS n FROM run WHERE project = ? AND COALESCE(started_at, written_at) > ?').get(project, r.created_at).n); } catch { waited = 0; }
    held.push({
      held_row: r.id, id: note.id, kind: b.kind, of: b.of || null, ground: b.ground, reason: cut(b.reason, 500), cites: b.cites || [], facts: b.facts || null,
      run_id: b.run_id || r.run_id, head_sha: b.head_sha || null, marked_at: r.created_at, runs_waited: waited,
      target_review_verified: (note.status || 'unverified') === 'verified' && String(note.status_receipt || '').startsWith('review:'),
      note: noteFacts(note), of_note: of ? noteFacts(of) : null,
    });
  }
  const counts = { count: held.length, max_runs_waited: held.reduce((m, h) => Math.max(m, h.runs_waited), 0), review_verified: held.filter(h => h.target_review_verified).length };
  return { project, run_id: caller.run_id, held, counts, limit: QUEUE_LIMIT };
}

module.exports = { scrubScope, reviewQueue, noteFacts, scrubHistory };
