'use strict';
// methods-memory-notes.cjs — ADR 0047 decisions 2 to 5: notes handed back on `lease.release`, the two-step write
// against near-duplicates, `reported_wrong`, and `memory.noteResolve`.
//
// A note is a memory row of type `note`. A note with no close match is stored in `project/<project>`. A note with
// matches is stored `pending` in `pending/<project>`: kept, but outside the namespace the index and the search read,
// so nothing more is needed to keep it out of both. The lease is released either way; the result lists each pending
// note with its matches, and one `memory.noteResolve` call settles them. Unresolved pending notes stay where they
// are for the scrubber, which is not built. A sighting is recorded when a writer resolves a pending note as a repeat;
// no count here ever reaches a ranking.
//
// Order of work in a release: every check and every embedding first (nothing written, the lease still held, so a
// refusal can be retried), then one transaction that releases the lease and writes the notes and the marks.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const NT = require('./memory-notes.cjs');
const NW = require('./note-write.cjs');
const { fitBody, findMatches, inIndexBeforehand, projectNs, pendingNs, SEEN_MAX } = NW;
const M = require('./methods-memory.cjs');
const WH = require('./memory-withhold.cjs');
const { hashText } = require('./store.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');
const { loadNote } = require('./memory-facts.cjs');
const { redact } = require('./redact.cjs');


// The run's levers when `notes` is on, else null. A read of the caller's own run row.
function notesLevers(E, caller) {
  const o = M.leversOf(E, caller);
  // A stored block is the parsed one with every key, but a missing key reads as its default and never as "no limit".
  return o && o.notes === true ? { ...DEFAULTS, ...o } : null;
}
function leversUnread(E, caller) {
  try { return !!E.store.p("SELECT 1 AS x FROM memory_event WHERE kind = 'levers_unread' AND run_id = ? AND worker_id = ?").get(caller.run_id, caller.worker_id); } catch { return false; }
}

// Everything about a hand-back that can be checked and embedded before anything is written. Returns null when the
// call carries no notes business (lever off, no notes, no marks), else the prepared hand-back.
async function prepare(E, caller, args) {
  const given = args.notes !== undefined || args.reported_wrong !== undefined || args.memory_ids !== undefined;
  if (caller.role !== 'worker') {
    if (given) throw err('E_ARGS', 'lease.release: an operator release hands nothing back; notes, reported_wrong and memory_ids belong to the worker holding the lease');
    return null;
  }
  // ADR 0034 amendment 1: with the run's memory off, a hand-back drops its notes and marks and still releases the lease.
  if (given && E.memoryOff('memory.store') === 'refuse') {
    return { dropped: { reason: 'memory is off for this run (on_embedder_failure off, after an embedder failure), so the notes and reported_wrong were not written', notes: Array.isArray(args.notes) ? args.notes.length : 0, reported_wrong: Array.isArray(args.reported_wrong) ? args.reported_wrong.length : 0 } };
  }
  const lv = notesLevers(E, caller);
  if (!lv) {
    if (given) throw err('E_LEVER_OFF', 'lease.release: notes, reported_wrong and memory_ids need the run\'s memory.notes lever, and this run has it off', { lever: 'notes' });
    return null;
  }
  // A worker whose spawn could not read the levers was launched without --notes and without the contract (the manager
  // recorded a levers_unread receipt for it): it never saw the field, so a release without it is the ordinary one.
  if (args.notes === undefined && args.reported_wrong === undefined && args.memory_ids === undefined && leversUnread(E, caller)) return null;
  if (args.notes === undefined) throw err('E_ARGS', 'lease.release: notes is required in this run ([] when there is nothing to share)', { field: 'notes' });
  const project = M.projectOf(E, caller);
  if (!project) throw err('E_ARGS', 'lease.release: this run has no project, so there is nowhere to write a note', { field: 'notes' });
  const notes = NT.checkNotes(args.notes);
  // A report's reason is redacted once, here: the redacted text is the only one stored on the note and copied to the hold, shown in the index line and returned.
  const wrong = NT.checkReportedWrong(args.reported_wrong).map(w => { const r = redact(w.why); return { ...w, why: r.text, redacted: Object.values(r.redactions || {}).reduce((a, b) => a + b, 0) }; });
  const memoryIds = NT.checkMemoryIds(args.memory_ids); // the note ids applied, or null when the field was not given
  // With the notes sink on the field is required ([] when none applied), as notes is. A second call on an already
  // released lease (the reflection turn) carries only notes and is exempt.
  if (memoryIds === null && lv.notes_sink && lv.notes_sink !== 'off') {
    const l = args.lease_id ? rows.current(E.store, 'lease', args.lease_id) : null;
    if (!l || l.released_at == null) throw err('E_ARGS', 'lease.release: memory_ids is required in this run (the ids of the notes you applied, [] when none)', { field: 'memory_ids' });
  }
  // A report on a note that is no longer live in the project (archived, pending, gone) is skipped and returned as such; the release goes on.
  const skipped = [];
  for (const [i, w] of [...wrong.entries()].reverse()) {
    const r = E.store.p('SELECT id, namespace, type FROM memory_entries WHERE id = ?').get(w.id);
    if (!r || r.type !== 'note' || r.namespace !== projectNs(project)) {
      skipped.unshift({ id: w.id, skipped: 'not_live', state: r && r.type === 'note' ? r.namespace.split('/')[0] : 'missing' });
      wrong.splice(i, 1);
      continue;
    }
    const m = NT.SELF_REF.exec(w.replaced_by || '');
    if (m && Number(m[1]) >= notes.length) throw err('E_ARGS', `reported_wrong[${i}].replaced_by names ${w.replaced_by} and this call has ${notes.length} notes`, { field: 'reported_wrong', index: i });
  }
  const worker = rows.current(E.store, 'worker', caller.worker_id);
  const prepared = await NW.prepareNotes(E, caller, notes, { project, lv, worker });
  const verdict = args.result && typeof args.result === 'object' && typeof args.result.verdict === 'string' ? args.result.verdict : null;
  return { project, lv, notes: prepared, wrong, skipped, memoryIds, verdict };
}

