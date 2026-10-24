'use strict';
// review-claim.cjs — the in-flight claim of an archive review (the Opus reviewer over a project's held queue). A review costs money and
// runs a child belay must see exit (invariant 1), so a second review of one project must not start while one is alive, whoever starts it
// (the panel's button, the hand command, a reload that forgot the first). The claim is a `review_claim` receipt in the memory ledger:
//   claim    ok 1, key `review:<project>`, message { phase: 'claim', pid, created, image, job, replaced }
//   release  ok 1 (the review ran) or ok 0 with the code that failed it, newest_row_id = the claim's id, message { phase: 'release', summary }
// The newest receipt of the key decides: a claim with no release after it is running. The CLI that holds a claim is the parent of the
// review's child; its pid and creation time (ADR 0039) are on the claim, so "alive" is proved by identity, not by a pid that Windows
// may have reused. A claim whose process is gone is TAKEN OVER: the new claim names the one it replaced (`replaced`), by compare-and-swap
// on the claim id, so two takers cannot both win.
//   memory.reviewClaim    { project, pid, created?, image?, job, replaces? } -> { claim }       (operator; E_BUSY names the live holder)
//   memory.reviewRelease  { project, claim_id, ok, code?, message? }          -> { release }     (operator; E_BUSY if taken over)
//   memory.reviewState    { project? }                                        -> { reviews }     (a read; names what established "alive")
// Imports nothing that can reach the embedder; the read answers from the rows and a pid check, and starts no process (invariant 9).

const { err } = require('./errors.cjs');
const recordEventSync = (...a) => require('./methods-ledger.cjs').recordEventSync(...a); // loaded by the two writes only; a read never needs the ledger code
const { pidAlive } = require('./lock.cjs');

const KIND = 'review_claim';
const keyOf = (project) => `review:${project}`;
const isStr = (v) => typeof v === 'string' && v.length > 0;
const SUMMARY_MAX = 240;
const parse = (t) => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } };
const cut = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };

// One receipt as the claim or release it is.
function view(ev) {
  if (!ev) return null;
  const m = parse(ev.message);
  return {
    id: ev.id, seq: ev.seq, phase: m.phase === 'release' ? 'release' : 'claim', at: ev.written_at, job: ev.worker_id || null, run_id: ev.run_id || null,
    pid: Number.isInteger(m.pid) ? m.pid : null, created: Number.isFinite(m.created) ? m.created : null, image: typeof m.image === 'string' ? m.image : null,
    replaced: m.replaced || null, ok: ev.ok === 1 || ev.ok === true, code: ev.code || null, summary: typeof m.summary === 'string' ? m.summary : null,
    claim_id: ev.newest_row_id || null,
  };
}

function newest(E, project) {
  try { return view(E.store.p('SELECT * FROM memory_event WHERE kind = ? AND key = ? ORDER BY seq DESC LIMIT 1').get(KIND, keyOf(project))); } catch { return null; }
}

// The state of one project's review: { project, state: 'none' | 'running' | 'ended', claim, release, pid_alive, established_by }.
function stateOf(E, project) {
  const last = newest(E, project);
  if (!last) return { project, state: 'none', claim: null, release: null, pid_alive: null, established_by: null };
  if (last.phase === 'claim') {
    const alive = last.pid ? pidAlive(last.pid) : false;
    return { project, state: 'running', claim: last, release: null, pid_alive: alive, established_by: `the newest review_claim receipt ${last.id} has no release after it; pid ${last.pid} ${alive ? 'answers a pid check (identity is checked by whoever takes the claim)' : 'does not answer a pid check'}` };
  }
  let claim = null;
  try { claim = view(E.store.p('SELECT * FROM memory_event WHERE id = ?').get(last.claim_id)); } catch { claim = null; }
  return { project, state: 'ended', claim, release: last, pid_alive: null, established_by: `the review_claim release ${last.id} (${last.ok ? 'ok' : last.code})` };
}

// A read. With a project: that project's state. Without: every project that has ever had a review.
async function reviewState(E, caller, args = {}) {
  if (args.project !== undefined && !isStr(args.project)) throw err('E_ARGS', 'memory.reviewState project must be a non-empty string', { field: 'project' });
  if (args.project) return { reviews: { [args.project]: stateOf(E, args.project) } };
  let keys = [];
  try { keys = E.store.p('SELECT DISTINCT key FROM memory_event WHERE kind = ?').all(KIND).map((r) => r.key); } catch { keys = []; }
  const reviews = {};
  for (const k of keys) { const p = k.slice('review:'.length); reviews[p] = stateOf(E, p); }
  return { reviews };
}

