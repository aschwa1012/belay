'use strict';
// memory-archive.cjs — the moves of the notes lifecycle, all synchronous and called inside the caller's transaction:
// a note leaves project/<p> (or pending/<p>) for archive/<p> keeping its id, and a note archived as a duplicate hands
// its sightings and delivery history to the note it duplicates, as if it had been resolved `repeats` that note.
// Nothing here deletes a row; only the operator's purge does, and it covers archive/ alone.

const { fitBody, SEEN_MAX } = require('./methods-memory-notes.cjs');
const { parse } = require('./memory-facts.cjs');

const HISTORY_KEEP = 50; // delivery entries kept on the kept note, newest; the full count is in merged_from
const MERGED_KEEP = 20;
const EVENT_KINDS = ['index_injected', 'note_chance'];

// The namespace's model binding is carried to the new namespace as memory.promote does, so a search of it still works.
function bindNamespace(E, ns, row) {
  if (!row.embedding_model) return;
  const m = E.store.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns);
  if (!m) E.store.p('INSERT INTO namespace_models(namespace, embedding_model, dim) VALUES (?, ?, ?)').run(ns, row.embedding_model, row.dim);
}

// The receipts that put row `id` in front of a worker: belay's own ledger of what the index (and, once recorded, each
// chance) held. The ledger is append-only and is not rewritten; the entries are copied to the kept note's body.
function deliveriesOf(E, id) {
  const out = [];
  for (const kind of EVENT_KINDS) {
    let found;
    try {
      found = E.store.p("SELECT run_id, worker_id, task_id, row_ids, written_at FROM memory_event WHERE kind = ? AND ok = 1 AND row_ids LIKE ? ESCAPE '\\'")
        .all(kind, `%"${id.replace(/[\\%_]/g, c => `\\${c}`)}"%`);
    } catch { continue; } // a store without the ledger, or without these columns, has no history to move
    for (const ev of found) {
      let ids = [];
      try { ids = JSON.parse(ev.row_ids) || []; } catch { /* unreadable: not counted */ }
      if (Array.isArray(ids) && ids.includes(id)) out.push({ from: id, kind, run_id: ev.run_id, worker_id: ev.worker_id, task_id: ev.task_id, at: ev.written_at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// B's sightings and delivery history go to A. B keeps nothing of them (they are not counted twice), and A records
// where they came from. Returns what moved.
function transferHistory(E, B, A, meta) {
  const bb = B.b;
  const at = Date.now();
  const moved = (Array.isArray(bb.seen_in) ? bb.seen_in : []).map(s => ({ ...s, transferred_from: B.id }));
  // As with `repeats`: the same writer in the same task as A is one observation, not a second sighting.
  const own = !(A.task_id === B.task_id && A.written_by === B.written_by);
  const sighting = own ? { task_id: B.task_id, written_by: B.written_by, run_id: B.run_id, in_index_beforehand: null, at, evidence: (bb.evidence || []).slice(0, 3), transferred_from: B.id } : null;
  const total = (Number.isInteger(bb.seen_total) ? bb.seen_total : moved.length) + (own ? 1 : 0);
  const deliveries = deliveriesOf(E, B.id);
  E.store.patchBody(A.id, b => {
    b.seen_in = [...(b.seen_in || []), ...moved, ...(sighting ? [sighting] : [])].slice(-SEEN_MAX);
    b.seen_total = (b.seen_total || 0) + total;
    b.delivery_history = [...(b.delivery_history || []), ...deliveries].slice(-HISTORY_KEEP);
    b.merged_from = [...(b.merged_from || []), {
      id: B.id, at, seen_total: total, seen_in: moved.length + (sighting ? 1 : 0), deliveries: deliveries.length, run_id: meta.run_id || null, review: meta.receipt || null,
    }].slice(-MERGED_KEEP);
    return fitBody(b);
  });
  E.store.patchBody(B.id, b => { b.seen_in = []; b.seen_total = 0; return b; });
  return { to: A.id, seen_total: total, seen_in: moved.length + (sighting ? 1 : 0), deliveries: deliveries.length };
}

// Moves the note to archive/<project>. `meta` is what the archive records: { kind, of, ground, reason, cites, run_id,
// head_sha, held_row, receipt, direct }. For a duplicate with `of`, the history moves to `of` first.
function archiveNote(E, project, note, meta, kept) {
  const to = `archive/${project}`;
  const from = note.namespace;
  const transfer = meta.kind === 'duplicate' && kept ? transferHistory(E, note, kept, meta) : null;
  bindNamespace(E, to, note);
  E.store.moveRow(note.id, from, to);
  const at = Date.now();
  E.store.patchBody(note.id, b => {
    b.state = 'archived';
    b.archived = {
      at, from, kind: meta.kind, of: meta.of || null, ground: meta.ground || null, reason: meta.reason, cites: meta.cites || [], run_id: meta.run_id || null,
      head_sha: meta.head_sha || null, held_row: meta.held_row || null, review: meta.receipt || null, direct: !!meta.direct, ...(transfer ? { history_moved: transfer } : {}),
    };
    delete b.held; delete b.matches;
    return fitBody(b);
  });
  return { at, to, from, history_moved: transfer };
}

module.exports = { archiveNote, transferHistory, deliveriesOf, bindNamespace, parse };
