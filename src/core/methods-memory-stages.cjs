'use strict';
// methods-memory-stages.cjs — the two reads the run-close stages are built on (the scrubber and the Opus archive reviewer).
// Both are SELECTs: they answer from a copy of the store and write nothing. The stages are the run manager's; the lists they work
// from are the core's, so the scope of a scrub is never something a model or a stage decides.
//
//   memory.scrubScope   the scrubber's scope for the caller's run, and ONLY these kinds of item (how notes RELATE; whether a note is
//                       wrong is a reviewer's call, so a bare "wrong" report is not here):
//                         1. pairs a worker named this run: a live note carrying a report of this run whose `replaced_by` is another live note;
//                         2. pending notes this run left unresolved, plus any `scrub_owed` item (work an earlier scrub did not do);
//                         3. live notes with `memory embed` matches (`body.matches`) not yet judged (no `new` verdict on the pair);
//                         4. notes nominated for promotion (memory-nominate.cjs: nominated and not yet drafted).
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
const { standing, isRejected } = require('./report-marks.cjs');
const { relationFacts, judgedPair } = require('./memory-relate.cjs');
const { nominationsForScope, countFor } = require('./memory-nominate.cjs');
const { openProposals } = require('./proposal-open.cjs');

const fwd = p => String(p).split('\\').join('/');
const TEXT_CUT = 1500;
const REPORTS_SHOWN = 5;
const cut = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };

const COLS = 'id, namespace, type, worker_id, written_by, run_id, task_id, title, text, text_hash, embedding_model, dim, text_template, body, status, status_receipt, created_at';
function load(E, id) {
  const r = E.store.p(`SELECT ${COLS} FROM memory_entries WHERE id = ?`).get(id);
  return r ? { ...r, b: parse(r.body) } : null;
}

// What the stages show of a note: the row's own fields and its body's facts. Model-written text is cut here and stays data.
function noteFacts(note) {
  const b = note.b;
  return {
    id: note.id, namespace: note.namespace, kind: b.kind || null, basis: b.basis || null, title: cut(note.title, 200), when: typeof b.when === 'string' ? cut(b.when, 200) : null, text: cut(note.text, TEXT_CUT),
    evidence: (b.evidence || []).slice(0, 5), applies_to: b.applies_to || [], subjects: b.subjects || [],
    written_by: note.written_by, worker_id: note.worker_id || null, task_id: note.task_id || null, run_id: note.run_id || null,
    status: note.status || 'unverified', status_receipt: note.status_receipt || null, created_at: note.created_at,
    held: b.held ? { row: b.held.row, kind: b.held.kind, of: b.held.of || null, run_id: b.held.run_id } : null,
    seen_total: b.seen_total || 0,
  };
}

// What the scrub receipts say about the ids: `owed` are ids an earlier scrub could not do and no later scrub has handled (the last event
// naming the id decides; `unjudged` counts the times in a row a scrub's child gave the id no entry); `handled` maps an id a scrub of THIS
// run already handled to when, so the run's scope does not offer it again unless a newer report came in after (a second scrub of the
// same run, by hand, does not spend a second model call on the same reports, and never hides a later report). An owed id is always offered.
function scrubHistory(E, runId) {
  const owed = new Map(), handled = new Map(), unjudged = new Map(), dropped = new Map();
  let evs;
  try { evs = E.store.p("SELECT kind, ok, row_ids, run_id, code, message, written_at FROM memory_event WHERE kind IN ('scrub_owed', 'scrub_job') ORDER BY seq").all(); } catch { return { owed, handled, dropped }; }
  for (const ev of evs) {
    if (ev.kind === 'scrub_job' && !(ev.ok === 1 || ev.ok === true)) continue;
    let ids = [];
    try { ids = JSON.parse(ev.row_ids) || []; } catch { ids = []; }
    for (const id of ids) {
      if (ev.kind === 'scrub_owed' && ev.code === 'E_DROPPED') { dropped.set(id, ev.written_at || 0); owed.delete(id); unjudged.delete(id); } else if (ev.kind === 'scrub_owed') {
        const n = ev.code === 'E_UNJUDGED' ? (unjudged.get(id) || 0) + 1 : ev.code === 'E_INTERRUPTED' ? (unjudged.get(id) || 0) : 0;
        unjudged.set(id, n);
        owed.set(id, { run_id: ev.run_id, code: ev.code || null, message: cut(ev.message, 200), unjudged: n });
        handled.delete(id);
      } else { owed.delete(id); if (ev.run_id === runId) handled.set(id, ev.written_at || 0); }
    }
  }
  return { owed, handled, dropped };
}