// A second `lease.release` on a released lease may add notes only in a run that asked for the reflection turn, and
// once per lease: the claim is a receipt written in the same transaction as the notes.
function claimAfterRelease(E, caller, prep, lease, taskId) {
  prep.late = true; // memory_ids given now are recorded as late: the task's chances were written at the first release
  if (!prep.lv.notes_reflection) {
    throw err('E_ARGS', `lease.release: lease ${lease.id} was already released, and a released lease takes notes again only in a run with memory.notes_reflection`, { lease_id: lease.id });
  }
  const key = `lease:${lease.id}`;
  if (E.store.p("SELECT 1 AS x FROM memory_event WHERE kind = 'reflection' AND key = ? AND ok = 1").get(key)) {
    throw err('E_EXISTS', `lease ${lease.id} has already taken its notes after the release; that is once per lease`, { lease_id: lease.id });
  }
  recordEventSync(E, caller, { kind: 'reflection', key, worker_id: caller.worker_id, task_id: taskId, ok: true, message: `notes after the release of lease ${lease.id}` });
}

// Inside the release's transaction. Writes the notes and the marks and returns the proof of each. A note whose
// text is already a row of the target namespace is never written over: the existing row is named as a duplicate.
function commit(E, caller, prep, { task_id }) {
  const t = Date.now();
  const by = E.memoryWriter(caller);
  const items = NW.commitNotes(E, caller, prep, { task_id });
  const marked = prep.wrong.map(w => {
    // The target is read again here, in the transaction: preparation awaited an embedding and a diff, and the note may have been archived,
    // resolved, moved or purged meanwhile (and the reflection turn's second release comes through here too). A note that is no longer live in the
    // project takes no mark and no hold.
    const live = loadNote(E, w.id);
    if (!live || live.type !== 'note' || live.namespace !== projectNs(prep.project)) {
      return { id: w.id, skipped: 'not_live', state: live && live.type === 'note' ? live.namespace.split('/')[0] : 'missing' };
    }
    const m = NT.SELF_REF.exec(w.replaced_by || '');
    // notes[i] names the row this call wrote; a duplicate is somebody else's row (or not a note), so it is never a replacement.
    const mine = m ? items[Number(m[1])] : null;
    const replacedBy = m ? (mine.state === 'stored' || mine.state === 'pending' ? mine.id : null) : w.replaced_by;
    // The note is held at once, in this transaction, for the archive review (the report itself keeps the worker's identity).
    const out = require('./note-report-in.cjs').reportIn(E, caller, { note: w.id, project: prep.project, by, worker_id: caller.worker_id, task_id, run_id: caller.run_id, why: w.why, replaced_by: replacedBy, threshold: prep.lv.notes_match_threshold, headSha: require('./note-report-verdicts.cjs').headOf(E, task_id), refused: 'so the release is refused' });
    return { id: w.id, marked: 'reported_wrong', reports: out.reports, replaced_by: replacedBy, ...(w.redacted ? { redacted: w.redacted } : {}), held: out.held };
  });
  const pending = items.filter(i => i.state === 'pending').length;
  return {
    notes: items, reported_wrong: [...marked, ...(prep.skipped || [])], pending,
    ...(prep.memoryIds ? { memory_ids: require('./memory-chances.cjs').recordApplied(E, caller, prep, task_id) } : {}),
    ...(pending ? { next: 'resolve each pending note with memory_note_resolve: new, repeats <id>, or supersedes <id> with evidence (a note with prior_verdicts is close to a claim already judged wrong: resolve it as new only if yours is different)' } : {}),
  };
}

