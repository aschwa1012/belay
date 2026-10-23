'use strict';
// methods-memory-held-settle.cjs — memory.heldSettle: the operator's own settlement of a held note (`belay memory held settle`). The explicit operator
// only (a command of the human's, not a tool call and not the run's close stages, which run as the operator on the harness channel): the same test
// memory.notePromote uses. The archive review is the other authority that changes a held note, and it answers on cites; the operator answers on their
// own reason, which is recorded.
//   archive   the note moves to archive/<project> under its hold (kind and `of` as held); no cites are required, and the facts check is the
//             operator's to override. The archive records who settled it.
//   release   every report on the hold is settled (it no longer stands, warns or counts) and the hold ends, WITHOUT verifying the note. A queued
//             unsupported row is closed as still_unsupported.
//   reoffer   the undecided mark is cleared, so the next archive review is offered the hold again.
// Each writes a receipt on the held row and returns the rows it changed (invariant 5).

const { err } = require('./errors.cjs');
const L = require('./memory-lifecycle.cjs');
const C = require('./lifecycle-common.cjs');
const HG = require('./held-guard.cjs');
const { loadNote } = require('./memory-facts.cjs');
const { archiveNote } = require('./memory-archive.cjs');
const N = require('./methods-memory-notes.cjs');
const { reportKey } = require('./report-marks.cjs');
const { validId } = require('./memory-rows.cjs');
const R = require('./memory-review-common.cjs');
const { isAwaiting } = require('./notes-held.cjs');

const ACTIONS = ['archive', 'release', 'reoffer'];

// Every report on the hold (the new ones by key, a legacy report_confirmed one by its entry on the note).
function reportKeys(note, held) {
  const keys = new Set((held.b.reports || []).map((r) => r.key).filter(Boolean));
  if (held.b.report) {
    const w = (note.b.reported_wrong || []).find((x) => x && x.task_id === held.b.report.task_id && x.at === held.b.report.at);
    if (w) keys.add(reportKey(w));
  }
  return [...keys];
}

