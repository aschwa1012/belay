'use strict';
// methods-memory-notes.cjs — ADR 0047 decisions 2 to 5: notes handed back on `lease.release`, the two-step write
// against near-duplicates, `found_wrong`, and `memory.noteResolve`.
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
const M = require('./methods-memory.cjs');
const { search } = require('./memory-search.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');

const SEEN_MAX = 20; // body.seen_in is bounded; body.seen_total keeps the full count
const WRONG_KEEP = 20;
const pendingNs = project => `pending/${project}`;
const projectNs = project => `project/${project}`;
const round3 = x => Math.round(x * 1000) / 1000;

// The run's levers when `notes` is on, else null. A read of the caller's own run row.
function notesLevers(E, caller) {
  const o = M.leversOf(E, caller);
  // A stored block is the parsed one with every key, but a missing key reads as its default and never as "no limit".
  return o && o.notes === true ? { ...DEFAULTS, ...o } : null;
}

// The similarity a hit has to the query: the semantic half's cosine. The hybrid score is a rank fusion and says
// nothing about how alike two notes are, so it is never compared to the threshold.
function similarity(hit, ran) {
  if (typeof hit.cosine === 'number') return hit.cosine;
  return ran.length === 1 && ran[0] === 'semantic' ? hit.score : null;
}

// Live notes of the project that are close to this text, best first, at most `notes_match_n`.
async function findMatches(E, caller, project, text, emb, lv) {
  const out = await search(E, caller, {
    query: text, namespace: projectNs(project), mode: 'hybrid', view: 'full', k: 30,
    query_embedding: emb.embedding, embedding_model: emb.embedding_model,
    filter: { types: ['note'], statuses: ['unverified', 'verified'] },
  });
  const semFailed = (out.modes_failed || []).find(f => f.mode === 'semantic');
  if (semFailed) throw err(semFailed.code, `the near-duplicate check could not run (${semFailed.message}); no note was written and the lease is still held`, { stage: 'note-match' });
  const matches = [];
  for (const r of out.results) {
    const s = similarity(r, out.modes_run);
    if (s === null || s < lv.notes_match_threshold) continue;
    matches.push({ id: r.id, title: r.title, kind: r.body && r.body.kind, basis: r.body && r.body.basis, similarity: round3(s) });
  }
  return matches.sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1)).slice(0, lv.notes_match_n);
}

// Everything about a hand-back that can be checked and embedded before anything is written. Returns null when the
// call carries no notes business (lever off, no notes, no marks), else the prepared hand-back.
async function prepare(E, caller, args) {
  const given = args.notes !== undefined || args.found_wrong !== undefined;
  if (caller.role !== 'worker') {
    if (given) throw err('E_ARGS', 'lease.release: an operator release hands nothing back; notes and found_wrong belong to the worker holding the lease');
    return null;
  }
  const lv = notesLevers(E, caller);
  if (!lv) {
    if (given) throw err('E_LEVER_OFF', 'lease.release: notes and found_wrong need the run\'s memory.notes lever, and this run has it off', { lever: 'notes' });
    return null;
  }
  if (args.notes === undefined) throw err('E_ARGS', 'lease.release: notes is required in this run ([] when there is nothing to share)', { field: 'notes' });
  const project = M.projectOf(E, caller);
  if (!project) throw err('E_ARGS', 'lease.release: this run has no project, so there is nowhere to write a note', { field: 'notes' });
  const notes = NT.checkNotes(args.notes);
  const wrong = NT.checkFoundWrong(args.found_wrong);
  for (const [i, w] of wrong.entries()) {
    const r = E.store.p('SELECT id, namespace, type FROM memory_entries WHERE id = ?').get(w.id);
    if (!r || r.type !== 'note' || r.namespace !== projectNs(project)) {
      throw err('E_NOT_FOUND', `found_wrong[${i}]: ${w.id} is not a live note of project ${project}`, { id: w.id, field: 'found_wrong', index: i });
    }
    const m = NT.SELF_REF.exec(w.replaced_by || '');
    if (m && Number(m[1]) >= notes.length) throw err('E_ARGS', `found_wrong[${i}].replaced_by names ${w.replaced_by} and this call has ${notes.length} notes`, { field: 'found_wrong', index: i });
  }
  const worker = rows.current(E.store, 'worker', caller.worker_id);
  // The model the worker was launched on, as the substrate reported it for the process belay spawned. Never from a note.
  const model = (worker && worker.model) || null;
  const prepared = [];
  for (const [i, n] of notes.entries()) {
    // Project rows are always scrubbed (ADR 0040 section 3); a title made longer by redaction is refused like any long one.
    const s = M.scrub(true, { text: NT.noteText(n), title: n.title, body: { evidence: n.evidence, applies_to: n.applies_to, subjects: n.subjects } });
    const title = NT.checkNote({ ...n, title: s.title }, i).title;
    const emb = await M.withEmbedding(E, { text: s.text }, 'embedding', 'text', caller);
    const matches = await findMatches(E, caller, project, s.text, emb, lv);
    prepared.push({ index: i, kind: n.kind, basis: n.basis, title, text: s.text, body: s.body, redactions: s.redactions, emb, matches, model });
  }
  return { project, notes: prepared, wrong };
}

