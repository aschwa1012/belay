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
const NP = require('./note-paths.cjs');
const M = require('./methods-memory.cjs');
const { search } = require('./memory-search.cjs');
const { hashText } = require('./store.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');
const { DEFAULTS } = require('./memory-levers.cjs');

const SEEN_MAX = 20; // body.seen_in is bounded; body.seen_total keeps the full count
const WRONG_KEEP = 20;
const NOTE_BODY_MAX = 4096; // a note as written
const BODY_CEILING = 8192; // a note with its sightings and reports; the oldest of those go first
const pendingNs = project => `pending/${project}`;
const projectNs = project => `project/${project}`;
const round3 = x => Math.round(x * 1000) / 1000;
const size = o => Buffer.byteLength(JSON.stringify(o), 'utf8');

// The run's levers when `notes` is on, else null. A read of the caller's own run row.
function notesLevers(E, caller) {
  const o = M.leversOf(E, caller);
  // A stored block is the parsed one with every key, but a missing key reads as its default and never as "no limit".
  return o && o.notes === true ? { ...DEFAULTS, ...o } : null;
}

// A body with sightings and reports is kept under BODY_CEILING by dropping the oldest of those.
function fitBody(b) {
  while (size(b) > BODY_CEILING && ((b.seen_in || []).length || (b.reported_wrong || []).length)) {
    if ((b.seen_in || []).length >= (b.reported_wrong || []).length) b.seen_in.shift(); else b.reported_wrong.shift();
  }
  return b;
}

