'use strict';
// methods-memory-review.cjs — memory.reviewApply: the Opus reviewer's verdicts on held notes ("hold, then decide").
// Harness caller only. For each held note the reviewer either
//   archive  S4's facts are checked again at this moment, then the note moves to archive/<project> keeping its id
//            (a duplicate hands its sightings and delivery history to the note it duplicates); or
//   release  the hold is dropped and the warning with it.
// Every verdict, applied or refused, is written on the held row and returned with a `review:` receipt, so a refusal
// is a fact on the row and not a silence. Nothing is deleted.

const { err } = require('./errors.cjs');
const L = require('./memory-lifecycle.cjs');
const C = require('./lifecycle-common.cjs');
const { loadNote, checkHoldFacts, ownTexts } = require('./memory-facts.cjs');
const { checkCitations, evidenceOf } = require('./memory-citations.cjs');
const { archiveNote } = require('./memory-archive.cjs');
const N = require('./methods-memory-notes.cjs');

const KEYS = ['verdicts', 'run_id', 'head_sha', 'worktree', 'evidence_files'];
const REVIEWS_KEEP = 20;
const pick = e => ({ reason: e.reason, cites: e.cites });

// The one active hold of a note, as a row with its parsed body, or null.
function activeHold(E, project, noteId) {
  const r = E.store.p(`SELECT id, namespace, body FROM memory_entries WHERE namespace = ? AND type = 'held' AND written_by = 'harness'
    AND json_extract(body, '$.note_id') = ? AND json_extract(body, '$.state') = 'held' ORDER BY created_at DESC LIMIT 1`).get(L.nsOf('held', project), noteId);
  return r ? { id: r.id, namespace: r.namespace, b: JSON.parse(r.body) } : null;
}

function record(E, heldId, entry, patch) {
  E.store.patchBody(heldId, b => {
    b.reviews = [...(b.reviews || []), entry].slice(-REVIEWS_KEEP);
    if (patch) Object.assign(b, patch);
    return b;
  });
}

const review = (ctx, held, v, outcome, extra) => ({ receipt: `review:${ctx.runId}:${held.id}`, run_id: ctx.runId, at: Date.now(), verdict: v.verdict, outcome, reason: v.reason, cites: v.cites, ...(v.same_claim === undefined ? {} : { same_claim: v.same_claim }), ...extra });

function release(E, ctx, held, v) {
  const entry = review(ctx, held, v, 'released');
  record(E, held.id, entry, { state: 'released', released_at: entry.at });
  E.store.patchBody(held.b.note_id, b => { delete b.held; b.releases = [...(b.releases || []), { held_row: held.id, at: entry.at, receipt: entry.receipt, reason: v.reason }].slice(-REVIEWS_KEEP); return b; });
  return { id: held.b.note_id, verdict: 'release', outcome: 'released', receipt: entry.receipt, held: C.rowOut(E, held.id), row: C.rowOut(E, held.b.note_id) };
}

// Inside the transaction. A failed precondition does not throw: it is written on the held row and returned.
function archive(E, ctx, held, v, sources) {
  const note = loadNote(E, held.b.note_id);
  const refuse = (code, message, detail) => {
    const entry = review(ctx, held, v, 'refused', { code, message, verified: sources });
    record(E, held.id, entry);
    return { id: held.b.note_id, verdict: 'archive', outcome: 'refused', receipt: entry.receipt, code, message, ...(detail ? { detail } : {}), held: C.rowOut(E, held.id), row: C.rowOut(E, held.b.note_id) };
  };
  if (!note || note.namespace !== N.projectNs(ctx.project)) return refuse('E_NOT_FOUND', `note ${held.b.note_id} is no longer a live note of the project (${note ? note.namespace : 'gone'}), so there is nothing to archive`);
  let facts;
  try { facts = checkHoldFacts(E, ctx.project, note, held.b.kind, held.b.of, held.b.ground, ctx.threshold); } catch (e) {
    if (e.code !== 'E_PRECONDITION') throw e;
    return refuse(e.code, `S4 no longer holds at apply time: ${e.message}`, e.detail);
  }
  const entry = review(ctx, held, v, 'archived', { facts, verified: sources });
  const kept = held.b.kind === 'duplicate' ? loadNote(E, held.b.of) : null;
  const done = archiveNote(E, ctx.project, note, {
    kind: held.b.kind, of: held.b.of, ground: held.b.ground, reason: held.b.reason, cites: held.b.cites, run_id: held.b.run_id, head_sha: held.b.head_sha,
    held_row: held.id, receipt: entry.receipt,
  }, kept);
  record(E, held.id, entry, { state: 'archived', archived_at: done.at });
  return { id: note.id, verdict: 'archive', outcome: 'archived', receipt: entry.receipt, facts, history_moved: done.history_moved, held: C.rowOut(E, held.id), row: C.rowOut(E, note.id) };
}

