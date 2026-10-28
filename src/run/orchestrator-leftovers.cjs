'use strict';
// orchestrator-leftovers.cjs — the processes a headless orchestrator's shell started and left running (a backgrounded test run, a
// dev server, a `claude -p`). A graceful close orphans them, and they would outlive the run (invariant 1). Before the close ends the
// orchestrator, its verified descendants are taken from one snapshot (pause.cjs does the same for a worker); once it has exited,
// each is ended by its exact pid after its creation time and image are checked again, so a pid that has since been reused by
// another process is refused (ADR 0039; BELAY_KILL_LOG logs each attempt). Never a tree kill by name or by taskkill /T.
// The interactive orchestrator's close is the human's, and its descendants are the console's, so it does not use this.
const IDENTITY = require('../core/proc-identity.cjs');

function createLeftovers({ child, P, state }) {
  let taking = null; // the one capture, started by the first close
  let targets = [];
  async function take() {
    if (!IDENTITY.handleLive(child)) return; // an exit already seen: its pid may belong to another process now
    const root = await P.createdOf(child.pid).catch(() => null);
    if (!root) return; // the root's identity is unknown, so its children are not known to be ours
    targets = await P.descendantTargets(child.pid, { expectCreated: root.created }).catch(() => []);
  }
  return {
    // Resolves once the descendants are recorded; call it before the orchestrator's stdin is closed. Idempotent.
    capture() { if (!taking) taking = take(); return taking; },
    // After the orchestrator has exited (or been killed): end what is still alive. -> the receipt, also kept as state.leftovers.
    async end() {
      if (taking) await taking;
      const results = targets.length ? await P.killMany(targets).catch(() => []) : [];
      state.leftovers = {
        found: targets.map((t) => t.pid),
        killed: results.filter((r) => r.killed).map((r) => r.pid),
        refused: results.filter((r) => r.refused).map((r) => ({ pid: r.pid, kind: r.kind || null, detail: r.detail || null })),
      };
      return state.leftovers;
    },
  };
}

module.exports = { createLeftovers };
