'use strict';
// resume-fallback.cjs — a restart resumes the worker's session whatever its age (restart.cjs decideBranch). When that resume does not come up (the process
// exited before its ready event: Claude Code could not find the session, Codex could not resume the thread), the restart is made once more on the replace
// branch with the reason recorded. Known gap: a Codex thread that starts and then fails its turn is not caught here; no receipt shows the error such a failure gives.
// The failed attempt's process is ended before the second starts, so one process runs at a time. Its `dead` row is NOT written while a second launch follows
// (start-fail.cjs: w.deferDead): the worker did not die for the run, it is being relaunched, and a death wake would be false. If no second launch follows, the row
// is written here. A failure of the second attempt is the restart's error and carries the first attempt's reason (detail.resume_failed). A resume of a park
// (pause.cjs) goes back to parked instead.

// -> the failure's reason when the error is a resume that never reached ready, else null.
// What happened to a resume that exited by itself before ready: its exit code and the first line of its stderr, redacted and bounded.
function exitedWhy(d) {
  const line = String(d.stderr_tail || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  const text = line ? require('../core/redact.cjs').redact(line).text.slice(0, 200) : '';
  return `the process exited before it was ready${d.exit_code != null ? ` (exit code ${d.exit_code})` : ''}${text ? `: ${text}` : ''}`;
}

// `killed(w)`: an operator's kill ended the process the row names; belay does not undo it with a fresh conversation.
function resumeFailure(w, e, opts, killed) {
  if (opts.skipDeadPidKill || opts.forceReplace || w.nativeMemoryRefused || w.readyAt) return null;
  if (!(e && e.code === 'E_NO_READY' && e.detail && e.detail.branch === 'resume' && !e.detail.stopped_during_launch)) return null;
  if (killed && killed(w)) return null;
  return `the resume failed (${e.detail.exited_before_ready ? exitedWhy(e.detail) : e.detail.reason || e.message}); replaced with a fresh conversation`;
}

// `inner(w, opts)`: the restart on one branch; opts.forceReplace names why the branch is replace. `settleDead(w)` writes the row a deferred death left unwritten.
const withFallback = (inner, settleDead, killed = null) => async (w, opts = {}) => {
  const eligible = !opts.skipDeadPidKill && !opts.forceReplace;
  w.deferDead = eligible; w.deferFrom = w.launches; w.deadDeferred = false; // only a process launched from here on is deferred: the life before this restart still gets its dead row
  try { return await inner(w, opts); } catch (e) {
    w.deferDead = false;
    const why = resumeFailure(w, e, opts, killed);
    if (!why) { if (w.deadDeferred) { w.deadDeferred = false; await settleDead(w).catch(() => {}); } throw e; }
    w.deadDeferred = false;
    const launches = w.launches;
    try { return await inner(w, { ...opts, forceReplace: why }); } catch (e2) {
      if (w.launches === launches) await settleDead(w).catch(() => {}); // the replacement refused before it launched (paused, a hold refused): the deferred dead row is still owed
      if (e2 && e2.detail && typeof e2.detail === 'object') e2.detail.resume_failed = why;
      throw e2;
    }
  } finally { w.deferDead = false; }
};

module.exports = { withFallback, resumeFailure };