const operatorOnly = (caller, method) => {
  if (caller.role !== 'operator') throw err('E_ROLE', `${method} is the operator's: the review is started by the human's command or button`, { role: caller.role });
};

async function reviewClaim(E, caller, args) {
  operatorOnly(caller, 'memory.reviewClaim');
  const a = args || {};
  for (const k of Object.keys(a)) if (!['project', 'pid', 'created', 'image', 'job', 'replaces'].includes(k)) throw err('E_ARGS', `memory.reviewClaim: ${k} is not an argument`, { field: k });
  if (!isStr(a.project)) throw err('E_ARGS', 'memory.reviewClaim needs a project', { field: 'project' });
  if (!Number.isInteger(a.pid) || a.pid <= 0) throw err('E_ARGS', 'memory.reviewClaim needs the pid of the process that will parent the review', { field: 'pid' });
  if (a.created !== undefined && a.created !== null && !Number.isFinite(a.created)) throw err('E_ARGS', 'created must be a creation time in ms, or absent', { field: 'created' });
  if (!isStr(a.job)) throw err('E_ARGS', 'memory.reviewClaim needs the job (worker) id the review will run as', { field: 'job' });
  // ADR 0052: the run that owns the store is closing and waits only for the reviews claimed before it looked, so no new claim lands.
  const closed = E.owner && E.owner.reviewClaimsClosed;
  if (closed) throw err('E_BUSY', `no archive review can start now: ${closed.reason}; start it again once \`belay run\` has exited`, { project: a.project, reason: 'owner_closing', owner_pid: process.pid, since: closed.at });
  return E.store.tx(() => {
    const last = newest(E, a.project);
    let replaced = null;
    if (last && last.phase === 'claim') {
      if (a.replaces !== last.id) {
        throw err('E_BUSY', `an archive review of ${a.project} is already claimed by pid ${last.pid} (job ${last.job}, claim ${last.id}); it has not ended`, { project: a.project, claim: last, replaces_needed: last.id });
      }
      replaced = { id: last.id, pid: last.pid, created: last.created, job: last.job };
    }
    const ev = recordEventSync(E, caller, {
      kind: KIND, ok: true, key: keyOf(a.project), worker_id: a.job, run_id: caller.run_id || undefined,
      message: JSON.stringify({ phase: 'claim', pid: a.pid, created: a.created == null ? null : a.created, image: a.image || null, replaced }),
    });
    return { claim: view(ev), replaced };
  });
}

async function reviewRelease(E, caller, args) {
  operatorOnly(caller, 'memory.reviewRelease');
  const a = args || {};
  for (const k of Object.keys(a)) if (!['project', 'claim_id', 'ok', 'code', 'message'].includes(k)) throw err('E_ARGS', `memory.reviewRelease: ${k} is not an argument`, { field: k });
  if (!isStr(a.project) || !isStr(a.claim_id)) throw err('E_ARGS', 'memory.reviewRelease needs a project and the claim_id it releases', { field: 'claim_id' });
  if (typeof a.ok !== 'boolean') throw err('E_ARGS', 'memory.reviewRelease needs ok: true or false', { field: 'ok' });
  if (!a.ok && !isStr(a.code)) throw err('E_ARGS', 'a failed review release must name the code that failed it', { field: 'code' });
  return E.store.tx(() => {
    const last = newest(E, a.project);
    if (!last || last.phase !== 'claim' || last.id !== a.claim_id) {
      throw err('E_BUSY', last && last.phase === 'claim' ? `claim ${a.claim_id} was taken over by claim ${last.id} (pid ${last.pid}); this review no longer holds the claim` : `claim ${a.claim_id} is already released or unknown`, { project: a.project, claim_id: a.claim_id, reason: 'not_the_holder', newest: last });
    }
    const ev = recordEventSync(E, caller, {
      kind: KIND, ok: a.ok, ...(a.ok ? {} : { code: a.code }), key: keyOf(a.project), worker_id: last.job, newest_row_id: last.id, run_id: caller.run_id || undefined,
      message: JSON.stringify({ phase: 'release', summary: cut(a.message, SUMMARY_MAX) }),
    });
    return { release: view(ev) };
  });
}

module.exports = { reviewClaim, reviewRelease, reviewState, stateOf, KIND };
