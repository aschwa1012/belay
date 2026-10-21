'use strict';
// memory-archive.cjs — the moves of the notes lifecycle, all synchronous and called inside the caller's transaction:
// a note leaves project/<p> (or pending/<p>) for archive/<p> keeping its id, and a note archived as a duplicate hands
// its sightings and delivery history to the note it duplicates, as if it had been resolved `repeats` that note.
// Nothing here deletes a row; only the operator's purge does, and it covers archive/ alone.

const { fitBody, SEEN_MAX } = require('./methods-memory-notes.cjs');
const { parse, loadNote, isHeldNow } = require('./memory-facts.cjs');

const HISTORY_KEEP = 50; // delivery entries kept on the kept note, newest; the full count is in merged_from
const MERGED_KEEP = 20;
const EVENT_KINDS = ['note_chance', 'index_injected']; // a chance is the richer record, so it is read first and wins a tie

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
  // One delivery is one (task, worker, route): the same index delivery is recorded both by index_injected and by a
  // note_chance, and is copied once.
  const seen = new Set();
  for (const kind of EVENT_KINDS) {
    let found;
    try {
      found = E.store.p("SELECT run_id, worker_id, task_id, row_ids, message, written_at FROM memory_event WHERE kind = ? AND ok = 1 AND row_ids LIKE ? ESCAPE '\\'")
        .all(kind, `%"${id.replace(/[\\%_]/g, c => `\\${c}`)}"%`);
    } catch { continue; } // a store without the ledger, or without these columns, has no history to move
    for (const ev of found) {
      let ids = [];
      try { ids = JSON.parse(ev.row_ids) || []; } catch { /* unreadable: not counted */ }
      if (!(Array.isArray(ids) && ids.includes(id))) continue;
      let route = 'index';
      if (kind === 'note_chance') { try { route = JSON.parse(ev.message).route || 'index'; } catch { /* a chance without its route reads as the index */ } }
      const key = `${ev.task_id}|${ev.worker_id}|${route}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from: id, kind, route, run_id: ev.run_id, worker_id: ev.worker_id, task_id: ev.task_id, at: ev.written_at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Every moved row (a sighting, a delivery) records the notes that handed it on, oldest first, in `hops`; `transferred_from` (sightings)
// and `from` (deliveries) stay the LAST hop. A row that passes B -> A -> C is [B, A] on C, so a restore of any note on the path can find
// exactly the rows it handed over, wherever they now sit, and give back only those.
const hopsOf = (r, key) => (Array.isArray(r.hops) ? r.hops : (r[key] ? [r[key]] : []));
const hop = (r, id, key) => ({ ...r, hops: [...hopsOf(r, key), id], [key]: id });
const through = (r, id, key) => hopsOf(r, key).includes(id);

// B's sightings and delivery history go to A. B keeps nothing of them (they are not counted twice), and A records
// where they came from. A note already listed in A's merged_from has been handed over once and is not handed over
// again (a restored duplicate that is archived a second time). B's own delivery_history (what it took from notes archived into it)
// moves with it. Returns what moved.
function transferHistory(E, B, A, meta) {
  if ((A.b.merged_from || []).some(m => m && m.id === B.id)) return { to: A.id, seen_total: 0, seen_in: 0, deliveries: 0, already: true };
  const bb = B.b;
  const at = Date.now();
  const moved = (Array.isArray(bb.seen_in) ? bb.seen_in : []).map(s => hop(s, B.id, 'transferred_from'));
  // As with `repeats`: the same writer in the same task as A is one observation, not a second sighting; and a
  // sighting A already holds from this task and writer is not added again.
  const dupeOfA = (A.b.seen_in || []).some(s => s && s.task_id === B.task_id && s.written_by === B.written_by);
  const own = !(A.task_id === B.task_id && A.written_by === B.written_by) && !dupeOfA;
  const sighting = own ? { task_id: B.task_id, written_by: B.written_by, run_id: B.run_id, in_index_beforehand: null, at, evidence: (bb.evidence || []).slice(0, 3), transferred_from: B.id, hops: [B.id] } : null;
  const total = (Number.isInteger(bb.seen_total) ? bb.seen_total : moved.length) + (own ? 1 : 0);
  // A delivery B already carries in its history (a restore gives B its own back) is not read from the ledger a second time.
  const dKey = d => `${d.task_id}|${d.worker_id}|${d.route || 'index'}`;
  const carried = (bb.delivery_history || []).map(d => hop(d, B.id, 'from'));
  const have = new Set(carried.filter(d => d.hops[0] === B.id).map(dKey));
  const deliveries = [...carried, ...deliveriesOf(E, B.id).filter(d => !have.has(dKey(d))).map(d => ({ ...d, hops: [B.id] }))];
  E.store.patchBody(A.id, b => {
    b.seen_in = [...(b.seen_in || []), ...moved, ...(sighting ? [sighting] : [])].slice(-SEEN_MAX);
    b.seen_total = (b.seen_total || 0) + total;
    b.delivery_history = [...(b.delivery_history || []), ...deliveries].slice(-HISTORY_KEEP);
    b.merged_from = [...(b.merged_from || []), {
      id: B.id, at, seen_total: total, seen_in: moved.length + (sighting ? 1 : 0), deliveries: deliveries.length, own, run_id: meta.run_id || null, review: meta.receipt || null, ...(meta.via ? { via: meta.via } : {}),
    }].slice(-MERGED_KEEP);
    return fitBody(b);
  });
  E.store.patchBody(B.id, b => { b.seen_in = []; b.seen_total = 0; b.delivery_history = []; return b; });
  return { to: A.id, seen_total: total, seen_in: moved.length + (sighting ? 1 : 0), deliveries: deliveries.length };
}

const load = (E, id) => { const r = E.store.p('SELECT id, body FROM memory_entries WHERE id = ?').get(id); return r ? { id: r.id, b: JSON.parse(r.body || '{}') } : null; };

// The reverse, for a restore: exactly the rows B handed over (those whose hops pass through B) come back to B, wherever they now
// are. The holder is found by following the chain of archives: A took B's rows; if A was archived and handed its history to C, the
// rows are on C, and C's record of A is reduced by what leaves, so a later restore of A gives back exactly the rest. The count that
// leaves is B's own record of it (merged_from.seen_total), so a chain restored in any order ends at the same counts. A purged or
// absent holder has nothing to give back.
function untransfer(E, B) {
  const to = B.b.archived && B.b.archived.history_moved && B.b.archived.history_moved.to;
  if (!to) return null;
  const first = load(E, to);
  const entry = first && (first.b.merged_from || []).find(m => m && m.id === B.id);
  if (!entry) return null;
  const path = [first];
  for (let cur = first, n = 0; n < 50; n += 1) {
    const next = cur.b.archived && cur.b.archived.history_moved && cur.b.archived.history_moved.to;
    const nn = next && next !== cur.id ? load(E, next) : null;
    if (!nn || !(nn.b.merged_from || []).some(m => m && m.id === cur.id)) break;
    path.push(nn); cur = nn;
  }
  const holder = path[path.length - 1];
  let back = null;
  for (const n of path) {
    E.store.patchBody(n.id, b => {
      if (n === first) b.merged_from = (b.merged_from || []).filter(m => !(m && m.id === B.id));
      if (n !== first) { // the record of the previous note's handover shrinks by what leaves
        const prev = path[path.indexOf(n) - 1];
        const rec = (b.merged_from || []).find(m => m && m.id === prev.id);
        if (rec) rec.seen_total = Math.max(0, rec.seen_total - entry.seen_total);
      }
      if (n === holder) {
        const mine = (b.seen_in || []).filter(s => s && through(s, B.id, 'transferred_from'));
        back = { seen_total: Math.max(0, entry.seen_total - (entry.own ? 1 : 0)), seen_in: mine.filter(s => !(entry.own && s.task_id === B.task_id && s.written_by === B.written_by && hopsOf(s, 'transferred_from')[0] === B.id)).map(s => {
          const h = hopsOf(s, 'transferred_from'); const keep = h.slice(0, h.indexOf(B.id));
          const { transferred_from, hops, ...rest } = s;
          return keep.length ? { ...rest, transferred_from: keep[keep.length - 1], hops: keep } : rest;
        }) };
        b.seen_in = (b.seen_in || []).filter(s => !(s && through(s, B.id, 'transferred_from')));
        b.seen_total = Math.max(0, (b.seen_total || 0) - entry.seen_total);
        // The deliveries B handed over come back to B, each with its hops cut at B (with no earlier hop the delivery is B's own again: from = B, whatever notes carried it since).
        back.delivery_history = (b.delivery_history || []).filter(d => d && through(d, B.id, 'from')).map(d => {
          const h = hopsOf(d, 'from'); const keep = h.slice(0, h.indexOf(B.id));
          const { hops, ...rest } = d;
          return keep.length ? { ...rest, from: keep[keep.length - 1], hops: keep } : { ...rest, from: B.id };
        });
        b.delivery_history = (b.delivery_history || []).filter(d => !(d && through(d, B.id, 'from')));
      }
      return b;
    });
  }
  E.store.patchBody(B.id, b => { b.seen_in = back.seen_in; b.seen_total = back.seen_total; b.delivery_history = [...(b.delivery_history || []), ...back.delivery_history].slice(-HISTORY_KEEP); return b; });
  const { delivery_history: givenBack, ...counts } = back;
  return { from: first.id, ...(holder !== first ? { held_by: holder.id } : {}), ...counts, deliveries: givenBack.length };
}

// A note archived while it carries an open hold ends that hold in the same transaction: the held row is closed with a receipt, so the
// count of open holds stays right and the reviewer is not asked about a note that is gone. The reviewer's own archive passes held_row.
function closeHold(E, note, meta) {
  const h = note.b && note.b.held;
  if (!h || !h.row || meta.held_row === h.row) return null;
  const entry = { receipt: meta.receipt || `relation:${meta.run_id || 'none'}:${note.id}`, at: Date.now(), outcome: 'closed', reason: `the note was archived by a ${meta.relation || meta.kind} (${meta.reason || 'no reason'}) while this hold was open` };
  E.store.patchBody(h.row, b => { b.reviews = [...(b.reviews || []), entry].slice(-20); b.state = 'closed'; b.closed_at = entry.at; return b; });
  return h.row;
}

// A note that replaced another (its `supersedes` column) hides it only while it sits in project/<p>: the gate, the index and search
// look for a superseding row in the same namespace. So when such a note leaves for archive/ and its claim lives on in another note (a
// duplicate or a refinement of the kept note, or a note replaced by a newer one), the note it replaced would come back beside the claim
// that displaced it. It is archived instead, as replaced by the kept note, and a restore can bring it back. A note archived as wrong
// (no kept note) leaves the old one visible again: its replacement was not true. The whole chain goes, however long (it is walked
// without recursion and stops only at a note that is not a project note, the kept note, or one already on the chain, so a cycle ends).
// Returns the ids archived (the replaced note, then any it had itself replaced), or an empty list.
function carryReplaced(E, project, note, meta, kept) {
  if (meta.kind === 'wrong' || note.namespace !== `project/${project}`) return { ids: [], stopped_at: null };
  const target = kept || (meta.of ? loadNote(E, meta.of) : null);
  if (!target) return { ids: [], stopped_at: null };
  const chain = [];
  let stoppedAt = null;
  const seen = new Set([note.id, target.id]);
  for (let cur = note; ;) {
    const col = E.store.p('SELECT supersedes FROM memory_entries WHERE id = ?').get(cur.id);
    const old = col && col.supersedes && !seen.has(col.supersedes) ? loadNote(E, col.supersedes) : null;
    if (!old || old.type !== 'note' || old.namespace !== `project/${project}`) break;
    // A held ancestor stays in project/ (visible again, still held): only the archive review or the operator archives it. The chain ends there.
    if (isHeldNow(E, old)) { stoppedAt = old.id; break; }
    seen.add(old.id); chain.push(old); cur = old;
  }
  // The deepest note leaves first, as when each archive carried the next; each records the ones that left with it.
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const replacer = i === 0 ? note : chain[i - 1];
    archiveNote(E, project, chain[i], {
      kind: 'superseded', of: target.id, ground: 'replaced_by_newer', direct: true, run_id: meta.run_id || null, via: 'replacement_archived', replaced_by_archived: replacer.id,
      carried_ids: chain.slice(i + 1).map(n => n.id),
      reason: `the note that replaced it (${replacer.id}) was archived as ${i === 0 ? meta.kind : 'superseded'} of ${target.id}, so ${target.id} stands in its place`,
    }, target);
  }
  return { ids: chain.map(n => n.id), stopped_at: stoppedAt };
}

// Moves the note to archive/<project>. `meta` is what the archive records: { kind, of, ground, reason, cites, run_id,
// head_sha, held_row, receipt, direct }. For a duplicate with `of`, the history moves to `of` first.
function archiveNote(E, project, note, meta, kept) {
  const to = `archive/${project}`;
  const from = note.namespace;
  // A duplicate hands its history to the kept note; so does a note replaced by one that refines it (the same lesson, so its
  // whole history belongs on the surviving note). A superseded note (a different lesson) keeps its history.
  const transfer = meta.history_moved || ((meta.kind === 'duplicate' || meta.refines) && kept && !meta.no_transfer ? transferHistory(E, note, kept, meta) : null);
  const closed = closeHold(E, note, meta);
  const carry = meta.carried_ids ? { ids: meta.carried_ids, stopped_at: null } : carryReplaced(E, project, note, meta, kept);
  const carried = carry.ids;
  bindNamespace(E, to, note);
  E.store.moveRow(note.id, from, to);
  const at = Date.now();
  E.store.patchBody(note.id, b => {
    b.state = 'archived';
    b.archived = {
      at, from, kind: meta.kind, of: meta.of || null, ground: meta.ground || null, reason: meta.reason, cites: meta.cites || [], run_id: meta.run_id || null,
      head_sha: meta.head_sha || null, held_row: meta.held_row || null, review: meta.receipt || null, direct: !!meta.direct, ...(closed ? { held_row_closed: closed } : {}), ...(carried.length ? { replaced_also_archived: carried[0] } : {}), ...(carry.stopped_at ? { carry_stopped_at: carry.stopped_at } : {}), ...(meta.replaced_by_archived ? { replaced_by_archived: meta.replaced_by_archived } : {}), ...(meta.relation ? { relation: meta.relation } : {}), ...(transfer ? { history_moved: transfer } : {}),
    };
    delete b.held;
    return fitBody(b);
  });
  return { at, to, from, history_moved: transfer, replaced_also_archived: carried };
}

module.exports = { archiveNote, transferHistory, untransfer, deliveriesOf, bindNamespace, parse };
