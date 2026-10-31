'use strict';
// register-orchestrator.cjs — the headless orchestrator in the machine-wide spawn register, split out of cmd-run.cjs so its wiring
// can be tested. The record is written at once and a register that cannot be written throws (the orchestrator runner ends the child
// before its first prompt: a launch that fails open would leave other stores taking its descendants for operators). It is then
// stamped while the orchestrator hook says the child has not exited (the run's own exit facts, never a bare pid check), so a run
// process that dies without its exit handler leaves a record that closes at the last stamp and not at the spawn. At the run
// process's exit the stamp stops and the record is unregistered.

const SR = require('../core/spawn-register.cjs');
const { stampWhile } = require('./seen-stamp.cjs');

// `h` is the hook orchestrator.cjs attaches: { pid, exited() }. `seams` are for tests.
function registerOrchestrator(h, { dataDir, proc = process, register = SR, stamp = stampWhile, stampOpts = {} } = {}) {
  const pid = h && h.pid;
  if (!Number.isInteger(pid)) return null;
  // The stamp follows the hook's own exit facts. A hook without them would stamp nothing, and the record would then close at the spawn
  // (a fail-open): refuse, so a renamed key cannot silently stop the stamping.
  if (typeof h.exited !== 'function') throw new Error(`the orchestrator hook (pid ${pid}) has no exited() function, so its spawn register record could not be stamped while it lives`);
  register.registerProcess({ pid, kind: 'orchestrator', dataDir, spawnedAt: Date.now() }, 'the headless orchestrator');
  const stamper = stamp(() => typeof h.exited === 'function' && !h.exited(), pid, stampOpts);
  proc.once('exit', () => { stamper.stop(); register.unregister(pid, { kind: 'orchestrator', dataDir }); });
  return stamper;
}

module.exports = { registerOrchestrator };