// ---- memory.noteResolve --------------------------------------------------------------------------------------

const COLS = 'id, namespace, type, worker_id, written_by, run_id, task_id, text, text_hash, embedding_model, dim, text_template, body, status, created_at';
const bodyOf = r => { try { return r.body ? JSON.parse(r.body) : {}; } catch { return {}; } };

function loadPending(E, caller, id, i) {
  const r = E.store.p(`SELECT ${COLS} FROM memory_entries WHERE id = ?`).get(id);
  if (!r || r.type !== 'note') throw err('E_NOT_FOUND', `resolutions[${i}]: no note ${id}`, { id });
  if (!r.namespace.startsWith('pending/')) throw err('E_NOT_FOUND', `resolutions[${i}]: note ${id} is not pending (it is in ${r.namespace}), so there is nothing to resolve`, { id, namespace: r.namespace });
  if (caller.role === 'worker' && (r.written_by !== E.memoryWriter(caller) || r.run_id !== caller.run_id)) {
    throw err('E_ROLE', `resolutions[${i}]: note ${id} was not written by this worker in this run, and a worker resolves only its own`, { id, role: caller.role });
  }
  if (caller.role === 'orchestrator') {
    const mine = M.projectOf(E, caller);
    if (!mine || r.namespace !== pendingNs(mine)) throw err('E_ROLE', `resolutions[${i}]: note ${id} is not in this run's project`, { id, role: caller.role });
  }
  return r;
}

// The live note a pending one is resolved against. It must be one of the matches belay returned for that note, a
// note of the project, not refuted and not already replaced; a worker may replace only a note that is not verified
// (ADR 0040: a worker supersedes only what it could also delete).
function liveTarget(E, caller, pending, project, x, i) {
  const at = `resolutions[${i}]`;
  const listed = (bodyOf(pending).matches || []).map(m => m.id);
  if (!listed.includes(x.of)) throw err('E_ARGS', `${at}: ${x.of} is not one of the matches returned for note ${pending.id} (${listed.join(', ') || 'none'}); a note is resolved against the notes it was matched with`, { id: pending.id, of: x.of, matches: listed });
  const r = E.store.p(`SELECT ${COLS} FROM memory_entries WHERE id = ?`).get(x.of);
  if (!r || r.type !== 'note' || r.namespace !== projectNs(project)) throw err('E_NOT_FOUND', `${at}: ${x.of} is not a live note of project ${project}`, { id: x.of });
  if ((r.status || 'unverified') === 'refuted') throw err('E_ARGS', `${at}: note ${x.of} is refuted`, { id: x.of });
  const gone = E.store.p('SELECT id FROM memory_entries WHERE supersedes = ? AND namespace = ?').get(x.of, r.namespace);
  if (gone) throw err('E_ARGS', `${at}: note ${x.of} was superseded by ${gone.id}; resolve against ${gone.id}`, { id: x.of, superseded_by: gone.id });
  // A note held on a report is in dispute: a repeat would record agreement with it and a supersedes would bury it. Matching shows it so a
  // restated claim waits in pending; the writer resolves that as new, or reports the held note.
  if ((x.resolve === 'repeats' || x.resolve === 'supersedes') && WH.heldReported(E).get(r.id) === project) {
    throw err('E_ARGS', `${at}: note ${x.of} is held for review after a report that it is wrong, so it cannot be ${x.resolve === 'repeats' ? 'repeated' : 'superseded'}; resolve as new, or report it`, { id: x.of, reason: 'held_for_review' });
  }
  // A held note is hidden by nobody but the archive review and the operator: a refines or supersedes of it is refused here, naming the hold.
  // (A repeat only adds a sighting and hides nothing, so it is allowed.)
  if (x.resolve === 'supersedes' || x.resolve === 'refines') require('./held-guard.cjs').check(E, x.resolve, r.id, { resolution: x.resolve });
  if ((x.resolve === 'supersedes' || x.resolve === 'refines') && caller.role === 'worker' && r.status === 'verified') {
    throw err('E_ROLE', `${at}: note ${x.of} is verified, and a worker may not ${x.resolve === 'refines' ? 'refine' : 'supersede'} a verified note (a repeat of it is fine)`, { id: x.of, role: caller.role });
  }
  return r;
}