// Inside the release's transaction. Writes the notes and the marks and returns the proof of each.
function commit(E, caller, prep, { task_id }) {
  const t = Date.now();
  const by = E.memoryWriter(caller);
  const items = prep.notes.map(p => {
    const pending = p.matches.length > 0;
    const ns = pending ? pendingNs(prep.project) : projectNs(prep.project);
    const body = {
      kind: p.kind, basis: p.basis, evidence: p.body.evidence, applies_to: p.body.applies_to, subjects: p.body.subjects,
      model: p.model, state: pending ? 'pending' : 'live', seen_in: [], seen_total: 0, reported_wrong: [],
      ...(pending ? { matches: p.matches } : {}),
    };
    const row = E.store.storeIn({
      namespace: ns, worker_id: E.writtenBy(caller), type: 'note', text: p.text, title: p.title, body, redactions: p.redactions,
      embedding: p.emb.embedding, embedding_model: p.emb.embedding_model, embedding_revision: p.emb.embedding_revision, dim: p.emb.dim,
      run_id: caller.run_id, task_id, source: 'model', written_by: by,
    });
    return { index: p.index, id: row.id, action: row.action, state: pending ? 'pending' : 'stored', namespace: ns, title: p.title, ...(pending ? { matches: p.matches } : {}) };
  });
  const marked = prep.wrong.map(w => {
    const m = NT.SELF_REF.exec(w.replaced_by || '');
    const replacedBy = m ? items[Number(m[1])].id : w.replaced_by;
    // The fact of a report, not a verdict: the scrubber decides (ADR 0047 decision 3).
    const next = E.store.patchBody(w.id, b => {
      b.reported_wrong = [...(b.reported_wrong || []), { by, worker_id: caller.worker_id, task_id, run_id: caller.run_id, why: w.why, replaced_by: replacedBy, at: t }].slice(-WRONG_KEEP);
      return b;
    });
    return { id: w.id, marked: 'reported_wrong', reports: next.reported_wrong.length, replaced_by: replacedBy };
  });
  const pending = items.filter(i => i.state === 'pending').length;
  return {
    notes: items, found_wrong: marked, pending,
    ...(pending ? { next: 'resolve each pending note with memory_note_resolve: new, repeats <id>, or supersedes <id> with evidence' } : {}),
  };
}

// ---- memory.noteResolve --------------------------------------------------------------------------------------

// Whether belay had put `targetId` in front of the writer before it wrote, from belay's own `index_injected`
// receipts for that worker. null when the worker has none at all (the index lever was off): then nothing says.
// A search result handed to the writer is not recorded anywhere, so it is not counted.
function shownBeforehand(E, pending, targetId) {
  let events;
  try {
    events = E.store.p("SELECT row_ids FROM memory_event WHERE kind = 'index_injected' AND ok = 1 AND run_id = ? AND worker_id = ?").all(pending.run_id, pending.worker_id);
  } catch { return null; }
  if (!events.length) return null;
  return events.some(ev => { try { return JSON.parse(ev.row_ids).includes(targetId); } catch { return false; } });
}

const COLS = 'id, namespace, type, worker_id, written_by, run_id, task_id, text_hash, embedding_model, dim, body';
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

