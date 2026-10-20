'use strict';
// methods-memory-scrub.cjs — memory.scrubApply: the write side of the scrubber's hand-back. The scrubber (a model) judges how notes
// RELATE; only this method writes, and only for the harness caller. Per entry:
//   resolve  settle an unresolved pending note as new, repeats, supersedes or refines (memory.noteResolve's own logic).
//   relate   two LIVE notes (a worker's `replaced_by` pair, a `memory embed` match): new, repeats, supersedes or refines, applied
//            directly behind the mechanical gates of memory-relate.cjs. The older note is archived (restorable), never deleted.
//   draft    store a promotion draft for a nominated note in draft/<project>; nothing is promoted here.
// `hold` and `dismiss` are NOT scrubber actions: whether a note is wrong about the world is a reviewer's call, not a text
// comparison, so the scrubber's hand-back may carry neither (E_ARGS, per entry). Their ONE writer is `hold` below (exported): the report-to-hold
// path (memory-report-hold.cjs, an upheld report) calls it, with the report on the row (`ctx.heldExtra`). `holdApply` is the whole scrubApply call with
// holds allowed, kept as the test seam for the held machinery; it has no production caller.
// Safeguards: S2 every id in the scope list (E_SCOPE, the whole call; a relate also needs its other note named by scope, a match or
// a report); S4 the relation gates (E_PRECONDITION); S3 and the grounds still guard a hold. Mode (lever scrub_action): off refuses,
// propose writes proposal/<project> rows and applies nothing, apply writes. More archives (relations and holds) than
// scrub_alarm_holds in one call still succeed and return an `alarm`.

const { err } = require('./errors.cjs');
const L = require('./memory-lifecycle.cjs');
const C = require('./lifecycle-common.cjs');
const { loadNote, checkHoldFacts, ownTexts, sawsOf } = require('./memory-facts.cjs');
const { checkCitations, evidenceOf } = require('./memory-citations.cjs');
const { archiveNote } = require('./memory-archive.cjs');
const { plan, applyPlan } = require('./memory-relate.cjs');
const N = require('./methods-memory-notes.cjs');
const { validId } = require('./memory-rows.cjs');

const KEYS = ['scrub', 'scope', 'run_id', 'head_sha', 'worktree', 'evidence_files'];
const REFUSALS = new Set(['E_CITATION', 'E_PRECONDITION', 'E_SCOPE', 'E_NOT_FOUND', 'E_EXISTS', 'E_ARGS', 'E_ROLE', 'E_MODEL']);
const DISMISS_KEEP = 20;

function checkScope(scope) {
  if (!Array.isArray(scope) || scope.length > L.SCOPE_MAX || scope.some(x => !validId(x))) throw err('E_ARGS', `scope must be an array of at most ${L.SCOPE_MAX} note ids`, { field: 'scope' });
  return new Set(scope);
}

// The target note: a note of the project, live or pending. Anything else (archived, in another project, not a note)
// is not an object of a scrub.
function target(E, project, id) {
  const note = loadNote(E, id);
  if (!note || note.type !== 'note') throw err('E_NOT_FOUND', `no note ${id}`, { id });
  const live = note.namespace === N.projectNs(project), pending = note.namespace === N.pendingNs(project);
  if (!live && !pending) throw err('E_NOT_FOUND', `note ${id} is in ${note.namespace}: only a live or pending note of project ${project} is scrubbed`, { id, namespace: note.namespace });
  return { note, live, pending };
}

const scrubReceipt = (ctx, ent, index, sources) => ({
  run_id: ctx.runId, index, at: Date.now(), mode: ctx.mode, action: ent.action, ground: ent.ground || null, reason: ent.reason, cites: ent.cites || [], verified: sources, redacted: ent.redacted || 0,
});

// The proposal row: the entry as the scrubber gave it, what S3 verified, and the facts S4 found. Applies nothing.
function propose(E, caller, ctx, ent, index, sources, facts) {
  const row = C.putRow(E, caller, {
    ns: L.nsOf('proposal', ctx.project), type: 'proposal', runId: ctx.runId,
    text: `proposal ${ent.action}${ent.kind ? ` ${ent.kind}` : ''}${ent.resolve ? ` ${ent.resolve}` : ''}${ent.relation ? ` ${ent.relation}` : ''} ${ent.id}${ent.of ? ` of ${ent.of}` : ''} (run ${ctx.runId})`,
    title: `proposal: ${ent.action}${ent.kind ? ` ${ent.kind}` : ''} ${ent.id}`,
    body: { state: 'open', note_id: ent.id, entry: ent, run_id: ctx.runId, head_sha: ctx.evidence.head_sha, facts: facts || null, scrub: scrubReceipt(ctx, ent, index, sources) },
  });
  return { index, id: ent.id, action: ent.action, outcome: 'proposed', ...(ent.relation ? { relation: ent.relation } : {}), ...(ent.resolve ? { resolve: ent.resolve } : {}), row: C.rowOut(E, row.id) };
}

