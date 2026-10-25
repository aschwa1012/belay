'use strict';
// write-row.cjs — build step 6i-2, design item 3 (R4;
// the tests/cli/pause.test.cjs hang). Moved verbatim out of manager.cjs, unchanged apart from the
// closed-flag check added at the top, to keep manager.cjs under its own 500-line budget once that
// check landed. A write arriving after shutdown() has marked the manager closed elects no store owner
// (invariant 2): it never reaches `core`, and is recorded on the worker's own record instead.

const P = require('./process.cjs');
const W = require('./worker.cjs');
const { lookupSha } = require('./head-lookup.cjs');
const { NO_REPO } = require('./git-facts.cjs');

// Asks git for the worktree's HEAD, once per life, without holding any write, with a bounded retry
// (head-lookup.cjs). The answer, a sha or a null with a reason, is queued on w.queue as another write of whatever
// state the record has by then, unless a relaunch (w.launches moved) or a live state has overtaken it. The row it
// produces carries head_sha, or head_sha null and head_error, via rowOf: a missing head is never silent.
function requestHead(w, ctx, requestedState) {
  w.headRequested = true;
  const launches = w.launches;
  w.headPromise = lookupSha(w.worktree);
  w.headPromise.then(({ sha, reason }) => {
    if (w.launches !== launches || !w.settled) return;
    w.headSha = sha;
    w.headError = sha ? null : reason;
    // A worktree in no repository has no head to be found and never did: no follow-up row for it, as before this
    // fix (a row appearing during a park or stop is a transition the stop and park paths do not expect). The
    // reason stays on the record for any later row.
    if (!sha && reason === NO_REPO) return;
    w.queue = w.queue.then(() => {
      if (w.launches !== launches) return null;
      const st = w.settledState || (w.state === 'starting' || w.state === 'running' || w.state === 'stopping' ? requestedState : w.state);
      return ctx.writeRow(w, st, { guard: true });
    }).catch((e) => {
      w.lastError = { where: 'worker.write/head-sha', code: e && e.code, message: e && e.message };
    });
  });
}