// Moves a pending note into the project: a row already there with the same text is E_EXISTS naming it and what it is.
// The namespace's model binding is carried over as memory.promote does.
function release(E, r, project) {
  const ns = projectNs(project);
  const dup = E.store.p('SELECT id, type FROM memory_entries WHERE namespace = ? AND text_hash = ? AND id != ?').get(ns, r.text_hash, r.id);
  if (dup) {
    const how = dup.type === 'note' ? `resolve it as repeats ${dup.id}` : `${dup.id} is a ${dup.type} row, not a note: resolve it as new with a changed title`;
    throw err('E_EXISTS', `note ${r.id} has the same text as ${dup.id} in ${ns}; ${how}`, { id: r.id, existing_id: dup.id, existing_type: dup.type });
  }
  if (r.embedding_model) {
    const m = E.store.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns);
    if (!m) E.store.p('INSERT INTO namespace_models(namespace, embedding_model, dim) VALUES (?, ?, ?)').run(ns, r.embedding_model, r.dim);
    else if (m.embedding_model !== r.embedding_model || m.dim !== r.dim) throw err('E_MODEL', `namespace ${ns} is bound to ${m.embedding_model}/${m.dim} and note ${r.id} carries ${r.embedding_model}/${r.dim}`, { namespace: ns, bound: m });
  }
  E.store.moveRow(r.id, r.namespace, ns);
}

// resolve new with a changed title: the first line of the text and the title change together, and the hash with them.
function retitle(E, r, title, fresh) {
  const s = M.scrub(true, { text: [title, ...r.text.split('\n').slice(1)].join('\n'), title });
  const clash = E.store.p('SELECT id, type FROM memory_entries WHERE namespace = ? AND text_hash = ? AND id != ?').get(r.namespace, hashText(s.text), r.id);
  if (clash) throw err('E_EXISTS', `the changed title makes note ${r.id} the same text as ${clash.id} (a ${clash.type} row) in ${r.namespace}; choose another title or resolve it as repeats`, { id: r.id, existing_id: clash.id, existing_type: clash.type });
  E.store.p('UPDATE memory_entries SET title = ?, text = ?, text_hash = ?, updated_at = ? WHERE id = ?').run(s.title, s.text, hashText(s.text), Date.now(), r.id);
  // The vector was made from the old title, so it is replaced by one made from the new, under the row's own template.
  if (fresh && fresh.unembedded) {
    E.store.clearEmbedding(r.id);
    return { ...r, title: s.title, text: s.text, text_hash: hashText(s.text), embedding_model: null, dim: null, text_template: null };
  }
  if (fresh) E.store.replaceEmbedding(r.id, fresh);
  return { ...r, title: s.title, text: s.text, text_hash: hashText(s.text) };
}