function dismiss(E, ctx, ent, index, sources, note) {
  const next = E.store.patchBody(note.id, b => {
    b.dismissed = [...(b.dismissed || []), { run_id: ctx.runId, at: Date.now(), ground: ent.ground, reason: ent.reason, cites: ent.cites, scrub: scrubReceipt(ctx, ent, index, sources) }].slice(-DISMISS_KEEP);
    return N.fitBody(b);
  });
  return { index, id: ent.id, action: 'dismiss', outcome: 'applied', dismissed: next.dismissed[next.dismissed.length - 1], row: C.rowOut(E, note.id) };
}

function hold(E, caller, ctx, ent, index, sources, state) {
  const { note, pending } = state;
  const facts = checkHoldFacts(E, ctx.project, note, ent.kind, ent.of, ent.ground, ctx.threshold, ctx.runId);
  const receipt = scrubReceipt(ctx, ent, index, sources);
  if (pending) {
    // Marks on a pending note need no review: it hides nothing. Applied directly to the pending row.
    const done = archiveNote(E, ctx.project, note, { kind: ent.kind, of: ent.of, ground: ent.ground, reason: ent.reason, cites: ent.cites, run_id: ctx.runId, head_sha: ctx.evidence.head_sha, direct: true }, ent.of ? loadNote(E, ent.of) : null);
    E.store.patchBody(note.id, b => { b.archived.facts = facts; b.archived.scrub = receipt; return b; });
    return { index, id: ent.id, action: 'hold', outcome: 'archived_directly', facts, history_moved: done.history_moved, row: C.rowOut(E, note.id) };
  }
  if (note.b.held) throw err('E_EXISTS', `note ${note.id} is already held (${note.b.held.row}); the reviewer settles it before another hold`, { id: note.id, held_row: note.b.held.row });
  const held = C.putRow(E, caller, {
    ns: L.nsOf('held', ctx.project), type: 'held', runId: ctx.runId,
    text: `held ${ent.kind}: ${note.id}${ent.of ? ` against ${ent.of}` : ''} (run ${ctx.runId})`,
    title: `held ${ent.kind}: ${note.title || note.id}`,
    body: { state: 'held', note_id: note.id, kind: ent.kind, ...(ent.relation ? { relation: ent.relation } : {}), of: ent.of, ground: ent.ground, reason: ent.reason, run_id: ctx.runId, head_sha: ctx.evidence.head_sha, cites: ent.cites, facts, scrub: receipt, ...(ctx.heldExtra || {}), reviews: [] },
  });
  // The note itself carries a pointer, so the warning follows it into later runs without a second lookup.
  E.store.patchBody(note.id, b => { b.held = { row: held.id, kind: ent.kind, of: ent.of, reason: ent.reason, run_id: ctx.runId, at: Date.now() }; return N.fitBody(b); });
  return { index, id: ent.id, action: 'hold', outcome: 'held', kind: ent.kind, facts, held: C.rowOut(E, held.id), row: C.rowOut(E, note.id) };
}

function draft(E, caller, ctx, ent, index, sources, note) {
  const row = C.putRow(E, caller, {
    ns: L.nsOf('draft', ctx.project), type: 'draft', runId: ctx.runId,
    text: `draft rule for ${note.id}: ${ent.draft.rule}`, title: `draft rule for ${note.title || note.id}`,
    body: { state: 'draft', note_id: note.id, rule: ent.draft.rule, target: ent.draft.target, reason: ent.reason, run_id: ctx.runId, head_sha: ctx.evidence.head_sha, cites: ent.cites, scrub: scrubReceipt(ctx, ent, index, sources) },
  });
  return { index, id: ent.id, action: 'draft', outcome: 'stored', draft: C.rowOut(E, row.id) };
}

async function settle(E, caller, ctx, ent, index, sources, pending) {
  if (ent.of && (ent.resolve === 'supersedes' || ent.resolve === 'refines')) {
    const t = loadNote(E, ent.of);
    if (t && (t.status || 'unverified') === 'verified') throw err('E_PRECONDITION', `note ${ent.of} is review-verified, and a verified note is never hidden without the reviewer: resolve ${ent.id} as new, then relate the two (that becomes a hold for the reviewer)`, { id: ent.id, of: ent.of });
  }
  const r = { id: ent.id, resolve: ent.resolve };
  if (ent.of) r.of = ent.of;
  // A supersedes needs evidence in the write-time shape; the scrubber gives a reason (no quotes), which is stated as what it saw.
  if (ent.resolve === 'supersedes') r.evidence = [{ where: 'scrubber', saw: Buffer.from(ent.reason, 'utf8').subarray(0, 500).toString('utf8').replace(/\uFFFD$/, '') }];
  const out = await N.resolve(E, caller, { resolutions: [r] });
  return { index, id: ent.id, action: 'resolve', outcome: 'applied', resolved: out.resolved[0], still_pending: out.still_pending, scrub: scrubReceipt(ctx, ent, index, sources), pending_row: pending };
}

