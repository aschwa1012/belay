'use strict';
// run-identity.cjs — ADR 0039 decision 1 for `belay run`: the creation times of the two processes the run
// itself starts or is. Neither read may delay the run: the orchestrator's own adapter attaches right after
// this process does and the epoch order is part of the contract. So this process's time is prefetched when
// the run begins and used at attach if it is done by then (else null), and the orchestrator's is read beside
// the attach and lands in the receipt (`orchestrator.pid_created`, or null with `pid_created_error`).

const P = require('../core/process.cjs');
const ID = require('../core/proc-identity.cjs');

function createRunIdentity(ownPid) {
  const own = ID.ownCreatedProbe(ownPid); // a failed read is requested again, never awaited (ADR 0048 decision 3)
  let orch = null; let orchPid = null;
  return {
    // This process's creation time for run.attach, never waiting on the snapshot.
    ownNow() { return own(); },
    // The same, but waits for one snapshot when the probe has nothing yet, so the run row carries a real creation time (a later run uses it to tell a reused pid).
    async ownCreated() { return (await own()) ?? P.createdOf(process.pid, { kind: 'own-probe' }).then((x) => (x ? x.created : null), () => null); },
    watchOrchestrator(pid) { orchPid = pid; orch = P.createdOf(pid, { kind: 'spawn-read' }).catch(() => null); },
    // { pid, created } of the orchestrator this run spawned, or null when its creation time was never read (ADR 0029 amendment 4).
    async orchestratorRef() {
      if (!orch) return null;
      const r = await orch;
      return r && r.created != null ? { pid: orchPid, created: r.created } : null;
    },
    async orchestratorFacts() {
      if (!orch) return { pid_created: null, pid_created_error: 'the orchestrator was never started' };
      const r = await orch;
      return r && r.created != null ? { pid_created: r.created, pid_created_error: null }
        : { pid_created: null, pid_created_error: `the process snapshot had no creation time for pid ${orchPid} (unreadable, or the process had already gone)` };
    },
  };
}

module.exports = { createRunIdentity };
