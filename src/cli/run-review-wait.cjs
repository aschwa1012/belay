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
//   3. a console closing or Ctrl-C ends the wait at once (the review is cut off, as before), and it says so on stderr before waiting.
// The run still stops the owner itself afterwards (ADR 0051 decision 4 stands: no retire here, so no other client extends the run).

const POLL_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The running claims whose process is attached to this owner now: [{ project, pid, job, claim }].
async function attachedReviews(core, owner) {
  const reviews = ((await core.memory.reviewState({})).reviews) || {};
  const pids = new Set(owner.attached().map((a) => a.pid).filter(Number.isInteger));
  return Object.values(reviews).filter((s) => s && s.state === 'running' && s.claim && pids.has(s.claim.pid))
    .map((s) => ({ project: s.project, pid: s.claim.pid, job: s.claim.job, claim: s.claim.id }));
}

// opts: { core (the run's Core, which holds the owner in-process), fast (RI.fastOf(ce) or null), say (a line to stderr), pollMs }.
// Returns null when no review was attached, else { waited_for, ms, outcome: 'detached' | 'cut' | 'error', error? }. Never throws.
async function waitForReviews({ core, fast = null, say = (m) => process.stderr.write(m), pollMs = POLL_MS, signals = process }) {
  const owner = core && core.owner;
  if (!owner || owner.stopped || typeof owner.attached !== 'function' || typeof owner.closeReviewClaims !== 'function') return null;
  owner.closeReviewClaims('the run that owns the store is closing');
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  const t0 = Date.now();
  const waited = new Map();
  for (const sig of ['SIGINT', 'SIGBREAK']) signals.on(sig, onInterrupt);
  try {
    for (;;) {
      let now;
      try { now = await attachedReviews(core, owner); } catch (e) { return waited.size ? { waited_for: [...waited.values()], ms: Date.now() - t0, outcome: 'error', error: (e && e.message) || String(e) } : null; }
      if (!now.length) return waited.size ? { waited_for: [...waited.values()], ms: Date.now() - t0, outcome: 'detached' } : null;
      if (interrupted || (fast && fast.requested())) return { waited_for: [...waited.values(), ...now.filter((r) => !waited.has(r.claim))], ms: Date.now() - t0, outcome: 'cut' };
      for (const r of now) {
        if (waited.has(r.claim)) continue;
        waited.set(r.claim, r);
        try { say(`belay run: the run has ended; waiting for the archive review of ${r.project} (pid ${r.pid}, job ${r.job}, claim ${r.claim}) attached to the store owner before stopping it. Ctrl-C stops the owner now and cuts the review off.\n`); } catch { /* a closed stderr changes nothing */ }
      }
      await sleep(pollMs);
    }
  } finally { for (const sig of ['SIGINT', 'SIGBREAK']) signals.removeListener(sig, onInterrupt); }
}

module.exports = { waitForReviews, attachedReviews };