// When the note's newest COUNTED independent sighting (the promotion step's own counting: not shown the note beforehand, one per task
// and writer) was recorded; 0 when it has none. A dropped nomination comes back when this passes the drop.
async function newestCountedSighting(E, noteId) {
  const row = E.store.p('SELECT id, task_id, run_id, written_by, created_at, status, body FROM memory_entries WHERE id = ?').get(noteId);
  if (!row) return 0;
  let counted;
  try { counted = await countFor(E, row); } catch { return 0; }
  const keys = new Set(counted.keys);
  let newest = keys.has(`${row.task_id}|${row.written_by}`) ? row.created_at || 0 : 0;
  for (const s of (parse(row.body).seen_in || [])) if (s && keys.has(`${s.task_id}|${s.written_by}`)) newest = Math.max(newest, Number(s.at) || 0);
  return newest;
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
  // A report a reviewer rejected is shown as such, with the reviewer's reason: it names no pair and opens no gate (report-marks.cjs).
  const rejection = w => { const j = (b.report_rejected || []).find(x => x && x.task_id === w.task_id && x.report_at === w.at); return { rejected: true, rejected_by: (j && j.by) || null, rejected_reason: j ? cut(j.reason, 300) : null }; };
  const reports = (b.reported_wrong || []).slice(-REPORTS_SHOWN).map(w => ({ ...(isRejected(b, w) ? rejection(w) : {}), by: w.by, worker_id: w.worker_id || null, task_id: w.task_id || null, run_id: w.run_id || null, why: cut(w.why, 500), replaced_by: w.replaced_by || null, at: w.at || null }));
  const matches = (b.matches || []).map(m => ({ id: m.id, similarity: m.similarity }));
  const related = [];
  for (const rid of new Set([...reports.map(r => r.replaced_by), ...matches.map(m => m.id)].filter(x => typeof x === 'string' && x !== note.id))) {
    const r = load(E, rid);
    if (r && r.type === 'note') related.push(noteFacts(r));
  }
  const workers = [...reports.map(r => r.worker_id), note.worker_id];
  return { id: note.id, state: note.namespace.startsWith('pending/') ? 'pending' : 'live', why: [...why], note: noteFacts(note), reports, matches, related, streams: streamsOf(E, workers) };
}

