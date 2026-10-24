'use strict';
// run-review-wait.cjs — `belay run`'s close waits for an archive review attached to its store owner before it shuts the owner down
// (ADR 0052). The operator may start `belay memory review` (the panel's button) while a run is live: the review is a client of the
// run's owner, acts for an ENDED run (its writes are keyed to that run and its project, not to this one), and holds a store claim with
// its own pid. Shutting the owner down under it would cut every later call (E_OWNER_LOST, outcome unknown) and lose its release.
//
// So, after run.end and the run-end memory jobs and before shutdownOwner():
//   1. the owner stops taking review claims (owner.closeReviewClaims; memory.reviewClaim refuses E_BUSY, reason owner_closing), so a
//      review cannot be claimed after this close has looked;
//   2. it waits while a running claim's pid is a client attached to this owner (an open connection whose pid answers a pid check,
//      owner.attached(): ADR 0051's derived fact). The review's release, its exit, or its death ends the wait;
//   3. the wait is BOUNDED (invariant 7: a wedged review CLI keeps its pid and its socket, and a headless run has no console to cut it):
//      each review gets its own review_wall_s, read from the levers of the run it acts for (the claim's run), counted from its claim,
//      plus MARGIN_MS for what runs outside the child's wall cap (the brief and files before it, the apply and the release after it).
//      At the latest such deadline the wait ends as `cut` (cut_by 'deadline'), says so on stderr, and the close goes on;
//   4. a console closing or Ctrl-C ends it at once (cut_by 'interrupt'), and it says so on stderr before waiting.
// The run still stops the owner itself afterwards (ADR 0051 decision 4 stands: no retire here, so no other client extends the run).

const POLL_MS = 250;
const MARGIN_MS = 120000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();

// The running claims whose process is attached to this owner now: [{ project, pid, job, claim, run_id, at }].
async function attachedReviews(core, owner) {
  const reviews = ((await core.memory.reviewState({})).reviews) || {};
  const pids = new Set(owner.attached().map((a) => a.pid).filter(Number.isInteger));
  return Object.values(reviews).filter((s) => s && s.state === 'running' && s.claim && pids.has(s.claim.pid))
    .map((s) => ({ project: s.project, pid: s.claim.pid, job: s.claim.job, claim: s.claim.id, run_id: s.claim.run_id || null, at: s.claim.at }));
}

// The review_wall_s in force for a review: its run's lever block over the defaults. An unreadable run falls back to the default.
async function wallSOf(core, runId) {
  const { DEFAULTS } = require('../core/memory-levers.cjs');
  try {
    const r = ((await core.run.list({})).runs || []).find((x) => x.id === runId);
    const l = r && r.memory_levers ? (typeof r.memory_levers === 'string' ? JSON.parse(r.memory_levers) : r.memory_levers) : {};
    const w = Number(l && l.review_wall_s != null ? l.review_wall_s : DEFAULTS.review_wall_s);
    return Number.isFinite(w) && w > 0 ? w : DEFAULTS.review_wall_s;
  } catch { return DEFAULTS.review_wall_s; }
}

// opts: { core (the run's Core, which holds the owner in-process), fast (RI.fastOf(ce) or null), say (a line to stderr), pollMs;
// clock and marginMs are test seams }. Returns null when no review was attached, else { waited_for, ms, deadline_at, outcome:
// 'detached' | 'cut' | 'error', cut_by?: 'interrupt' | 'deadline', error? }. Never throws.
async function waitForReviews({ core, fast = null, say = (m) => process.stderr.write(m), pollMs = POLL_MS, signals = process, clock = Date.now, marginMs = MARGIN_MS }) {
  const owner = core && core.owner;
  if (!owner || owner.stopped || typeof owner.attached !== 'function' || typeof owner.closeReviewClaims !== 'function') return null;
  owner.closeReviewClaims('the run that owns the store is closing');
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  const t0 = clock();
  const waited = new Map();
  let deadline = null;
  const done = (o) => ({ waited_for: [...waited.values()], ms: clock() - t0, deadline_at: deadline, ...o });
  const tell = (line) => { try { say(line); } catch { /* a closed stderr changes nothing */ } };
  for (const sig of ['SIGINT', 'SIGBREAK']) signals.on(sig, onInterrupt);
  try {
    for (;;) {
      let now;
      try { now = await attachedReviews(core, owner); } catch (e) { return waited.size ? done({ outcome: 'error', error: (e && e.message) || String(e) }) : null; }
      if (!now.length) return waited.size ? done({ outcome: 'detached' }) : null;
      if (interrupted || (fast && fast.requested())) {
        for (const r of now) if (!waited.has(r.claim)) waited.set(r.claim, r);
        return done({ outcome: 'cut', cut_by: 'interrupt' });
      }
      for (const r of now) {
        if (waited.has(r.claim)) continue;
        const wallS = await wallSOf(core, r.run_id);
        const until = (Number.isFinite(r.at) ? r.at : t0) + wallS * 1000 + marginMs;
        waited.set(r.claim, { ...r, wall_s: wallS, until });
        deadline = Math.max(deadline || 0, until);
        tell(`belay run: the run has ended; waiting for the archive review of ${r.project} (pid ${r.pid}, job ${r.job}, claim ${r.claim}) attached to the store owner before stopping it, at most until ${iso(until)} (its review_wall_s ${wallS} s plus ${Math.round(marginMs / 1000)} s). Ctrl-C stops the owner now and cuts the review off.\n`);
      }
      if (clock() >= deadline) {
        const who = now.map((r) => `${r.project} (pid ${r.pid}, job ${r.job})`).join(', ');
        tell(`belay run: the archive review of ${who} is still attached past its deadline ${iso(deadline)}; stopping the store owner now, which cuts the review off (its claim stays open until a later review takes it over).\n`);
        return done({ outcome: 'cut', cut_by: 'deadline' });
      }
      await sleep(pollMs);
    }
  } finally { for (const sig of ['SIGINT', 'SIGBREAK']) signals.removeListener(sig, onInterrupt); }
}

module.exports = { waitForReviews, attachedReviews, MARGIN_MS };
