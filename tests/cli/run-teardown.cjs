'use strict';
// run-teardown.cjs — 6i-2 integration fix-up (the lead's item 1: tests/cli/run-wake.test.cjs was 507
// lines, over the 500-line budget). This is the run-owning teardown tests/cli/run-wake.test.cjs and
// tests/cli/worker.test.cjs's live-run-manager test shared in purpose but each defined for itself;
// moved here whole, unchanged, so both import it instead of each keeping its own copy.
//
// build step 6i-2 fix round (item 4/R5, established from the code and one instrumented run): `belay run`
// is the run's own orchestrator process, not only the store's owner — `core.shutdownOwner()` unelects the
// store role inside whatever process holds it (a test's own `core`, since its RunManager's writes land
// through it), a different process than the spawned `belay run` subprocess entirely, so it never touches
// the run process at all; that is why the old teardown always fell through to killTree. The designed way
// to end the run process is `run.stop` over its own owner pipe (src/cli/cmd-stop.cjs's
// `core.control('run.stop', ...)`), the same call `belay stop` sends; issued before the manager's own
// `shutdown()`. api.md §2: the three run controls are operator-only (E_ROLE otherwise) — a test's own
// `core` is role `orchestrator` (the manager's own role), so `run.stop` is issued over a short-lived
// `operator`-role client of its own, exactly as `cmd-stop.cjs` opens one. P.killTree on the exact spawned
// pid is the fallback only when that call or the process's own exit does not land inside the bound.

const P = require('../../src/run/process.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { waitForExit, releaseCore } = require('./stop-helpers.cjs');

async function endOwnerProcess(proc, dataDir, runId) {
  if (proc.exitCode !== null) return 'already-exited';
  if (dataDir && runId) {
    try {
      const opCore = await openCore({ dataDir, caller: { role: 'operator', run_id: runId, pid: process.pid } });
      try { await opCore.control('run.stop', { run_id: runId }, { timeoutMs: 60000 }); } finally { await opCore.close(); }
    } catch { /* best effort: already stopped, or refused */ }
  }
  const exited = await waitForExit(proc, 5000);
  if (exited || proc.exitCode !== null) return 'run.stop';
  try { await P.killTree(proc); } catch { /* best effort */ }
  return 'killTree';
}

// tests/cli/run-wake.test.cjs's own per-test teardown: ends the CLI's own owner process, shuts down the
// in-process RunManager, force-kills any still-live spawned worker pids, closes the orchestrator core,
// then removes the sandbox. `cleanup` is the caller's own sandbox remover (fs.rmSync with retry), passed
// in rather than imported, so this module makes no assumption about which test file's layout it clears.
async function cleanupRun({ m, core, cliProc, spawnedPids, dir, runId, cleanup, label = 'run-wake' }) {
  delete process.env.FAKE_HANG;
  delete process.env.FAKE_ANSWER_DELAY_MS;
  // build step 6i-2 fix round (item 4/R5): run.stop over the run's own owner pipe, issued before
  // m.shutdown() — the record of which one actually ended it is the plant table's own check (Q13).
  const endedBy = await endOwnerProcess(cliProc.proc, `${dir}/.belay`, runId);
  console.log(`[6i-2 item4] ${label} owner ended by: ${endedBy}`);
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  for (const p of spawnedPids || []) require('../crash.cjs').crash(p.pid, p.created); // the row's own creation time, or no signal (ADR 0039)
  await releaseCore(core);
  cleanup(dir);
}

module.exports = { endOwnerProcess, cleanupRun };
