'use strict';
// digest-wake.cjs — the headless run's digest of policy steps (ADR 0074 decision 4, amendment 2). The interactive wake publisher rides a digest
// on the wakes it publishes (wake-pipe.cjs); the headless run writes wakes to the orchestrator's stdin, and before this it wrote no digest, so
// an orchestrator that was woken and never waited for the run saw none of belay's steps. Now:
//   - after the wakes one poll writes, the digest of the steps no digest has taken is one more stdin line (`writeAll`);
//   - at the idle close, steps no digest has taken are written as a digest wake instead of closing (`flush`): its write holds the close until
//     the orchestrator has read it, so a step after the last wake (often the final merge) is not lost to the close.
// The digest is a claim (run-digest.cjs claimDigest, via 'wake'): the adapter's run wait and this path never both show a step. A claim whose
// write was suppressed (stdin closed or broken) is released, so the steps stay for the next asker. Its size is the wait's (CAP_BYTES, oldest
// lines dropped and counted). Facts only: seqs, steps, task ids, outcomes, rows, workers, belay's own error text.

const D = require('./run-digest.cjs');

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

// The wakes of one poll, then the digest when any were written.
async function writeAll(evs, ctx) {
  for (const ev of evs) ctx.writeWake(ev);
  if (!evs.length || ctx.state.finishing) return;
  const d = await claim(ctx);
  if (d) deliver(d, ctx);
}

// At the idle close: -> true when a digest was written (the close waits for the orchestrator to read it). It cannot loop: a claim takes its
// steps for good, so the next idle pass finds nothing new and closes; one digest per batch of steps. A write the run suppressed returns
// false and the close goes ahead (its claim given back). A written one is a pending write, bounded by the same expiry as every wake.
async function flush(ctx) {
  const d = await claim(ctx);
  return d ? deliver(d, ctx) : false;
}

module.exports = { claim, deliver, writeAll, flush, HEAD };