async function one(E, ctx, raw, index) {
  let v = raw;
  const held = activeHold(E, ctx.project, v.id);
  if (!held) throw err('E_NOT_FOUND', `note ${v.id} has no active hold in held/${ctx.project}`, { id: v.id });
  if (v.verdict === 'release') { v = { ...v, ...pick(C.redactEntry(v)) }; return E.store.tx(() => release(E, ctx, held, v)); }
  let sources = [];
  try {
    if (held.b.kind === 'duplicate') {
      // A duplicate is archived on the reviewer's explicit "same claim, not contradicting" and S4's facts (rechecked in archive()); no cites.
      if (v.same_claim !== true) throw err('E_PRECONDITION', 'archiving a duplicate needs same_claim: true, the reviewer\'s statement that both notes make the same claim and do not contradict; release it if they differ', { id: v.id });
      v = { ...v, cites: [] };
    } else {
    if (!v.cites.length) throw err('E_CITATION', `archiving a ${held.b.kind} note needs at least one cite { where, quote }, verbatim`, { id: v.id });
    const own = loadNote(E, v.id);
    sources = await checkCitations(v.cites, { ...ctx.evidence, head_sha: ctx.evidence.head_sha || held.b.head_sha, own: own ? ownTexts(own) : [] });
    if (held.b.ground === 'code_contradicts' && !sources.some(s => s.source !== 'stream')) throw err('E_CITATION', 'a hold on the ground code_contradicts is archived on a citation of a file at the head commit', { id: v.id });
    }
  } catch (e) {
    if (e.code !== 'E_CITATION' && e.code !== 'E_PRECONDITION') throw e;
    v = { ...v, ...pick(C.redactEntry(v)) };
    return E.store.tx(() => {
      const entry = review(ctx, held, v, 'refused', { code: e.code, message: e.message });
      record(E, held.id, entry);
      return { id: v.id, verdict: 'archive', outcome: 'refused', receipt: entry.receipt, code: e.code, message: e.message, held: C.rowOut(E, held.id), row: C.rowOut(E, v.id) };
    });
  }
  v = { ...v, ...pick(C.redactEntry(v)) };
  return E.store.tx(() => {
    const fresh = activeHold(E, ctx.project, v.id); // the state at the write
    if (!fresh) throw err('E_NOT_FOUND', `the hold on note ${v.id} was settled while the verdict was being checked`, { id: v.id });
    return archive(E, ctx, fresh, v, sources);
  });
}

async function reviewApply(E, caller, args) {
  C.needHarness(caller, 'memory.reviewApply');
  C.allowKeys(args, KEYS, 'memory.reviewApply');
  const { lv, project, runId } = C.notesContext(E, caller, 'memory.reviewApply');
  if (args.run_id !== undefined && args.run_id !== runId) throw err('E_ARGS', `memory.reviewApply acts for the caller's own run (${runId}), and this call named ${args.run_id}`, { field: 'run_id' });
  const verdicts = L.checkVerdicts(args.verdicts);
  const ctx = { project, runId, evidence: evidenceOf(args), threshold: lv.notes_match_threshold };
  const applied = [], refused = [];
  for (const [i, v] of verdicts.entries()) {
    try {
      const r = await one(E, ctx, v, i);
      (r.outcome === 'refused' ? refused : applied).push({ index: i, ...r });
    } catch (e) {
      if (!e || !['E_NOT_FOUND', 'E_CITATION', 'E_PRECONDITION', 'E_EXISTS'].includes(e.code)) throw e;
      refused.push({ index: i, id: v.id, verdict: v.verdict, outcome: 'refused', code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) });
    }
  }
  E.noteWrite();
  return { run_id: runId, project, counts: { verdicts: verdicts.length, applied: applied.length, refused: refused.length }, applied, refused };
}

module.exports = { reviewApply, activeHold };
