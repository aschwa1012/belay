'use strict';
// note-unsupported.cjs — the `unsupported` note verdict (operator, 2026-10-17; the shape is provisional). A note reviewer (the task's reviewer, or
// the Haiku note-review job) may answer that no single place proves or disproves a note. The note then:
//   * stays a normal UNVERIFIED note: no warning line, no `body.held`, no orchestrator wake, never hidden;
//   * joins the on-demand review queue as its own kind, `unsupported`: a row in held/<project> (kind `unsupported`, state `held`), counted
//     separately from the holds that carry a warning (memory.held `unsupported`), and settled by the Opus archive reviewer, who is given the
//     run's wider evidence as paths and answers verify, refute or still_unsupported (methods-memory-review.cjs).
// `body.unsupported` on the note records the queue row and the state (`open`, then `verified`, `refuted` or `still_unsupported`), so the note
// is not offered to a note review again.

const { err } = require('./errors.cjs');
const L = require('./memory-lifecycle.cjs');
const C = require('./lifecycle-common.cjs');
const N = require('./methods-memory-notes.cjs');
const { loadNote } = require('./memory-facts.cjs');
const { recordEventSync } = require('./methods-ledger.cjs');
const { headOf } = require('./note-report-verdicts.cjs');

// Queue the note. `route` is the review's { reviewer, ref, keyBase }; `v` the shaped verdict { id, reason, cites (maybe empty) }; `n` the admitted
// note row. One transaction: the queue row, the pointer on the note and the `note_review` receipt, or nothing.
function queueUnsupported(E, caller, route, v, n) {
  return E.store.tx(() => {
    const fresh = loadNote(E, n.id);
    if (!fresh) throw err('E_NOT_FOUND', `no note ${n.id}`, { id: n.id });
    const status = fresh.status || 'unverified';
    if (status !== 'unverified') throw err('E_ARGS', `note ${n.id} is ${status}; unsupported applies to an unverified note`, { id: n.id });
    if (fresh.b.unsupported) throw err('E_EXISTS', `note ${n.id} is already ${fresh.b.unsupported.state === 'open' ? 'queued as unsupported' : `judged ${fresh.b.unsupported.state}`}`, { id: n.id });
    if (fresh.b.held) throw err('E_EXISTS', `note ${n.id} is already held (${fresh.b.held.row}); the archive reviewer settles it first`, { id: n.id, held_row: fresh.b.held.row });
    const project = String(fresh.namespace).replace(/^project\//, '');
    const red = C.redactEntry({ reason: v.reason, cites: v.cites });
    const at = Date.now();
    const held = C.putRow(E, caller, {
      ns: L.nsOf('held', project), type: 'held', runId: caller.run_id || n.run_id,
      text: `unsupported: ${n.id} (review ${route.ref})`, title: `unsupported: ${fresh.title || n.id}`,
      body: {
        state: 'held', note_id: n.id, kind: 'unsupported', of: null, ground: 'unsupported', reason: red.reason, run_id: caller.run_id || n.run_id,
        head_sha: headOf(E, n.task_id), cites: red.cites, facts: null, scrub: null, unsupported_by: { by: route.reviewer, ref: route.ref, at }, reviews: [],
      },
    });
    // Deliberately NOT `body.held`: that pointer is the warning line the note carries into later runs.
    E.store.patchBody(n.id, (b) => { b.unsupported = { held_row: held.id, state: 'open', by: route.reviewer, ref: route.ref, at, reason: red.reason }; return N.fitBody(b); });
    const ev = recordEventSync(E, caller, { kind: 'note_review', ok: true, run_id: caller.run_id || n.run_id, worker_id: route.reviewer, task_id: n.task_id, key: `${route.keyBase}:${n.id}`, row_ids: [n.id], newest_row_id: held.id, message: `unsupported: ${red.reason}`.slice(0, 300) });
    return { id: n.id, verdict: 'unsupported', applied: true, status: 'unverified', previous_status: 'unverified', queued: C.rowOut(E, held.id), event_id: ev.id };
  });
}

module.exports = { queueUnsupported };