const ORDER = { owed: 0, replaced_by: 1, pending: 2, matched: 3, nominated: 4 };

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
    if (why === 'owed' && note.namespace === N.projectNs(project) && note.b.held) return; // a held note waits on a reviewer
    byId.set(note.id, { ...item(E, note, [why]), ...(extra || {}) });
  };
  const history = scrubHistory(E, runId);
  // In propose mode a mark that is already an open proposal waits on the operator and is not offered (and proposed) again at every close; in
  // apply mode an open proposal changes nothing, so a project switched to apply takes the same notes up again. Nominations are not covered.
  const proposeMode = ((N.notesLevers(E, caller) || {}).scrub_action) === 'propose';
  const proposals = proposeMode ? openProposals(E, project) : [];
  const proposedOn = (id, since = 0) => proposals.some((p) => p.note_id === id && p.at >= since);
  const proposedPairSince = (a, b, since) => proposals.some((p) => p.at >= since && ((p.note_id === a && p.of === b) || (p.note_id === b && p.of === a)));
  const proposedPair = (a, b) => proposals.some((p) => (p.note_id === a && p.of === b) || (p.note_id === b && p.of === a));
  for (const [id, o] of history.owed) add(load(E, id), 'owed', { owed: o });
  // A pair a scrub of this run handled is offered again when a report naming a partner arrived after that scrub.
  const addNew = (id, why, extra) => {
    const at = history.handled.get(id);
    if (at !== undefined) {
      const note = load(E, id);
      const newest = Math.max(0, ...(note ? standing(note.b) : []).filter((w) => w && w.run_id === runId && w.replaced_by).map((w) => Number(w.at) || 0));
      if (why !== 'replaced_by' || newest <= at) return;
    }
    add(load(E, id), why, extra);
  };
  // A live partner: in the project, not refuted, not superseded by another row (the relation gate refuses those, so they are not offered).
  const liveNote = (id) => {
    const n = load(E, id);
    if (!n || n.type !== 'note' || n.namespace !== N.projectNs(project) || (n.status || 'unverified') === 'refuted') return null;
    return E.store.p('SELECT 1 AS x FROM memory_entries WHERE supersedes = ? AND namespace = ?').get(id, n.namespace) ? null : n;
  };
  // A `new` verdict holds only while both notes still have the text, vector model, dimension and template it was made on.
  const judged = judgedPair;
  const reported = E.store.p(`SELECT id FROM memory_entries WHERE type = 'note' AND namespace = ? AND EXISTS
    (SELECT 1 FROM json_each(memory_entries.body, '$.reported_wrong') WHERE json_extract(value, '$.run_id') = ? AND json_extract(value, '$.replaced_by') IS NOT NULL) ORDER BY created_at, id`).all(N.projectNs(project), runId);
  for (const r of reported) {
    const n = load(E, r.id);
    // Each partner a standing report of this run names, with the time of the newest such report. The note is offered while some live partner has
    // no open proposal on THAT pair made since its newest report: a proposal about another partner of the note says nothing about this one.
    const newest = new Map();
    for (const w of standing(n.b)) if (w && w.run_id === runId && w.replaced_by && w.replaced_by !== n.id && w.by !== n.written_by) newest.set(w.replaced_by, Math.max(newest.get(w.replaced_by) || 0, Number(w.at) || 0));
    if (!n.b.held && [...newest].some(([id, at]) => liveNote(id) && !proposedPairSince(r.id, id, at))) addNew(r.id, 'replaced_by');
  }
  // Pending notes stay in scope until settled: this run's, and an ended run's (a scrub of its own close may have only proposed, or left
  // the note out). A live run's other pending notes are its writers' to resolve. A note the child gave no entry for in two scrubs is dropped.
  const pending = E.store.p(`SELECT id, run_id FROM memory_entries WHERE type = 'note' AND namespace = ? AND (run_id = ? OR run_id IN
    (SELECT r.id FROM run r WHERE r.ended_at IS NOT NULL AND r.seq = (SELECT MAX(seq) FROM run WHERE id = r.id))) ORDER BY created_at, id`).all(N.pendingNs(project), runId);
  for (const r of pending) if (!proposedOn(r.id) && (r.run_id === runId || !history.dropped.has(r.id))) addNew(r.id, 'pending');
  // Live notes whose stored embed matches have not been judged: a partner is a live note and neither side recorded a `new` verdict on the pair.
  const threshold = (N.notesLevers(E, caller) || {}).notes_match_threshold;
  const withMatches = E.store.p(`SELECT id FROM memory_entries WHERE type = 'note' AND namespace = ? AND json_array_length(COALESCE(json_extract(body, '$.matches'), '[]')) > 0 ORDER BY created_at, id`).all(N.projectNs(project));
  for (const r of withMatches) {
    const n = load(E, r.id);
    if (n.b.held) continue;
    // Offered only when the relation gate would pass the pair (the same function): a pair every verdict would be refused is not offered.
    const passes = (id) => { try { relationFacts(E, project, n.id, id, threshold, runId); return true; } catch { return false; } };
    const open = (n.b.matches || []).some((m) => m && m.id !== n.id && liveNote(m.id) && !judged(n, liveNote(m.id)) && !judged(liveNote(m.id), n) && !proposedPair(n.id, m.id) && passes(m.id));
    if (open) addNew(n.id, 'matched');
  }
  for (const nom of nominationsForScope(E, project) || []) {
    const { id: nid, ...facts } = nom;
    // A nominated note the scrubber declined to draft in two scrubs stops being offered, in any run, until it has a new COUNTED independent
    // sighting after the drop. (A nomination is never re-written while it is open, so its own time says nothing about news.)
    const droppedAt = history.dropped.get(nid);
    if (droppedAt !== undefined && !((await newestCountedSighting(E, nid)) > droppedAt)) continue;
    addNew(nid, 'nominated', { nomination: facts });
  }
  const items = [...byId.values()].sort((a, b) => Math.min(...a.why.map(w => ORDER[w])) - Math.min(...b.why.map(w => ORDER[w])));
  const counts = { items: items.length, owed: 0, replaced_by: 0, pending: 0, matched: 0, nominated: 0 };
  for (const it of items) for (const w of it.why) counts[w] += 1;
  return { project, run_id: runId, items, counts };
}

