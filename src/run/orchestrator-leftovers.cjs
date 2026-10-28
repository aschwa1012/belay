'use strict';
// orchestrator-leftovers.cjs — the processes a headless orchestrator's shell started and left running (a backgrounded test run, a
// dev server, a `claude -p`). A graceful close orphans them, and they would outlive the run (invariant 1). Before the close ends the
// orchestrator, its descendants are taken from one snapshot (pause.cjs does the same for a worker), minus everything belay owns:
// the orchestrator's MCP adapter (the run row's adapter_pid with its creation time) and every process in the spawn register
// (the workers it spawned), each with its whole subtree. Those have their own close (ADR 0029; run-close.cjs). The rest is ended by
// exact pid, after the run's own close has finished, once its creation time and image are checked again (killMany, ADR 0039: a
// pid that now belongs to another process is refused; BELAY_KILL_LOG logs each attempt; never taskkill /T, never a name).
// Fails closed: without a run row that names the adapter, or if the owned processes cannot be read, nothing is taken.
// The interactive orchestrator's close is the human's, and its descendants are the console's, so it does not use this.
const IDENTITY = require('../core/proc-identity.cjs');

// -> { adapterKnown, list: [{ pid, created }] } of the processes belay owns; throws when they cannot be read.
// Read with run.list, not run.get: the close's own first run.get must stay the close's. The run row's adapter is the MCP adapter once it has
// attached; until then it is belay run's own process, which is not the adapter, so it does not count as one.
async function ownedProcesses(core, runId) {
  const row = (((await core.run.list({})) || {}).runs || []).find((r) => r.id === runId) || {};
  const list = require('../core/spawn-register.cjs').list().map((r) => ({ pid: r.pid, created: r.created }));
  const adapterKnown = Number.isInteger(row.adapter_pid) && row.adapter_pid !== process.pid && row.adapter_pid_created != null;
  if (Number.isInteger(row.adapter_pid)) list.push({ pid: row.adapter_pid, created: row.adapter_pid_created == null ? null : row.adapter_pid_created });
  return { adapterKnown, list };
}

function createLeftovers({ child, P, state, core, runId, owned = () => ownedProcesses(core, runId) }) {
  let taking = null; // the one capture, started by the first close
  let targets = [];
  let why = null;
  async function take() {
    if (!IDENTITY.handleLive(child)) return; // an exit already seen: its pid may belong to another process now
    const { snap } = await P.snapshotShared({ kind: 'orchestrator-leftovers' }).catch(() => ({ snap: null }));
    const root = snap && snap.get(child.pid);
    if (!root || root.created == null) { why = 'the orchestrator\'s own identity could not be read'; return; }
    let own;
    try { own = await owned(); } catch (e) { why = `the processes belay owns could not be read: ${(e && e.message) || e}`; return; }
    if (!own.adapterKnown) { why = 'the run row names no adapter, so the processes belay owns cannot be told from the shell\'s'; return; }
    const skip = new Set();
    for (const o of own.list) {
      const e = snap.get(o.pid);
      if (!e || (o.created != null && e.created !== o.created)) continue; // gone, or the pid now belongs to another process
      skip.add(o.pid);
      for (const d of IDENTITY.descendantsOf(o.pid, snap).leavesFirst) skip.add(d.pid);
    }
    targets = IDENTITY.descendantsOf(child.pid, snap).leavesFirst.filter((t) => !skip.has(t.pid));
  }
  return {
    // Resolves once the descendants are recorded; call it before the orchestrator's stdin is closed. Idempotent.
    capture() { if (!taking) taking = take(); return taking; },
    // After the orchestrator has exited and the run's own close has finished: end what is still alive.
    async end() {
      if (state.leftovers) return state.leftovers;
      if (taking) await taking;
      const results = targets.length ? await P.killMany(targets).catch(() => []) : [];
      state.leftovers = {
        found: targets.map((t) => t.pid),
        killed: results.filter((r) => r.killed).map((r) => r.pid),
        refused: results.filter((r) => r.refused).map((r) => ({ pid: r.pid, kind: r.kind || null, detail: r.detail || null })),
        ...(why ? { not_taken: why } : {}),
      };
      return state.leftovers;
    },
  };
}

module.exports = { createLeftovers, ownedProcesses };