async function heldSettle(E, caller, args) {
  if (!HG.explicitOperator(caller)) throw err('E_ROLE', 'memory.heldSettle is the operator\'s own command (belay memory held settle): not a tool call, and not the run\'s close stages', { role: caller.role, channel: caller.channel || 'tool' });
  C.allowKeys(args || {}, ['id', 'action', 'reason', 'project', 'if_awaiting'], 'memory.heldSettle');
  if (args.if_awaiting !== undefined && typeof args.if_awaiting !== 'boolean') throw err('E_ARGS', 'memory.heldSettle if_awaiting must be true or false', { field: 'if_awaiting' });
  if (!validId(args.id)) throw err('E_ARGS', 'memory.heldSettle needs the id of a held note', { field: 'id' });
  if (!ACTIONS.includes(args.action)) throw err('E_ARGS', `memory.heldSettle action must be one of ${ACTIONS.join(', ')}`, { field: 'action' });
  const reason = C.clean(L.checkText(args.reason, 'reason', 500, 'memory.heldSettle: ')).text;
  const rows = E.store.p("SELECT id, namespace, body FROM memory_entries WHERE type = 'held' AND written_by = 'harness' AND json_extract(body, '$.note_id') = ? AND json_extract(body, '$.state') = 'held' ORDER BY created_at DESC, rowid DESC").all(args.id);
  const mine = rows.filter((r) => !args.project || r.namespace === `held/${args.project}`);
  if (!mine.length) throw err('E_NOT_FOUND', `note ${args.id} has no active hold${args.project ? ` in held/${args.project}` : ''}`, { id: args.id });
  const held = { id: mine[0].id, namespace: mine[0].namespace, b: JSON.parse(mine[0].body) };
  const project = held.namespace.slice('held/'.length);
  const out = E.store.tx(() => {
    // The hold is read again INSIDE this transaction and the body of this call works from that read, not from the one before it: a settle that landed in between,
    // from this or another process, is seen. With `if_awaiting` (the panel's flag) the call is a compare-and-set: it is refused unless the hold is still active AND awaits
    // the operator. A re-offer clears `undecided` and leaves the hold active, so without the flag a second settle on the same note would still write.
    const cur = E.store.p('SELECT body FROM memory_entries WHERE id = ?').get(held.id);
    const fresh = cur ? JSON.parse(cur.body) : null;
    const state = fresh ? fresh.state : null;
    if (!fresh || state !== 'held') {
      if (args.if_awaiting === true) throw err('E_PRECONDITION', `the hold on note ${args.id} is ${fresh ? state : 'gone'}, so nothing was settled`, { id: args.id, awaiting: false, state, held_row: held.id });
      throw err('E_NOT_FOUND', `note ${args.id} has no active hold`, { id: args.id });
    }
    if (args.if_awaiting === true && !isAwaiting(fresh)) {
      const u = fresh.undecided && typeof fresh.undecided === 'object' ? fresh.undecided : null;
      const why = u ? `undecided at revision ${u.rev}, but the hold is at revision ${fresh.rev == null ? 0 : fresh.rev} now` : 'not marked undecided';
      throw err('E_PRECONDITION', `the hold on note ${args.id} does not await the operator (${why}), so nothing was settled`, { id: args.id, awaiting: false, state, rev: fresh.rev == null ? 0 : fresh.rev, undecided_rev: u ? (u.rev ?? null) : null, held_row: held.id });
    }
    const hold = { ...held, b: fresh };
    const at = Date.now();
    const receipt = `held-settle:${held.id}@${at.toString(36)}`;
    const note = loadNote(E, args.id);
    if (!note || note.namespace !== N.projectNs(project)) throw err('E_NOT_FOUND', `note ${args.id} is no longer a live note of project ${project}`, { id: args.id });
    const isUns = hold.b.kind === 'unsupported';
    const entry = (outcome, extra = {}) => ({ receipt, at, by: 'operator', action: args.action, outcome, reason, ...extra });
    if (args.action === 'reoffer') {
      if (!hold.b.undecided) throw err('E_PRECONDITION', `the hold on note ${args.id} is not marked undecided, so there is nothing to re-offer (it is offered at the next review already)`, { id: args.id, held_row: held.id });
      R.record(E, held.id, entry('reoffered'), { undecided: null });
      return { id: args.id, action: 'reoffer', outcome: 'reoffered', receipt, held_row: held.id };
    }
    if (args.action === 'archive') {
      if (isUns) throw err('E_PRECONDITION', `note ${args.id} is queued as unsupported: it carries no warning, so there is nothing to archive it for; release it (still unsupported) or re-offer it`, { id: args.id });
      const kept = hold.b.kind === 'duplicate' && hold.b.of ? loadNote(E, hold.b.of) : (hold.b.relation === 'refines' && hold.b.of ? loadNote(E, hold.b.of) : null);
      const done = archiveNote(E, project, note, {
        kind: hold.b.kind, of: hold.b.of || null, ground: hold.b.ground || null, reason, cites: [], run_id: hold.b.run_id || null, head_sha: hold.b.head_sha || null,
        held_row: held.id, receipt, settled_by: 'operator', ...(hold.b.relation ? { relation: hold.b.relation, refines: hold.b.relation === 'refines', via: hold.b.relation } : {}),
      }, kept);
      R.record(E, held.id, entry('archived', { to: done.to }), { state: 'archived', archived_at: done.at });
      return { id: args.id, action: 'archive', outcome: 'archived', receipt, to: done.to, history_moved: done.history_moved, replaced_also_archived: done.replaced_also_archived, held_row: held.id };
    }
    // release
    const keys = isUns ? [] : reportKeys(note, hold);
    R.record(E, held.id, entry(isUns ? 'still_unsupported' : 'released', { settled: keys }), { state: isUns ? 'still_unsupported' : 'released', settled_at: at });
    E.store.patchBody(args.id, (b) => {
      delete b.held;
      if (isUns) b.unsupported = { ...(b.unsupported || {}), state: 'still_unsupported', settled_at: at, receipt };
      else {
        b.reports_settled = [...new Set([...(b.reports_settled || []), ...keys])];
        b.releases = [...(b.releases || []), { held_row: held.id, at, receipt, reason, by: 'operator' }].slice(-R.REVIEWS_KEEP);
      }
      return N.fitBody(b);
    });
    return { id: args.id, action: 'release', outcome: isUns ? 'still_unsupported' : 'released', receipt, settled: { keys, count: keys.length }, verified: false, held_row: held.id };
  });
  E.noteWrite();
  return { ...out, held: C.rowOut(E, held.id), row: C.rowOut(E, args.id) };
}

module.exports = { heldSettle };