async function reviewQueue(E, caller, args) {
  C.allowKeys(args || {}, [], 'memory.reviewQueue');
  const project = M.projectOf(E, caller);
  if (!project) throw err('E_ARGS', 'memory.reviewQueue: this run has no project, so there is no held queue', { field: 'project' });
  const rows = E.store.p(`SELECT id, run_id, created_at, body FROM memory_entries WHERE namespace = ? AND type = 'held' AND written_by = 'harness'
    AND json_extract(body, '$.state') = 'held' ORDER BY created_at, id`).all(L.nsOf('held', project));
  const held = [];
  for (const r of rows) {
    const b = parse(r.body);
    const note = load(E, b.note_id);
    if (!note || note.namespace !== N.projectNs(project)) continue; // a hold whose note left the project is the apply-time refusal's business
    const of = b.of ? load(E, b.of) : null;
    let waited = 0;
    try { waited = Number(E.store.p('SELECT COUNT(DISTINCT id) AS n FROM run WHERE project = ? AND COALESCE(started_at, written_at) > ?').get(project, r.created_at).n); } catch { waited = 0; }
    held.push({
      // A duplicate that rests on a worker's report shows the reports naming the kept note, so same_claim is judged with the fact in front of it.
      ...(b.kind === 'duplicate' && b.of ? { duplicate_reports: (note.b.reported_wrong || []).filter(w => w && w.replaced_by === b.of).slice(0, REPORTS_SHOWN).map(w => ({ by: w.by, why: cut(w.why, 500), replaced_by: w.replaced_by })) } : {}),
      held_row: r.id, id: note.id, kind: b.kind, of: b.of || null, ground: b.ground, reason: cut(b.reason, 500), cites: b.cites || [], facts: b.facts || null,
      run_id: b.run_id || r.run_id, head_sha: b.head_sha || null, marked_at: r.created_at, runs_waited: waited,
      target_review_verified: (note.status || 'unverified') === 'verified' && String(note.status_receipt || '').startsWith('review:'),
      // A duplicate is judged on both notes in full, so their text is not cut.
      note: b.kind === 'duplicate' ? { ...noteFacts(note), text: note.text } : noteFacts(note),
      of_note: of ? (b.kind === 'duplicate' ? { ...noteFacts(of), text: of.text } : noteFacts(of)) : null,
    });
  }
  const counts = { count: held.length, max_runs_waited: held.reduce((m, h) => Math.max(m, h.runs_waited), 0), review_verified: held.filter(h => h.target_review_verified).length };
  return { project, run_id: caller.run_id, held, counts };
}

module.exports = { scrubScope, reviewQueue, noteFacts, scrubHistory };