// `ctx` is the same context object manager.cjs builds (`{ core, runId, adapterPid, writeRow }`); this
// factory fills in `writeRow` on it. `flags` is a small mutable object (`{ closed }`) lifecycle.cjs's
// own `shutdown()` flips once every worker has been asked to stop — a shared reference, not a copy, so
// a write queued before that moment but resolving after it still sees the flip.
function createWriteRow(ctx, flags) {
  // Contract §2 / ADR 0004 §2: `running` requires a live pid at the moment it is written; when the
  // worker has died, null comes back and the caller turns that into E_NO_READY or E_SUBSTRATE (the
  // core's own E_WORKER_NOT_LIVE is caught for the same reason). `w.state` is set only once the write
  // resolves.
  // `opts.guard` (W2-3 amendment 2, B2): the head follow-up (not the exit-code fill-in, which stays as at base) is sent with
  // expect_seq = the seq of the last row this record wrote, and the core appends only if that is still the worker's
  // current row; a row someone else wrote since (a forget) is never restated over. Evaluated when the write runs.
  // `opts.refresh` (ADR 0026 fix, review B1): a mid-turn freshness write is never a death channel. A dead
  // pid or the core's E_WORKER_NOT_LIVE returns null with nothing settled, so the exit event (which carries
  // the exit code) or the pid poll records the death as before.
  return async function writeRow(w, state, opts = {}) {
    // build step 6i-2 design item 3 (R4): checked first, before any pid or core work — a write this
    // late has nothing left to elect an owner for.
    if (flags.closed) {
      w.lastError = { where: 'after-shutdown', state };
      return null;
    }
    if (state === 'running' && w.launchFailed) return null;
    if (state === 'running' && (w.settled || !P.pidAlive(w.pid))) {
      if (!w.settled && !opts.refresh && !W.holdForExitEvent(w)) W.settle(w, w.exitCode, w.exitSignal, 'pid-check-before-running-write', ctx);
      return null;
    }
    // W2-3 (amendment 1, B1): the terminal row is written exactly as before, with no git call in front of it.
    // head_sha is asked for here, at settle, but only lands in a follow-up row of the same state once git answers.
    if (w.settled && w.headSha == null && !w.headRequested && state !== 'starting' && state !== 'running') requestHead(w, ctx, state);
    let written;
    w.lastRowHadBase = w.baseSha != null || w.baseError != null;
    w.lastRowHadPidCreated = w.pidCreated != null || w.pidCreatedError != null; // ADR 0039: restatePidCreated below
    try {
      const row = W.rowOf(w, state, ctx);
      if (opts.guard && w.lastWrittenSeq != null) row.expect_seq = w.lastWrittenSeq;
      // ADR 0026 amendments 1 and 2 (proposed): a death that lands while a relaunch of this worker is under way (w.relaunching, from its
      // start until launch() has moved w.launches) keeps the leases the relaunch is about to work under, as one the restart settled does.
      // A relaunch that then fails before it launched releases them by restating this row (opts.releaseLeases, relaunch-guard.cjs).
      if (state === 'dead' && !opts.releaseLeases && (w.relaunching || String(w.deathEstablishedBy).startsWith('pid-check-on-restart'))) row.keep_leases = true;
      if (state === 'dead' && opts.releaseLeases) row.release_leases = true;
      written = await ctx.core.worker.write(row);
    } catch (e) {
      if (state === 'running' && e && e.code === 'E_WORKER_NOT_LIVE') {
        if (!w.settled && !opts.refresh) W.settle(w, w.exitCode, w.exitSignal, 'core-refused-running', ctx);
        return null;
      }
      throw e;
    }
    if (written && written.skipped) { // superseded: nothing was written, so nothing here moves; the skip stays visible
      w.lastError = { where: 'worker.write/superseded', state, reason: written.reason, current_seq: written.current_seq };
      return written;
    }
    if (written && Number.isInteger(written.seq)) w.lastWrittenSeq = written.seq;
    w.state = state;
    return written;
  };
}

// A base_sha that answered after the record's last row was built: the next row would carry it, but a settled
// worker may write none, so restate the current state once with it (guarded, so a row someone else wrote since
// is never written over). Called by worker.cjs when its base lookup resolves.
function restateBase(w, ctx) {
  if ((!w.baseSha && (!w.baseError || w.baseError === NO_REPO)) || w.lastRowHadBase !== false || !w.state || w.state === 'forgotten') return;
  const launches = w.launches;
  w.queue = w.queue.then(() => {
    if (w.launches !== launches || w.lastRowHadBase) return null;
    return ctx.writeRow(w, w.settledState || w.state, { guard: true, refresh: true });
  }).catch((e) => {
    w.lastError = { where: 'worker.write/base-sha', code: e && e.code, message: e && e.message };
  });
}

// ADR 0039: the creation-time read (about a second) lands after the first rows. When it does and the last row
// went out without it, restate the current state once, guarded exactly as restateBase; a row someone else wrote
// since is never written over. Called by pid-identity.cjs when the read resolves.
function restatePidCreated(w, ctx, force = false) {
  if ((!force && w.lastRowHadPidCreated !== false) || !w.state || w.state === 'forgotten' || (w.pidCreated == null && !w.pidCreatedError)) return;
  const launches = w.launches;
  w.queue = w.queue.then(() => {
    if (w.launches !== launches || (!force && w.lastRowHadPidCreated)) return null;
    return ctx.writeRow(w, w.settledState || w.state, { guard: true, refresh: true });
  }).catch((e) => {
    w.lastError = { where: 'worker.write/pid-created', code: e && e.code, message: e && e.message };
  });
}

module.exports = { createWriteRow, restateBase, restatePidCreated };
