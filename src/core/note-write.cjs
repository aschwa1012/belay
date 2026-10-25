'use strict';
// note-write.cjs — the one way a note is checked, embedded, matched and written (ADR 0047). A hand-back (lease.release) and a project memory.store
// by a worker or the orchestrator are both note writes, and both come through prepareNotes (everything that can be checked and embedded before
// anything is written) and commitNotes (inside the caller's transaction). The release-only parts (role, off mode, levers, memory_ids, reports)
// stay in methods-memory-notes.cjs.

const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const NT = require('./memory-notes.cjs');
const NP = require('./note-paths.cjs');
const M = require('./methods-memory.cjs');
const { search } = require('./memory-search.cjs');
const { hashText } = require('./store.cjs');
const { storedCosine } = require('./memory-facts.cjs');
const WH = require('./memory-withhold.cjs');
const EC = require('./evaluate-cite.cjs');


const SEEN_MAX = 20; // body.seen_in is bounded; body.seen_total keeps the full count
const NOTE_BODY_MAX = 4096; // a note as written
const BODY_CEILING = 8192; // a note with its sightings and reports; the oldest of those go first
const pendingNs = project => `pending/${project}`;
const projectNs = project => `project/${project}`;
const round3 = x => Math.round(x * 1000) / 1000;
const size = o => Buffer.byteLength(JSON.stringify(o), 'utf8');
const bodyOf = r => { try { return r.body ? JSON.parse(r.body) : {}; } catch { return {}; } };

// A body with sightings and reports is kept under BODY_CEILING by dropping the oldest of those. `protect` is a report that was just submitted: it is
// never dropped (a report the release claims as marked must still be on the note when its hold is written). When only that report and the bodies' own
// optional payloads are left, the optional history goes first (rejections, dismissals, releases, restores, judgments, then the review's cites and reason).
const OPTIONAL = ['report_rejected', 'dismissed', 'releases', 'restored', 'report_judgments'];
function fitBody(b, protect = null, noteId = null) {
  const droppable = () => (b.reported_wrong || []).findIndex((w) => w !== protect);
  while (size(b) > BODY_CEILING && ((b.seen_in || []).length || droppable() >= 0)) {
    if ((b.seen_in || []).length >= (b.reported_wrong || []).length || droppable() < 0) b.seen_in.shift(); else b.reported_wrong.splice(droppable(), 1);
  }
  if (protect) {
    for (const k of OPTIONAL) { if (size(b) <= BODY_CEILING) break; if (Array.isArray(b[k]) && b[k].length) b[k] = []; }
    if (size(b) > BODY_CEILING && b.review && typeof b.review === 'object') b.review = { ...b.review, cites: [], reason: String(b.review.reason || '').slice(0, 120) };
    if (size(b) > BODY_CEILING) throw err('E_NOTE_SHAPE', `note ${noteId || '(unnamed)'} is too large to keep one more report on it (its body is over ${BODY_CEILING} bytes even without its optional history); the release is refused and nothing was written. Shorten the report text (reported_wrong[].why) and call lease_release again; if the note's own review payload is the cause, ask the operator to trim it`, { max: BODY_CEILING, id: noteId });
  }
  return require('./report-marks.cjs').pruneSettled(b); // a settled key leaves only together with its report
}