// Before the transaction (embedding is async): the new vector of each note a resolve retitles. A note with no vector has none to replace.
async function freshVectors(E, caller, list) {
  const out = new Map();
  for (const [i, x] of list.entries()) {
    if (x.resolve !== 'new' || !x.title) continue;
    const r = loadPending(E, caller, x.id, i);
    if (r.embedding_model == null) continue;
    const s = M.scrub(true, { text: [x.title, ...r.text.split('\n').slice(1)].join('\n'), title: x.title });
    const template = r.text_template || 'v1';
    const text = template === 'v2' ? NT.embedText({ title: s.title, when: bodyOf(r).when }, 'v2') : s.text;
    let e;
    try { e = await M.withEmbedding(E, { text }, 'embedding', 'text', caller); } catch (failure) {
      // required: the failure stands (withEmbedding has told the run's guard, which pauses it). keyword: the retitle goes on and the
      // note is left without a vector; a stale one is never kept under the new title.
      if (E.embedderMode() !== 'keyword') throw failure;
      out.set(r.id, { unembedded: { code: failure.code, message: failure.message } });
      continue;
    }
    out.set(r.id, { embedding: e.embedding, embedding_model: e.embedding_model, embedding_revision: e.embedding_revision, dim: e.dim, text_template: template });
  }
  return out;
}