function liveTarget(E, project, of, i) {
  const r = E.store.p(`SELECT ${COLS} FROM memory_entries WHERE id = ?`).get(of);
  if (!r || r.type !== 'note' || r.namespace !== projectNs(project)) throw err('E_NOT_FOUND', `resolutions[${i}]: ${of} is not a live note of project ${project}`, { id: of });
  return r;
}

// Moves a pending note into the project: a text already there is E_EXISTS (it is a repeat, not a new note), and the
// namespace's model binding is carried over as memory.promote does.
function release(E, r, project) {
  const ns = projectNs(project);
  const dup = E.store.p('SELECT id FROM memory_entries WHERE namespace = ? AND text_hash = ? AND id != ?').get(ns, r.text_hash, r.id);
  if (dup) throw err('E_EXISTS', `note ${r.id} has the same text as ${dup.id} in ${ns}; resolve it as repeats ${dup.id}`, { id: r.id, existing_id: dup.id });
  if (r.embedding_model) {
    const m = E.store.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get(ns);
    if (!m) E.store.p('INSERT INTO namespace_models(namespace, embedding_model, dim) VALUES (?, ?, ?)').run(ns, r.embedding_model, r.dim);
    else if (m.embedding_model !== r.embedding_model || m.dim !== r.dim) throw err('E_MODEL', `namespace ${ns} is bound to ${m.embedding_model}/${m.dim} and note ${r.id} carries ${r.embedding_model}/${r.dim}`, { namespace: ns, bound: m });
  }
  E.store.moveRow(r.id, r.namespace, ns);
}

async function resolve(E, caller, args) {
  const list = NT.checkResolutions(args.resolutions);
  if (caller.role !== 'operator' && !notesLevers(E, caller)) throw err('E_LEVER_OFF', 'memory.noteResolve needs the run\'s memory.notes lever, and this run has it off', { lever: 'notes' });
  const t = Date.now();
  const by = E.memoryWriter(caller);
  const out = E.store.tx(() => {
    const done = list.map((x, i) => {
      const r = loadPending(E, caller, x.id, i);
      const project = r.namespace.slice('pending/'.length);
      if (x.resolve === 'new') {
        release(E, r, project);
        E.store.patchBody(r.id, b => { b.state = 'live'; b.resolved = { as: 'new', at: t, by }; return b; });
        return { id: r.id, resolved: 'new', state: 'live', namespace: projectNs(project) };
      }
      const target = liveTarget(E, project, x.of, i);
      if (x.resolve === 'supersedes') {
        release(E, r, project);
        E.store.setSupersedes(r.id, target.id);
        E.store.patchBody(r.id, b => { b.state = 'live'; b.resolved = { as: 'supersedes', of: target.id, evidence: x.evidence, at: t, by }; return b; });
        E.store.patchBody(target.id, b => { b.superseded_by = r.id; return b; });
        return { id: r.id, resolved: 'supersedes', of: target.id, state: 'live', namespace: projectNs(project) };
      }
      // repeats: a sighting on the live note, and no new row. The pending row was only the holding place, so it goes;
      // the sighting keeps who saw it, when, and the evidence the writer gave.
      const pb = bodyOf(r);
      const sighting = { task_id: r.task_id, written_by: r.written_by, run_id: r.run_id, shown_beforehand: shownBeforehand(E, r, target.id), at: t, evidence: (pb.evidence || []).slice(0, 3) };
      const next = E.store.patchBody(target.id, b => {
        b.seen_in = [...(b.seen_in || []), sighting].slice(-SEEN_MAX);
        b.seen_total = (b.seen_total || 0) + 1;
        return b;
      });
      E.store.p('DELETE FROM memory_entries WHERE id = ?').run(r.id);
      E.store.cache.delete(r.namespace);
      return { id: r.id, resolved: 'repeats', of: target.id, sighting, seen_total: next.seen_total, pending_row_removed: true };
    });
    const left = E.store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'note' AND namespace LIKE 'pending/%' AND run_id = ? AND written_by = ?").get(caller.run_id, by).n;
    return { resolved: done, still_pending: Number(left) };
  });
  E.noteWrite();
  return out;
}

module.exports = { prepare, commit, resolve, notesLevers, findMatches, SEEN_MAX };
