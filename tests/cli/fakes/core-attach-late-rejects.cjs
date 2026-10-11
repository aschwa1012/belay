'use strict';
// core-attach-late-rejects.cjs — ADR 0039 fixture. The real openCore, wrapped so run.attach rejects once, and only
// after the claude it attaches (orchestrator_pid) has exited and its exit event has been delivered: the case the
// attach-failure kill must not act on. Waiting on that event, never on a fixed delay, keeps the case true on a slow
// host, where a 900 ms delay let the rejection land while the quick fake claude was still running (and the kill of
// a live claude is then correct). The exit is seen through the ChildProcess handle, so this module wraps
// child_process.spawn to keep each handle by pid; it must be loaded before src/run/orchestrator-interactive.cjs
// takes its own reference to spawn (the test requires it first). Confined to tests/, per src/cli/cmd-run.cjs's
// BELAY_FAKE_CORE guard.

const cp = require('node:child_process');
const real = require('../../../src/core/index.cjs');
const { err } = require('../../../src/core/errors.cjs');

const EXIT_WAIT_MS = 60000; // a bound, not a delay: the claude here holds 100 ms, so this is reached only on a hang

const children = new Map();
const realSpawn = cp.spawn;
cp.spawn = function spawn(...a) {
  const child = realSpawn.apply(this, a);
  if (Number.isInteger(child.pid)) children.set(child.pid, child);
  return child;
};

// Resolves once the handle's 'exit' has been emitted. Node sets exitCode or signalCode in the same synchronous step
// that emits 'exit', so either being set means every earlier 'exit' listener (the orchestrator's own) has run.
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), EXIT_WAIT_MS);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

async function openCore(opts) {
  const core = await real.openCore(opts);
  let rejected = false;
  const original = core.run.attach;
  core.run.attach = async (args) => {
    if (!rejected) {
      rejected = true;
      const child = children.get(args && args.orchestrator_pid);
      if (!child) throw err('E_INTERNAL', `PROBE: the fixture saw no spawn of pid ${args && args.orchestrator_pid}`);
      const seen = await exited(child);
      throw err('E_INTERNAL', `PROBE: run.attach rejected late by the core-attach-late-rejects.cjs fixture (claude exit ${seen ? 'seen' : 'not seen within the bound'})`);
    }
    return original(args);
  };
  return core;
}

module.exports = { openCore };