// The other note of a relate must be reachable: in the scope list, or named by a stored match or a report on either note.
function reachable(E, ctx, st, ent) {
  if (ctx.scope.has(ent.of)) return true;
  const other = loadNote(E, ent.of);
  const names = (n, id) => n && ((n.b.matches || []).some(m => m && m.id === id) || (n.b.reported_wrong || []).some(w => w && w.replaced_by === id));
  return names(st.note, ent.of) || names(other, ent.id);
}

function relate(E, caller, ctx, ent, index) {
  if (!reachable(E, ctx, target(E, ctx.project, ent.id), ent)) throw err('E_SCOPE', `note ${ent.of} is neither in the scope list nor named by a stored match or a report on ${ent.id}, so a relation may not reach it`, { id: ent.id, of: ent.of });
  const receipt = scrubReceipt(ctx, ent, index, []);
  if (ctx.mode === 'propose') {
    const { f } = plan(E, ctx, ent); // the gates are checked now, so a refused pair is never proposed
    const { x, y, ...facts } = f;
    return E.store.tx(() => propose(E, caller, ctx, ent, index, [], facts));
  }
  return E.store.tx(() => {
    const p = plan(E, ctx, ent); // the state at the write, inside the transaction
    if (p.needsHold) {
      // A review-verified note is never hidden without the reviewer: the verdict becomes a hold for the on-demand Opus reviewer.
      const kind = ent.relation === 'repeats' ? 'duplicate' : 'superseded';
      const h = { id: p.gone.id, action: 'hold', kind, of: p.kept.id, relation: ent.relation, ground: kind === 'duplicate' ? 'same_claim' : 'replaced_by_newer', reason: ent.reason, cites: [] };
      const r = hold(E, caller, ctx, h, index, [], target(E, ctx.project, p.gone.id));
      return { ...r, action: 'relate', relation: ent.relation, outcome: 'held', archived: null, kept: p.kept.id, held_for_review: true, note: 'the note is review-verified, so the relation became a hold for the reviewer' };
    }
    const done = applyPlan(E, { ...ctx, receipt: `scrub:${ctx.runId}#${index}` }, ent, p);
    return { index, id: ent.id, action: 'relate', outcome: 'applied', ...done, scrub: receipt, row: C.rowOut(E, ent.id), other_row: C.rowOut(E, ent.of) };
  });
}

async function one(E, caller, ctx, raw, index) {
  let ent = raw;
  if ((ent.action === 'hold' || ent.action === 'dismiss') && !ctx.allowHold) {
    throw err('E_ARGS', `${ent.action} is not a scrubber action: whether a note is wrong is judged by a reviewer from a worker's report, not by the scrubber; relate two notes (repeats, supersedes, refines, new) or resolve a pending one`, { id: ent.id, action: ent.action });
  }
  const st = target(E, ctx.project, ent.id);
  if (ent.action === 'relate') {
    if (!st.live) throw err('E_ARGS', `note ${ent.id} is pending: resolve it (relate acts on two live notes)`, { id: ent.id, action: ent.action });
    ent = C.redactEntry(ent);
    return relate(E, caller, ctx, ent, index);
  }
  const wants = ent.action === 'resolve' ? st.pending : ent.action === 'hold' ? true : st.live;
  if (!wants) throw err('E_ARGS', `note ${ent.id} is ${st.live ? 'live' : 'pending'}, and ${ent.action} acts on a ${ent.action === 'resolve' ? 'pending' : 'live'} note`, { id: ent.id, action: ent.action });
  if (ent.action === 'hold') {
    if (st.live && st.note.b.held) throw err('E_EXISTS', `note ${ent.id} is already held (${st.note.b.held.row}); the reviewer settles it before another hold`, { id: ent.id, held_row: st.note.b.held.row });
    // S2 reaches the note a hold stands against: it is in scope, or a report or a stored match already names it.
    const named = (st.note.b.reported_wrong || []).some(w => w && w.replaced_by === ent.of) || (st.note.b.matches || []).some(m => m && m.id === ent.of);
    if (ent.of && !ctx.scope.has(ent.of) && !named) throw err('E_SCOPE', `note ${ent.of} is neither in the scope list nor named by a report or a stored match on ${ent.id}, so a hold may not stand against it`, { id: ent.id, of: ent.of });
  }
  const sources = ent.cites && ent.cites.length ? await checkCitations(ent.cites, { ...ctx.evidence, own: ownTexts(st.note), saws: sawsOf(st.note), title: st.note.title }) : [];
  ent = C.redactEntry(ent); // after the verbatim check, before anything is stored or returned
  if (ent.ground === 'code_contradicts' && !sources.some(s => s.source !== 'stream')) throw err('E_CITATION', 'ground code_contradicts needs at least one citation of a file at the head commit: a stream quotes what was said, not what the code is', { id: ent.id });
  if (ctx.mode === 'propose') {
    const facts = ent.action === 'hold' ? checkHoldFacts(E, ctx.project, st.note, ent.kind, ent.of, ent.ground, ctx.threshold, ctx.runId) : null;
    return E.store.tx(() => propose(E, caller, ctx, ent, index, sources, facts));
  }
  if (ent.action === 'resolve') return settle(E, caller, ctx, ent, index, sources, st.note.id);
  return E.store.tx(() => {
    const fresh = target(E, ctx.project, ent.id); // the state at the write, inside the transaction
    if (ent.action === 'dismiss') return dismiss(E, ctx, ent, index, sources, fresh.note);
    if (ent.action === 'hold') return hold(E, caller, ctx, ent, index, sources, fresh);
    return draft(E, caller, ctx, ent, index, sources, fresh.note);
  });
}

