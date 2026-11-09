'use strict';
// resume-fallback.cjs — a restart resumes the worker's session whatever its age (restart.cjs decideBranch). When that resume does not come up (the process
// exited before its ready event: Claude Code could not find the session, Codex could not resume the thread), the restart is made once more on the replace
// branch with the reason recorded. The first attempt's process is already ended and its `dead` row written (start-fail.cjs failNoReady) before this runs, so
// there is one process at a time; a failure of the second attempt is the restart's own error. A resume of a park (pause.cjs) goes back to parked instead.

// -> the failure's reason when the error is a resume that never reached ready, else null.
function resumeFailure(w, e, opts) {
  if (opts.skipDeadPidKill || opts.forceReplace || w.nativeMemoryRefused || w.readyAt) return null;
  if (!(e && e.code === 'E_NO_READY' && e.detail && e.detail.branch === 'resume' && !e.detail.stopped_during_launch)) return null;
  return `the resume failed (${e.detail.reason || e.message}); replaced with a fresh conversation`;
}

// `inner(w, opts)`: the restart on one branch; opts.forceReplace names why the branch is replace.
const withFallback = (inner) => async (w, opts = {}) => {
  try { return await inner(w, opts); } catch (e) {
    const why = resumeFailure(w, e, opts);
    if (!why) throw e;
    return inner(w, { ...opts, forceReplace: why });
  }
};

module.exports = { withFallback, resumeFailure };