async function resolve(E, caller, args) {
  const list = NT.checkResolutions(args.resolutions);
  if (caller.role !== 'operator' && !notesLevers(E, caller)) throw err('E_LEVER_OFF', 'memory.noteResolve needs the run\'s memory.notes lever, and this run has it off', { lever: 'notes' });
  const t = Date.now();
  const by = E.memoryWriter(caller);
  const fresh = await freshVectors(E, caller, list);
  const out = E.store.tx(() => {
    E.assertRunOpen(caller, 'memory.noteResolve'); // the new vectors were awaited above (audit D42)
    const projects = new Set();
    const done = list.map((x, i) => {
      let r = loadPending(E, caller, x.id, i);
      const project = r.namespace.slice('pending/'.length);
      projects.add(project);
      if (x.resolve === 'new') {
        const vector = x.title ? fresh.get(r.id) : null;
        if (x.title) r = retitle(E, r, x.title, vector);
        release(E, r, project);
        E.store.patchBody(r.id, b => { b.state = 'live'; b.resolved = { as: 'new', at: t, by }; delete b.matches; return b; });
        return { id: r.id, resolved: 'new', state: 'live', namespace: projectNs(project), ...(vector && vector.unembedded ? { embedded: false, embedder_failure: vector.unembedded, note: 'the title changed and the embedder failed (on_embedder_failure keyword), so the old vector was dropped and the note has none: it is found by keyword search, and belay memory embed will embed it from its new title' } : {}) };
      }
      const target = liveTarget(E, caller, r, project, x, i);
      const VH = require('./memory-verified-hold.cjs');
      const tnote = require('./memory-facts.cjs').loadNote(E, target.id);
      if (VH.mustHold(caller, tnote, x.resolve)) {
        // A verified note is never hidden without the reviewer: the new note goes live and the old one is held for the on-demand reviewer.
        if (tnote.b.held) throw err('E_EXISTS', `resolutions[${i}]: note ${target.id} is already held (${tnote.b.held.row}); the reviewer settles it first`, { id: target.id, held_row: tnote.b.held.row });
        release(E, r, project);
        E.store.patchBody(r.id, b => { b.state = 'live'; b.resolved = { as: x.resolve, of: target.id, ...(x.evidence ? { evidence: x.evidence } : {}), at: t, by, held_for_review: true }; delete b.matches; return b; });
        const held = VH.holdVerified(E, caller, project, tnote, r.id, x.resolve, `resolved as ${x.resolve}`, x.evidence, require('./note-report-verdicts.cjs').headOf(E, r.task_id));
        return { id: r.id, resolved: x.resolve, of: target.id, state: 'live', namespace: projectNs(project), held_for_review: held.id, note: 'the old note is review-verified, so it is held for the reviewer and not archived' };
      }
      if (x.resolve === 'refines') {
        // The same lesson plus a caveat: the new note goes live, the old one is archived as superseded (restorable), and the old
        // note's sightings and delivery history move to the new one, as a duplicate's do, so the lesson is counted once.
        release(E, r, project);
        E.store.patchBody(r.id, b => { b.state = 'live'; b.resolved = { as: 'refines', of: target.id, ...(x.evidence ? { evidence: x.evidence } : {}), at: t, by }; delete b.matches; return b; });
        const A = require('./memory-archive.cjs');
        const done = A.archiveNote(E, project, require('./memory-facts.cjs').loadNote(E, target.id),
          { kind: 'superseded', relation: 'refines', refines: true, via: 'refines', of: r.id, ground: 'replaced_by_newer', reason: 'resolved as refines', run_id: caller.run_id, direct: true },
          require('./memory-facts.cjs').loadNote(E, r.id));
        return { id: r.id, resolved: 'refines', of: target.id, state: 'live', namespace: projectNs(project), old_archived_as: done.to, history_moved: done.history_moved, replaced_also_archived: done.replaced_also_archived };
      }
      if (x.resolve === 'supersedes') {
        release(E, r, project);
        E.store.setSupersedes(r.id, target.id);
        E.store.patchBody(r.id, b => { b.state = 'live'; b.resolved = { as: 'supersedes', of: target.id, evidence: x.evidence, at: t, by }; delete b.matches; return b; });
        E.store.patchBody(target.id, b => { b.superseded_by = r.id; return b; });
        return { id: r.id, resolved: 'supersedes', of: target.id, state: 'live', namespace: projectNs(project) };
      }
      // repeats: a sighting on the live note, and no new row. A note cannot be a sighting of itself: the same
      // writer in the same task is one observation, not two. The pending row was only the holding place: it moves to
      // archive/<project> (nothing is deleted), and the sighting keeps who saw it, when, and the evidence the writer gave.
      if (target.task_id === r.task_id && target.written_by === r.written_by) {
        throw err('E_ARGS', `resolutions[${i}]: note ${target.id} was written by the same writer in the same task, so this is not a second sighting of it`, { id: r.id, of: target.id });
      }
      const pb = bodyOf(r);
      const sighting = { task_id: r.task_id, written_by: r.written_by, run_id: r.run_id, in_index_beforehand: inIndexBeforehand(E, r, target.id), at: t, evidence: (pb.evidence || []).slice(0, 3), transferred_from: r.id };
      const next = E.store.patchBody(target.id, b => {
        b.seen_in = [...(b.seen_in || []), sighting].slice(-SEEN_MAX);
        b.seen_total = (b.seen_total || 0) + 1;
        b.merged_from = [...(b.merged_from || []), { id: r.id, at: t, seen_total: 1, seen_in: 1, deliveries: 0, own: true, run_id: r.run_id, review: null, via: 'repeats' }].slice(-20);
        return fitBody(b);
      });
      // The row keeps its id and its body, and a restore can bring it back to pending (the sighting then goes back too).
      const moved = { to: target.id, seen_total: 1, seen_in: 1, deliveries: 0 };
      require('./memory-archive.cjs').archiveNote(E, project, r, { kind: 'duplicate', of: target.id, ground: 'same_claim', reason: 'resolved as repeats', run_id: caller.run_id, direct: true, no_transfer: true, history_moved: moved }, target);
      return { id: r.id, resolved: 'repeats', of: target.id, sighting, seen_total: next.seen_total, pending_row_archived: true, archived_as: `archive/${project}` };
    });
    // The writer sees its own pending notes still open; the orchestrator and the operator see the project's.
    const left = caller.role === 'worker'
      ? E.store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'note' AND namespace LIKE 'pending/%' AND run_id = ? AND written_by = ?").get(caller.run_id, by).n
      : E.store.p(`SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'note' AND namespace IN (${[...projects].map(() => '?').join(', ')})`).get(...[...projects].map(pendingNs)).n;
    return { resolved: done, still_pending: Number(left) };
  });
  E.noteWrite();
  return out;
}

// Notes-bearing hand-backs of one project run one at a time (note-write.cjs holds the chain, shared with memory.store notes).
async function serialised(E, caller, args, fn) {
  const project = caller.role === 'worker' && args.notes !== undefined ? M.projectOf(E, caller) : null;
  return NW.serialised(E, project, fn);
}

module.exports = { serialised, prepare, commit, resolve, claimAfterRelease, notesLevers, findMatches, SEEN_MAX, fitBody, release, bodyOf, projectNs, pendingNs };
