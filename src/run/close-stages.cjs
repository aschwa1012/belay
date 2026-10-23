'use strict';
// close-stages.cjs — the stages of run close that spawn a model child: the scrubber, then the archive reviewer. `belay run` calls
// closeStages once its workers are closed and before run.end and the owner's shutdown (ADR 0029's order; the run process is the
// parent of the child, invariants 1 and 2). `belay memory scrub` and `belay memory review` call the same stages by hand.
//
// Both stages ask the core what is in scope before anything else, so a run with nothing to do spends two reads and spawns, creates and
// imports nothing: the run manager is built only when a child is to be spawned. With `memory.notes` off this is a no-op that touches
// no store at all.

const { runScrub } = require('./scrub-stage.cjs');
const { runReview } = require('./review-stage.cjs');

// A lazily-built run manager for the stages' children. `makeManager` is the test seam; the default is the real run manager over the
// harness view of the core. The manager is never `shutdown()`: that would stop the store owner this process holds. Each stage stops
// its own child by exact pid (the manager's `stop`), and a manager with no workers left holds nothing else.
function lazyManager({ core, runId, dataDir, lv, worktree, paths, makeManager }) {
  let m = null;
  return async () => {
    if (m) return m;
    m = makeManager ? await makeManager() : require('./index.cjs').createRunManager({ core, dataDir, runId, memoryLevers: lv, worktree, paths: paths || {} });
    return m;
  };
}

// `fast()` true is a fast close (a console closing): nothing is spawned, a child already running is killed by its exact pid, and the
// scrub's items are recorded as owed. `log(line)` tells the operator what a stage is about to spend, since a stage can take minutes.
// opts: { core (the harness view), runId, levers (the memory lever block), dataDir, worktree, goal, summary, paths, makeManager, review }.
// `review` is true (default) to run the archive reviewer after the scrub. Returns { scrub, review }, or null with notes off.
async function closeStages({ core, runId, levers, dataDir, worktree = null, goal = null, summary = null, paths = null, makeManager = null, review = true, fast = null, log = null, sink = null, sweep = null }) {
  const lv = levers && levers.memory_levers ? levers.memory_levers : levers;
  if (!lv || !lv.notes) return null;
  const getManager = lazyManager({ core, runId, dataDir, lv, worktree, paths, makeManager });
  const out = { scrub: null, review: null };
  // First, the store-only note-review sweep: a report a finished job upheld is applied before the scrub can archive its note (the sweep it
  // would otherwise wait for runs after the stages). Skipped in a fast close, whose run-end sweep still runs.
  if (sweep && !(fast && fast())) { try { out.sweep = await sweep(); } catch (e) { out.sweep = { ran: false, message: String(e && e.message).slice(0, 200) }; } }
  try { out.scrub = await runScrub({ core, runId, lv, dataDir, getManager, worktree, goal, summary, fast, log, sink }); } catch (e) { out.scrub = { ran: false, reason: 'stage crashed', message: String(e && e.message).slice(0, 200) }; }
  if (review) {
    // ADR 0052: the operator's review may be running beside this run (the panel's button); the automatic one does not start a second reviewer.
    try { out.review = await runReview({ core, runId, lv, dataDir, getManager, worktree, fast, log, sink, respectClaim: true }); } catch (e) { out.review = { ran: false, reason: 'stage crashed', message: String(e && e.message).slice(0, 200) }; }
  }
  return out;
}

module.exports = { closeStages, lazyManager };