// Live notes of the project that are close to this text, best first, at most `notes_match_n`. The semantic cosine
// is the similarity (a hybrid score is a rank fusion and says nothing about how alike two notes are). A semantic
// search that cannot run is refused by name, so there is no silent fallback.
// Only rows whose vector was made from the same template as `emb` are compared: the threshold was measured on v1 text and is
// unvalidated on v2, and a v2 vector against a v1 one is not a like comparison. (`template` defaults to v2, the template of a new note.)
async function findMatches(E, caller, project, emb, lv, template = NT.TEMPLATE_NEW) {
  const out = await search(E, caller, {
    namespace: projectNs(project), mode: 'semantic', view: 'full', k: Math.min(50, lv.notes_match_n * 5), min_score: lv.notes_match_threshold,
    query_embedding: emb.embedding, embedding_model: emb.embedding_model,
    filter: { types: ['note'], statuses: ['unverified', 'verified'] },
  });
  const ids = out.results.map(r => r.id);
  const tpl = new Map(ids.length ? E.store.p(`SELECT id, COALESCE(text_template, 'v1') AS t FROM memory_entries WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids).map(r => [r.id, r.t]) : []);
  return out.results
    .filter(r => typeof r.score === 'number' && r.score >= lv.notes_match_threshold && tpl.get(r.id) === template)
    .map(r => ({ id: r.id, title: r.title, kind: r.body && r.body.kind, basis: r.body && r.body.basis, similarity: round3(r.score), template, embedding_model: emb.embedding_model, dim: emb.dim }))
    .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1)).slice(0, lv.notes_match_n);
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
  const wrong = NT.checkReportedWrong(args.reported_wrong);
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
  // The model the worker was launched on, as the substrate reported it for the process belay spawned. Never from a note.
  const model = (worker && worker.model) || null;
  const prepared = [];
  // Under `keyword` an embedder failure never fails the hand-back: a note whose text cannot be embedded is stored without a
  // vector (the schema allows it), so keyword search finds it; it has no semantic neighbours checked, and the result says so.
  // applies_to is derived here from the worktree's diff and the evidence, merged with what the worker stated (note-paths.cjs).
  const diff = notes.length ? await NP.workerDiff(worker && worker.worktree, worker && worker.base_sha) : null;
  const keywordMode = E.embedderMode() === 'keyword';
  let embedFailed = null;
  for (const [i, n] of notes.entries()) {
    // Project rows are always scrubbed (ADR 0040 section 3); a title made longer by redaction is refused like any long one.
    const ap = NP.merge(n, diff, worker && worker.worktree);
    const s = M.scrub(true, { text: NT.keywordText({ ...n, applies_to: ap.applies_to }), title: n.title, body: { when: n.when, evidence: n.evidence, applies_to: ap.applies_to, applies_to_from: ap.applies_to_from, task_files: ap.task_files, task_files_from: 'diff', task_files_truncated: ap.task_files_truncated, ...(ap.ambiguous.length ? { applies_to_ambiguous: ap.ambiguous } : {}), subjects: n.subjects } });
    const checked = NT.checkNote({ ...n, title: s.title, when: s.body.when }, i);
    const title = checked.title;
    const embedTxt = NT.embedText({ title, when: checked.when }, NT.TEMPLATE_NEW); // what the vector is made from; the keyword text is s.text
    // Only what the worker wrote counts toward the limit; belay's derived fields (applies_to from the diff, task_files) are bounded by bytes in note-paths.cjs.
    const written = { when: s.body.when, evidence: s.body.evidence, applies_to: s.body.applies_to.filter((_, k) => s.body.applies_to_from[k] === 'worker'), subjects: s.body.subjects };
    if (size(written) > NOTE_BODY_MAX) throw err('E_NOTE_SHAPE', `notes[${i}]: the when, evidence, applies_to and subjects you wrote come to ${size(written)} bytes and the limit is ${NOTE_BODY_MAX}`, { index: i, max: NOTE_BODY_MAX });
    let emb = null;
    if (!embedFailed) {
      try { emb = await M.withEmbedding(E, { text: embedTxt }, 'embedding', 'text', caller); } catch (e) {
        if (!keywordMode) throw e; // only the embedding step is in this try, so any error here is the embedder's
        embedFailed = { code: e.code, message: e.message };
      }
    }
    const matches = emb ? await findMatches(E, caller, project, emb, lv) : [];
    prepared.push({ index: i, kind: n.kind, basis: n.basis, title, text: s.text, body: s.body, redactions: s.redactions, emb: emb || {}, template: NT.TEMPLATE_NEW, applies: { ...ap.counts, ...(diff && diff.error ? { diff_error: diff.error } : {}) }, unembedded: embedFailed, matches, model });
  }
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
  const items = prep.notes.map(p => {
    const pending = p.matches.length > 0;
    const ns = pending ? pendingNs(prep.project) : projectNs(prep.project);
    const clash = E.store.p('SELECT id, type, written_by FROM memory_entries WHERE namespace = ? AND text_hash = ?').get(ns, hashText(p.text));
    if (clash) {
      return { index: p.index, id: clash.id, action: 'duplicate', state: 'duplicate', namespace: ns, title: p.title, existing_type: clash.type, same_writer: clash.written_by === by, note: `${ns} already holds a ${clash.type} row with this text${clash.written_by === by ? '' : ' (another writer\'s)'}, so nothing was written and there is nothing for you to resolve` };
    }
    const body = {
      kind: p.kind, basis: p.basis, when: p.body.when, evidence: p.body.evidence, applies_to: p.body.applies_to, applies_to_from: p.body.applies_to_from, task_files: p.body.task_files, task_files_from: p.body.task_files_from, task_files_truncated: p.body.task_files_truncated, ...(p.body.applies_to_ambiguous ? { applies_to_ambiguous: p.body.applies_to_ambiguous } : {}), subjects: p.body.subjects,
      model: p.model, state: pending ? 'pending' : 'live', seen_in: [], seen_total: 0, reported_wrong: [],
      ...(pending ? { matches: p.matches } : {}),
    };
    const row = E.store.storeIn({
      namespace: ns, worker_id: E.writtenBy(caller), type: 'note', text: p.text, title: p.title, body, redactions: p.redactions,
      embedding: p.emb.embedding, embedding_model: p.emb.embedding_model, embedding_revision: p.emb.embedding_revision, dim: p.emb.dim, text_template: p.template,
      run_id: caller.run_id, task_id, source: 'model', written_by: by,
    });
    return { index: p.index, id: row.id, action: row.action, state: pending ? 'pending' : 'stored', namespace: ns, title: p.title, applies_to: p.applies, ...(pending ? { matches: p.matches } : {}), ...(p.unembedded ? { embedded: false, embedder_failure: p.unembedded, note: 'stored without a vector (on_embedder_failure keyword): found by keyword search, and not compared with the other notes of the project' } : {}) };
  });
  const marked = prep.wrong.map(w => {
    const m = NT.SELF_REF.exec(w.replaced_by || '');
    // notes[i] names the row this call wrote; a duplicate is somebody else's row (or not a note), so it is never a replacement.
    const mine = m ? items[Number(m[1])] : null;
    const replacedBy = m ? (mine.state === 'stored' || mine.state === 'pending' ? mine.id : null) : w.replaced_by;
    // The fact of a report, not a verdict: the scrubber decides (ADR 0047 decision 3). One report per writer per
    // note, so a writer's repeat replaces its own and never pushes out another writer's.
    const next = E.store.patchBody(w.id, b => {
      b.reported_wrong = [...(b.reported_wrong || []).filter(x => x.by !== by), { by, worker_id: caller.worker_id, task_id, run_id: caller.run_id, why: w.why, replaced_by: replacedBy, at: t }].slice(-WRONG_KEEP);
      return fitBody(b);
    });
    return { id: w.id, marked: 'reported_wrong', reports: next.reported_wrong.length, replaced_by: replacedBy };
  });
  const pending = items.filter(i => i.state === 'pending').length;
  return {
    notes: items, reported_wrong: [...marked, ...(prep.skipped || [])], pending,
    ...(prep.memoryIds ? { memory_ids: require('./memory-chances.cjs').recordApplied(E, caller, prep, task_id) } : {}),
    ...(pending ? { next: 'resolve each pending note with memory_note_resolve: new, repeats <id>, or supersedes <id> with evidence' } : {}),
  };
}

// ---- memory.noteResolve --------------------------------------------------------------------------------------

// Whether belay had put `targetId` in the first-message index of this writer before the pending note was written,
// from belay's own `index_injected` receipts for that worker. null when the worker has none at all (the index lever
// was off): then nothing says. Only the index is recorded; a search result handed to the writer is not, so it is not
// counted, and priming from the repository or an orchestrator's relay is invisible.
function inIndexBeforehand(E, pending, targetId) {
  let events;
  try {
    events = E.store.p("SELECT row_ids FROM memory_event WHERE kind = 'index_injected' AND ok = 1 AND run_id = ? AND worker_id = ? AND written_at <= ?").all(pending.run_id, pending.worker_id, pending.created_at);
  } catch { return null; }
  if (!events.length) return null;
  return events.some(ev => { try { return JSON.parse(ev.row_ids).includes(targetId); } catch { return false; } });
}

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
      if (x.resolve === 'refines') {
        // The same lesson plus a caveat: the new note goes live, the old one is archived as superseded (restorable), and the old
        // note's sightings and delivery history move to the new one, as a duplicate's do, so the lesson is counted once.
        release(E, r, project);
        E.store.patchBody(r.id, b => { b.state = 'live'; b.resolved = { as: 'refines', of: target.id, ...(x.evidence ? { evidence: x.evidence } : {}), at: t, by }; delete b.matches; return b; });
        const A = require('./memory-archive.cjs');
        const done = A.archiveNote(E, project, require('./memory-facts.cjs').loadNote(E, target.id),
          { kind: 'superseded', relation: 'refines', refines: true, via: 'refines', of: r.id, ground: 'replaced_by_newer', reason: 'resolved as refines', run_id: caller.run_id, direct: true },
          require('./memory-facts.cjs').loadNote(E, r.id));
        return { id: r.id, resolved: 'refines', of: target.id, state: 'live', namespace: projectNs(project), old_archived_as: done.to, history_moved: done.history_moved };
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

module.exports = { prepare, commit, resolve, claimAfterRelease, notesLevers, findMatches, SEEN_MAX, fitBody, release, bodyOf, projectNs, pendingNs };