async function scrubApply(E, caller, args, opts = {}) {
  C.needHarness(caller, 'memory.scrubApply');
  C.allowKeys(args, KEYS, 'memory.scrubApply');
  const { lv, project, runId } = C.notesContext(E, caller, 'memory.scrubApply');
  if (args.run_id !== undefined && args.run_id !== runId) throw err('E_ARGS', `memory.scrubApply acts for the caller's own run (${runId}), and this call named ${args.run_id}`, { field: 'run_id' });
  const mode = lv.scrub_action;
  if (mode === 'off') throw err('E_LEVER_OFF', 'memory.scrubApply: the run has scrub_action off', { lever: 'scrub_action' });
  const entries = L.checkScrub(args.scrub, lv.scrub_max_items);
  const scope = checkScope(args.scope);
  const outside = entries.filter(e => !scope.has(e.id)).map(e => e.id);
  if (outside.length) throw err('E_SCOPE', `the scrub names ${outside.length} note${outside.length === 1 ? '' : 's'} outside the scope list (${outside.slice(0, 5).join(', ')}); the scrubber acts only on what it was given, so nothing was written`, { ids: outside });
  const ctx = { mode, project, runId, scope, evidence: evidenceOf(args), threshold: lv.notes_match_threshold, allowHold: !!opts.allowHold };
  const applied = [], proposed = [], refused = [];
  for (const [i, ent] of entries.entries()) {
    try {
      const r = await one(E, caller, ctx, ent, i);
      (r.outcome === 'proposed' ? proposed : applied).push(r);
    } catch (e) {
      if (!e || !REFUSALS.has(e.code)) throw e;
      refused.push({ index: i, id: ent.id, action: ent.action, code: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) });
    }
  }
  E.noteWrite();
  const holds = [...applied, ...proposed].filter(r => r.action === 'hold').length;
  // The runaway alarm counts every note taken out of sight in one scrub: a hold, or a relation that archives a note.
  const archives = [...applied, ...proposed].filter(r => r.action === 'hold' || (r.action === 'relate' && r.relation !== 'new')
    || (r.action === 'resolve' && ['supersedes', 'refines'].includes(r.resolved ? r.resolved.resolved : r.resolve))).length; // a pending repeat takes nothing out of sight
  const out = { mode, run_id: runId, project, counts: { entries: entries.length, applied: applied.length, proposed: proposed.length, refused: refused.length, holds, archives }, applied, proposed, refused };
  if (archives > lv.scrub_alarm_holds) out.alarm = { kind: 'many_holds', holds: archives, limit: lv.scrub_alarm_holds, message: `${archives} notes taken out of sight by one scrub (holds and archiving relations) is more than the ${lv.scrub_alarm_holds} that is normal: the orchestrator and the operator should look (belay memory proposals, belay memory archive)` };
  return out;
}

// The same call with `hold` and `dismiss` allowed: a test seam for the held machinery, never the scrubber's.
const holdApply = (E, caller, args) => scrubApply(E, caller, args, { allowHold: true });

module.exports = { scrubApply, holdApply, target, hold };
