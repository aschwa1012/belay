'use strict';
// memory-review-unsupported.cjs — the three answers on a queue row of kind `unsupported` (a note a reviewer could not prove or disprove; it carries no
// warning), applied by memory.reviewApply:
//   verify | refute    the note's status is set, as a note review sets it (refute also writes the receipt the orchestrator's wake comes from), on cites
//                      from the evidence paths in the brief; a verify also names the hash of the whole note the brief showed (shown_hash);
//   still_unsupported  the note leaves the queue and stays unverified.
// A failed precondition is written on the row and returned, as an archive's is. Every write is bound to the hold row and revision the verdict read.

const { err } = require('./errors.cjs');
const C = require('./lifecycle-common.cjs');
const { loadNote, ownTexts, sawsOf } = require('./memory-facts.cjs');
const { checkCitations, streamCite } = require('./memory-citations.cjs');
const N = require('./methods-memory-notes.cjs');
const { applyOneIn } = require('./methods-memory-note-review.cjs');
const BC = require('./note-brief-capture.cjs');
const R = require('./memory-review-common.cjs');

// The cites of a verify or a refute. A stream cite is a TOOL RESULT of a non-belay tool in a stream among the evidence files (the task-cite rule:
// never belay's own tool inputs or results, the assistant's or the user's prose, or the task brief), and it may not be the note's own words (title,
// when, text, evidence). A file cite is read at the head commit as for any hold.
async function unsupportedCites(E, ctx, held, note, cites) {
  const own = [note.title, note.b.when, note.text, ...((note.b.evidence || []).flatMap((e) => [e && e.saw, e && e.where]))].filter((t) => typeof t === 'string' && t.trim());
  const files = (ctx.evidence.evidence_files || []).map((f) => String(f).split('\\').join('/'));
  const out = [], fileCites = [];
  for (const [i, c] of cites.entries()) {
    const fail = (reason) => err('E_CITATION', `cites[${i}] (${c.where}) refused: ${reason}`, { index: i, where: c.where, reason });
    if (!c.where.startsWith('stream:')) { fileCites.push(c); continue; }
    const file = c.where.slice('stream:'.length).split('\\').join('/');
    if (!files.includes(file)) throw fail('that stream file is not among the evidence files named for this call');
    const r = streamCite(file, c.quote, own, note.title, sawsOf(note));
    if (!r.found) throw fail(r.reason);
    out.push({ where: c.where, source: 'stream result' });
  }
  if (fileCites.length) out.push(...await checkCitations(fileCites, { ...ctx.evidence, head_sha: held.b.head_sha || ctx.evidence.head_sha, own: ownTexts(note), saws: sawsOf(note), title: note.title }));
  return out;
}

async function unsupported(E, ctx, held, v, readRev) {
  const id = held.b.note_id;
  v = { ...v, ...R.pick(C.redactEntry(v)) };
  const tx = (fn) => C.openTx(E, ctx.caller, 'memory.reviewApply', fn);
  const refuse = (code, message, detail) => tx(() => R.refuseOn(E, ctx, held.id, held, v, code, message, detail));
  const settle = (state, extra) => {
    const entry = R.review(ctx, held, v, state, extra);
    R.record(E, held.id, entry, { state, settled_at: entry.at });
    E.store.patchBody(id, (b) => { b.unsupported = { ...(b.unsupported || {}), state, settled_at: entry.at, receipt: entry.receipt }; return N.fitBody(b); });
    return entry;
  };
  const stale = () => {
    const d = R.mismatch(E, ctx, v, held, readRev);
    if (d) return R.refuseOn(E, ctx, held.id, held, v, 'E_PRECONDITION', R.STALE, d);
    return null;
  };
  if (v.verdict === 'still_unsupported') {
    return tx(() => stale() || (() => {
      const entry = settle('still_unsupported');
      return { id, verdict: v.verdict, outcome: 'still_unsupported', receipt: entry.receipt, held: C.rowOut(E, held.id), row: C.rowOut(E, id) };
    })());
  }
  let sources = [];
  try {
    if (!v.cites.length) throw err('E_CITATION', `a ${v.verdict} of an unsupported note needs at least one cite { where, quote }, verbatim, from the evidence paths in the brief`, { id });
    const own = loadNote(E, id);
    if (!own) throw err('E_NOT_FOUND', `no note ${id}`, { id });
    sources = await unsupportedCites(E, ctx, held, own, v.cites);
  } catch (e) {
    if (e.code !== 'E_CITATION') throw e;
    return refuse(e.code, e.message);
  }
  return tx(() => {
    const bad = stale();
    if (bad) return bad;
    const fresh = R.activeHold(E, ctx.project, id); // the state at the write
    const note = loadNote(E, id);
    if (!fresh || !note || note.namespace !== N.projectNs(ctx.project)) throw err('E_NOT_FOUND', `the queue row of note ${id} was settled, or the note left the project, while the verdict was being checked`, { id });
    if (fresh.b.kind !== 'unsupported') return R.refuseOn(E, ctx, held.id, held, v, 'E_PRECONDITION', `note ${id} is no longer queued as unsupported`);
    if ((note.status || 'unverified') !== 'unverified') return R.refuseOn(E, ctx, held.id, held, v, 'E_PRECONDITION', `note ${id} is now ${note.status}; an unsupported note is judged only while it is unverified`);
    // A verify names the hash of the whole note the brief showed: a note changed since, or a verdict that did not bind one, is not verified.
    if (v.verdict === 'verify' && v.shown_hash !== BC.hashOfRow(note)) return R.refuseOn(E, ctx, held.id, held, v, 'E_PRECONDITION', 'the note changed after the brief showed it, or the brief did not bind it (shown_hash), so it is not verified');
    const route = { reviewer: `archreview-${ctx.runId}`, ref: `${ctx.runId}:${held.id}`, keyBase: `archreview:${held.id}` };
    const status = R.granted(id, () => applyOneIn(E, ctx.caller, route, { id, verdict: v.verdict === 'verify' ? 'confirmed' : 'refuted', reason: v.reason, cites: v.cites }, note));
    if (status.already) return R.refuseOn(E, ctx, held.id, held, v, 'E_PRECONDITION', 'this verdict was already applied');
    const entry = settle(v.verdict === 'verify' ? 'verified' : 'refuted', { verified: sources });
    return { id, verdict: v.verdict, outcome: entry.outcome, receipt: entry.receipt, status: status.status, event_id: status.event_id, held: C.rowOut(E, held.id), row: C.rowOut(E, id) };
  });
}

module.exports = { unsupported };
