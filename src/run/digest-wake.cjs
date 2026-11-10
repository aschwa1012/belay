'use strict';
// digest-wake.cjs — the headless run's digest of policy steps (ADR 0074 decision 4, amendment 2). The interactive wake publisher rides a digest
// on the wakes it publishes (wake-pipe.cjs); the headless run writes wakes to the orchestrator's stdin, and before this it wrote no digest, so
// an orchestrator that was woken and never waited for the run saw none of belay's steps. Now:
//   - the digest of the steps no digest has taken rides the last exception or done wake a poll writes, in the wake's own stdin line (`writeAll`,
//     `carry`): one turn, not two;
//   - at the idle close, steps no wake carried ride the stall or pre-close notice the close writes, else are written as a digest wake instead of
//     closing (`flush`): its write holds the close until the orchestrator has read it, so a step after the last wake (often the final merge)
//     is not lost to the close.
// The digest is a claim (run-digest.cjs claimDigest, via 'wake'): the adapter's run wait and this path never both show a step. A claim whose
// write was suppressed (stdin closed or broken) is released, so the steps stay for the next asker. Its size is the wait's (CAP_BYTES, oldest
// lines dropped and counted). Facts only: seqs, steps, task ids, outcomes, rows, workers, belay's own error text.

const D = require('./run-digest.cjs');

// The wakes the digest follows: an exception (E1 to E10 by policy-wakes exceptionOf) or the done wake.
const ridesDigest = (ev) => !!(ev && (ev.event === 'policy_done' || require('./policy-wakes.cjs').exceptionOf(ev)));

const HEAD = 'belay: policy steps since the last digest (a record of what belay did, not a request):\n';

// -> the digest wake event, or null when there is no plan to report on or nothing new. `armed()`: the run is under a plan (cheap, cached).
async function claim({ core, dataDir, runId, armed = () => true, now = Date.now }) {
  if (!dataDir || !armed()) return null;
  let rows;
  try { rows = await D.listSteps(core, runId); } catch { return null; } // unread: nothing is claimed, and the next pass asks again
  let rec;
  try { rec = D.claimDigest({ dataDir, runId, rows, form: { head: HEAD, sep: '\n' }, via: 'wake', now }); } catch { return null; } // a file error (EPERM, EBUSY, E_BUSY) claims nothing: the steps stay for the next asker, and the run goes on
  return rec ? { event: 'policy_digest', worker_id: `digest:${runId}`, turn: 0, seq: null, text: rec.text, digest_n: rec.n } : null;
}

// Write the digest wake; a write the run suppressed gives the claim back. -> true when it was written (or held for a pause, to be written).
function deliver(ev, { writeWake, state, dataDir, runId }) {
  const before = state.wakesSuppressed.length;
  writeWake(ev);
  if (!state.wakesSuppressed.slice(before).some((s) => s.digest_n === ev.digest_n)) return true;
  try { D.release({ dataDir, runId, digestN: ev.digest_n }); } catch { /* an unreleased claim keeps its steps from a later digest; the receipt still names it */ }
  return false;
}

// The exceptions and deaths a wait had claimed first (writeWake keeps them in state.lostClaims) whose claim was given back since: a wait
// cancelled before its reply, or the adapter that made it gone (run-digest.cjs release, releaseUnconfirmed). They are offered to the stdin
// path again, so a released exception is not left to a later wait. writeWake claims each again before it writes it.
function released({ state, dataDir, runId }) {
  const lost = state.lostClaims;
  if (!lost || !lost.size || !dataDir) return [];
  const out = [];
  for (const [uid, ev] of [...lost]) {
    let claimed = true;
    try { claimed = D.isClaimed({ dataDir, runId, uid }); } catch { claimed = true; } // unread: kept for the next poll
    if (!claimed) { lost.delete(uid); out.push(ev); }
  }
  return out;
}

// Write `ev` with the digest of the steps no digest has taken folded into its own text (wake.cjs wakeText): one stdin line, one turn. The wake's
// text is never cut; the digest alone is held to its cap, the oldest lines dropped and counted. A wake the run did not write (suppressed) gives
// the claim back, and the steps stay for the next asker. -> true when a digest rode the wake.
async function carry(ev, ctx) {
  const d = ctx.state.finishing ? null : await claim(ctx);
  if (d) ev.rider = { text: d.text, n: d.digest_n };
  const before = ctx.state.wakesSuppressed.length;
  ctx.writeWake(ev);
  if (!d) return false;
  if (!ctx.state.wakesSuppressed.slice(before).some((s) => s.rider && s.rider.n === d.digest_n)) return true;
  try { D.release({ dataDir: ctx.dataDir, runId: ctx.runId, digestN: d.digest_n }); } catch { /* an unreleased claim keeps its steps from a later digest; the receipt still names it */ }
  delete ev.rider; // the same event may be offered again (released()): it carries no digest the orchestrator never saw
  return false;
}

// The released wakes, then the wakes of one poll; the digest rides the last exception or done wake among them, not a line of its own.
async function writeAll(evs, ctx) {
  const all = released(ctx).concat(evs);
  const carrier = ctx.state.finishing ? null : all.filter(ridesDigest).pop(); // ADR 0074 amendment 4: an exception or the done wake, not a routine wake
  for (const ev of all) { if (ev === carrier) await carry(ev, ctx); else ctx.writeWake(ev); }
}

// At the idle close: steps no wake carried are folded into the stall or pre-close notice the close writes (`closer.write`), else written
// alone just before the close (`closer()`, -> true when a digest was written; the close waits for the orchestrator to read it). It cannot loop:
// a claim takes its steps for good, so the next idle pass finds nothing new and closes. A write the run suppressed returns false and the close
// goes ahead (its claim given back). A written one is a pending write, bounded by the same expiry as every wake.
async function flush(ctx) {
  const d = await claim(ctx);
  return d ? deliver(d, ctx) : false;
}
function closer(ctx) {
  const f = () => flush(ctx);
  f.write = (ev) => carry(ev, ctx);
  return f;
}

module.exports = { claim, deliver, writeAll, carry, flush, closer, released, ridesDigest, HEAD };