// Live notes of the project that are close to this text, best first, at most `notes_match_n`. The semantic cosine
// is the similarity (a hybrid score is a rank fusion and says nothing about how alike two notes are). A semantic
// search that cannot run is refused by name, so there is no silent fallback.
// Only rows whose vector was made from the same template as `emb` are compared: the threshold was measured on v1 text and is
// unvalidated on v2, and a v2 vector against a v1 one is not a like comparison. (`template` defaults to v2, the template of a new note.)
async function findMatches(E, caller, project, emb, lv, template = NT.TEMPLATE_NEW) {
  // Matching decides duplicates and delivers nothing, so it sees the notes withheld from the writer too; a close one is named by priorVerdicts.
  const out = await search(E, Object.assign({}, caller, { [WH.MATCHING]: true }), {
    namespace: projectNs(project), mode: 'semantic', view: 'full', k: Math.min(50, lv.notes_match_n * 5), min_score: lv.notes_match_threshold,
    query_embedding: emb.embedding, embedding_model: emb.embedding_model,
    filter: { types: ['note'], statuses: ['unverified', 'verified'] },
  });
  const ids = out.results.map(r => r.id);
  // A match the writer is withheld from is named by id and verdict only: the writer learns its text is close to a note under review, never its claim.
  const hidden = WH.withheldAmong(E, caller, out.results);
  const tpl = new Map(ids.length ? E.store.p(`SELECT id, COALESCE(text_template, 'v1') AS t FROM memory_entries WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids).map(r => [r.id, r.t]) : []);
  return out.results
    .filter(r => typeof r.score === 'number' && r.score >= lv.notes_match_threshold && tpl.get(r.id) === template)
    .map(r => (hidden.has(r.id)
      ? { id: r.id, verdict: 'held_for_review', similarity: round3(r.score), template, embedding_model: emb.embedding_model, dim: emb.dim }
      : { id: r.id, title: r.title, kind: r.body && r.body.kind, basis: r.body && r.body.basis, similarity: round3(r.score), template, embedding_model: emb.embedding_model, dim: emb.dim }))
    .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1)).slice(0, lv.notes_match_n);
}

// Claims the project already judged wrong that this text is close to: a refuted note of project/<p>, and a note archived as wrong in
// archive/<p>. A live search never returns them (it reads only unverified and verified notes of project/), so without this a worker that
// repeats a refuted claim writes it live with no step and no warning. Each is compared by the stored cosine, as a relation is (same model,
// dimension and text template), against the same threshold. A lookup, not a ranking: bounded, and it writes nothing.
const PRIOR_MAX = 2000;
function priorVerdicts(E, project, emb, lv, template = NT.TEMPLATE_NEW, caller = null) {
  // A held note is withheld from the writer, so a restated claim would find no match and be stored live beside the hold: it is compared here
  // too and the new note waits in pending (the writer resolves it as new, knowing that). It is named by id only: its title is the claim.
  const heldIds = caller && WH.withholds(E, caller) ? WH.noteIds(E, ['e.namespace = ?'], [projectNs(project)]) : [];
  const q = { embedding: Buffer.from(Float32Array.from(emb.embedding).buffer), dim: emb.dim, embedding_model: emb.embedding_model, text_template: template };
  const rows = E.store.p(`SELECT id, namespace, title, status, status_receipt, embedding, embedding_model, dim, text_template, body FROM memory_entries
    WHERE type = 'note' AND embedding IS NOT NULL AND ((namespace = ? AND status = 'refuted') OR (namespace = ? AND json_extract(body, '$.archived.kind') = 'wrong') OR id IN (SELECT value FROM json_each(?))) LIMIT ${PRIOR_MAX}`).all(projectNs(project), `archive/${project}`, JSON.stringify(heldIds));
  const out = [];
  for (const r of rows) {
    const cos = storedCosine(q, r);
    if (cos === null || cos < lv.notes_match_threshold) continue;
    const a = bodyOf(r).archived || {};
    if (heldIds.includes(r.id)) { out.push({ id: r.id, verdict: 'held_for_review', similarity: round3(cos), receipt: null }); continue; }
    out.push(r.status === 'refuted'
      ? { id: r.id, title: r.title, verdict: 'refuted', similarity: round3(cos), receipt: r.status_receipt || null }
      : { id: r.id, title: r.title, verdict: 'archived_wrong', similarity: round3(cos), ground: a.ground || null, reason: typeof a.reason === 'string' ? a.reason.slice(0, 300) : null, at: a.at || null });
  }
  return out.sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1)).slice(0, lv.notes_match_n);
}

// A hand-back whose note has exactly the text of a live note: a sighting on that note when the writer or the task is not the note's own and
// the pair is not already recorded. Returns { recorded, seen_total } or null when nothing was added.
function sightText(E, caller, clash, by, taskId, p, t) {
  if (clash.task_id === taskId && clash.written_by === by) return null;
  let seen = null;
  E.store.patchBody(clash.id, b => {
    if ((b.seen_in || []).some(s => s && s.task_id === taskId && s.written_by === by)) return b;
    const beforehand = inIndexBeforehand(E, { run_id: caller.run_id, worker_id: E.writtenBy(caller), created_at: t }, clash.id);
    b.seen_in = [...(b.seen_in || []), { task_id: taskId, written_by: by, run_id: caller.run_id, in_index_beforehand: beforehand, at: t, evidence: (p.body.evidence || []).slice(0, 3), via: 'same_text' }].slice(-SEEN_MAX);
    b.seen_total = (b.seen_total || 0) + 1;
    seen = b.seen_total;
    return fitBody(b);
  });
  return seen === null ? null : { recorded: true, seen_total: seen };
}

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

// The model a note is written under: the worker row's, as the substrate reported it for the process belay spawned, or for the orchestrator
// the run row's. Never from the arguments (invariant 3).
function modelOf(E, caller, worker) {
  if (caller.role === 'worker') return (worker && worker.model) || null;
  try { const run = rows.current(E.store, 'run', caller.run_id); return (run && run.orch_model) || null; } catch { return null; }
}

// Everything about a set of notes that can be checked and embedded before anything is written (nothing is written here, so a refusal can be
// retried). `notes` is the checked list (NT.checkNotes); `worker` is the worker row of a worker caller, null for the orchestrator, whose notes
// have no worktree diff (the diff would record a false diff_error). Returns the prepared items for commitNotes.
async function prepareNotes(E, caller, notes, { project, lv, worker }) {
  const model = modelOf(E, caller, worker);
  const prepared = [];
  // Under `keyword` an embedder failure never fails the write: a note whose text cannot be embedded is stored without a
  // vector (the schema allows it), so keyword search finds it; it has no semantic neighbours checked, and the result says so.
  // applies_to is derived here from the worktree's diff and the evidence, merged with what the writer stated (note-paths.cjs).
  const diff = caller.role === 'worker' && notes.length ? await NP.workerDiff(worker && worker.worktree, worker && worker.base_sha) : null;
  const keywordMode = E.embedderMode() === 'keyword';
  let embedFailed = null;
  for (const [i, n] of notes.entries()) {
    // Project rows are always scrubbed (ADR 0040 section 3); a title made longer by redaction is refused like any long one.
    const ap = NP.merge(n, diff, worker && worker.worktree, caller.role); // the writer's own paths carry its role (B10)
    const s = M.scrub(true, { text: NT.keywordText({ ...n, applies_to: ap.applies_to }), title: n.title, body: { when: n.when, evidence: n.evidence, applies_to: ap.applies_to, applies_to_from: ap.applies_to_from, task_files: ap.task_files, task_files_from: 'diff', task_files_truncated: ap.task_files_truncated, ...(ap.ambiguous.length ? { applies_to_ambiguous: ap.ambiguous } : {}), subjects: n.subjects } });
    const checked = NT.checkNote({ ...n, title: s.title, when: s.body.when }, i);
    // ADR 0057 decision 7: an evidence entry that cites a task_evaluate result is checked against it now; one that fails refuses the write.
    const evidenceChecked = EC.checkNoteEvidence(E, caller, n.evidence, i);
    const title = checked.title;
    const embedTxt = NT.embedText({ title, when: checked.when }, NT.TEMPLATE_NEW); // what the vector is made from; the keyword text is s.text
    // Only what the worker wrote counts toward the limit; belay's derived fields (applies_to from the diff, task_files) are bounded by bytes in note-paths.cjs.
    const written = { when: s.body.when, evidence: s.body.evidence, applies_to: s.body.applies_to.filter((_, k) => s.body.applies_to_from[k] === caller.role), subjects: s.body.subjects };
    if (size(written) > NOTE_BODY_MAX) throw err('E_NOTE_SHAPE', `notes[${i}]: the when, evidence, applies_to and subjects you wrote come to ${size(written)} bytes and the limit is ${NOTE_BODY_MAX}`, { index: i, max: NOTE_BODY_MAX });
    let emb = null;
    if (!embedFailed) {
      try { emb = await M.withEmbedding(E, { text: embedTxt }, 'embedding', 'text', caller); } catch (e) {
        if (!keywordMode) throw e; // only the embedding step is in this try, so any error here is the embedder's
        embedFailed = { code: e.code, message: e.message };
      }
    }
    const matches = emb ? await findMatches(E, caller, project, emb, lv) : [];
    const prior = emb ? priorVerdicts(E, project, emb, lv, NT.TEMPLATE_NEW, caller) : [];
    prepared.push({ index: i, evidenceChecked, kind: n.kind, basis: n.basis, title, text: s.text, body: s.body, redactions: s.redactions, emb: emb || {}, template: NT.TEMPLATE_NEW, applies: { ...ap.counts, ...(diff && diff.error ? { diff_error: diff.error } : {}) }, unembedded: embedFailed, matches, prior, model });
  }

  return prepared;
}

// Inside the caller's transaction. Writes the notes and returns the proof of each. A note whose text is already a row of the target namespace is
// never written over: the existing row is named as a duplicate.
function commitNotes(E, caller, prep, { task_id }) {
  const t = Date.now();
  const by = E.memoryWriter(caller);
  const items = prep.notes.map(p => {
    const pending = p.matches.length > 0 || p.prior.length > 0;
    const byText = n => E.store.p('SELECT id, type, written_by, task_id, status, EXISTS (SELECT 1 FROM memory_entries s WHERE s.supersedes = memory_entries.id AND s.namespace = memory_entries.namespace) AS replaced FROM memory_entries WHERE namespace = ? AND text_hash = ?').get(n, hashText(p.text));
    // A pending note is resolved against the notes it was matched with. The same words as a row of project/<p> that is not one of those matches
    // (a refuted note, a row that is not a note, a note not compared) could never be resolved, so it answers duplicate and no pending row is written.
    const inProject = pending ? byText(projectNs(prep.project)) : null;
    const unresolvable = inProject && !p.matches.some(m => m.id === inProject.id) ? inProject : null;
    const ns = unresolvable || !pending ? projectNs(prep.project) : pendingNs(prep.project);
    const clash = unresolvable || byText(ns);
    if (clash) {
      // The same words from another writer in another task are a second sighting of a live note, as a resolved repeat is: promotion counts them.
      // A refuted or replaced note is not live, so it takes no sighting, and the writer is told the row was judged against.
      const judged = clash.status === 'refuted' ? 'refuted' : (clash.replaced ? 'superseded' : null);
      const sighted = clash.type === 'note' && !judged && !pending ? sightText(E, caller, clash, by, task_id, p, t) : null;
      return { index: p.index, id: clash.id, action: 'duplicate', state: 'duplicate', namespace: ns, title: p.title, existing_type: clash.type, same_writer: clash.written_by === by, ...(judged ? { existing_status: judged } : {}), ...(p.prior.length ? { prior_verdicts: p.prior } : {}), ...(sighted ? { sighting: sighted } : {}), note: `${ns} already holds a ${clash.type} row with this text${clash.written_by === by ? '' : ' (another writer\'s)'}, so no new row was written${sighted ? ' (your hand-back is recorded as a sighting of it)' : ''}${judged === 'refuted' ? '; that note was judged wrong, so this is not agreement with your claim' : judged === 'superseded' ? '; that note was replaced by a newer one' : ''} and there is nothing for you to resolve` };
    }
    const body = {
      kind: p.kind, basis: p.basis, when: p.body.when, evidence: p.body.evidence, applies_to: p.body.applies_to, applies_to_from: p.body.applies_to_from, task_files: p.body.task_files, task_files_from: p.body.task_files_from, task_files_truncated: p.body.task_files_truncated, ...(p.body.applies_to_ambiguous ? { applies_to_ambiguous: p.body.applies_to_ambiguous } : {}), subjects: p.body.subjects,
      ...(p.evidenceChecked && p.evidenceChecked.length ? { evidence_checked: p.evidenceChecked } : {}),
      model: p.model, state: pending ? 'pending' : 'live', seen_in: [], seen_total: 0, reported_wrong: [],
      ...(p.matches.length ? { matches: p.matches } : {}),
      ...(p.prior.length ? { prior_verdicts: p.prior } : {}),
    };
    const row = E.store.storeIn({
      namespace: ns, worker_id: E.writtenBy(caller), type: 'note', text: p.text, title: p.title, body, redactions: p.redactions,
      embedding: p.emb.embedding, embedding_model: p.emb.embedding_model, embedding_revision: p.emb.embedding_revision, dim: p.emb.dim, text_template: p.template,
      run_id: caller.run_id, task_id, source: 'model', written_by: by,
    });
    return { index: p.index, id: row.id, action: row.action, state: pending ? 'pending' : 'stored', namespace: ns, title: p.title, applies_to: p.applies, ...(pending ? { matches: p.matches } : {}), ...(p.prior.length ? { prior_verdicts: p.prior, held_back: p.prior.some((x) => x.verdict === 'held_for_review') ? 'this text is close to a note that is held for review, disputed as wrong, superseded or a duplicate, and withheld from workers (see prior_verdicts, verdict held_for_review); the note waits in pending until you resolve it as new, knowing that' : 'this text is close to a claim already judged wrong (see prior_verdicts); the note waits in pending until you resolve it as new, knowing that' } : {}), ...(p.unembedded ? { embedded: false, embedder_failure: p.unembedded, note: 'stored without a vector (on_embedder_failure keyword): found by keyword search, and not compared with the other notes of the project' } : {}) };
  });
  return items;
}

// Note writes of one project run one at a time in this process (the store owner's): each checks its notes against the live ones before it writes, and
// two that checked side by side would each find the other absent and store the same lesson twice. A worker's hand-back and a memory.store note of
// one project share this chain.
const tails = new Map();
async function serialised(E, project, fn) {
  if (!project) return fn();
  const key = `${E.dataDir}|${project}`;
  const prev = tails.get(key) || Promise.resolve();
  const mine = prev.then(fn);
  const tail = mine.then(() => {}, () => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return mine;
}

module.exports = { serialised, prepareNotes, commitNotes, findMatches, priorVerdicts, fitBody, sightText, inIndexBeforehand, bodyOf, projectNs, pendingNs, SEEN_MAX, round3, size };
