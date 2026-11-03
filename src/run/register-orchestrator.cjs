'use strict';
// register-orchestrator.cjs — the headless orchestrator in the machine-wide spawn register, split out of cmd-run.cjs so its wiring
// can be tested. The record is written at once and a register that cannot be written throws (the orchestrator runner ends the child
// before its first prompt: a launch that fails open would leave other stores taking its descendants for operators). It is then
// stamped while the orchestrator hook says the child has not exited (the run's own exit facts, never a bare pid check), so a run
// process that dies without its exit handler leaves a record that closes near the last stamp and not near the spawn. At the run
// process's exit the stamp stops and the record is unregistered.
// The record is written without the orchestrator's creation time (it is not known at the spawn), and a record with none matches by pid
// alone: a process that reuses the pid inside an intact chain would be refused while the record is live. So the creation time is read
// once the snapshot has it, as a worker's is (pid-identity.cjs), accepted only for a child that has not exited and was not created
// before the spawn call, written onto the record, and handed to `onCreated` for the run's own list of what it spawned.

const SR = require('../core/spawn-register.cjs');
const { stampWhile } = require('./seen-stamp.cjs');
const ID = require('../core/proc-identity.cjs');

const READ_SCHEDULE_MS = [0, 30000, 60000, 120000, 300000, 300000, 300000]; // when the creation time is asked for, from the registration
const SPAWN_SLACK_MS = 1000; // a reading may not be earlier than this before the spawn call

// `h` is the hook orchestrator.cjs attaches: { pid, exited() }. `seams` are for tests.
function registerOrchestrator(h, { dataDir, proc = process, register = SR, stamp = stampWhile, stampOpts = {}, createdOf = (p) => ID.createdOf(p, { kind: 'spawn-read' }), schedule = READ_SCHEDULE_MS, onCreated = null } = {}) {
  const pid = h && h.pid;
  if (!Number.isInteger(pid)) return null;
  // The stamp follows the hook's own exit facts. A hook without them would stamp nothing, and the record would then close soon after the spawn
  // (a fail-open): refuse, so a renamed key cannot silently stop the stamping.
  if (typeof h.exited !== 'function') throw new Error(`the orchestrator hook (pid ${pid}) has no exited() function, so its spawn register record could not be stamped while it lives`);
  const spawnedAt = Date.now();
  register.registerProcess({ pid, kind: 'orchestrator', dataDir, spawnedAt }, 'the headless orchestrator');
  const stamper = stamp(() => typeof h.exited === 'function' && !h.exited(), pid, stampOpts);
  let done = false; let timer = null;
  const expect = { kind: 'orchestrator', dataDir, spawnedAt };
  const attempt = (i) => {
    if (done) return;
    Promise.resolve().then(() => createdOf(pid)).then((r) => {
      if (done) return;
      if (r && Number.isFinite(r.created) && r.created >= spawnedAt - SPAWN_SLACK_MS && !h.exited()) {
        done = true;
        if (register.update(pid, r.created, expect) && onCreated) onCreated(r.created);
      } else next(i);
    }, () => next(i));
  };
  const next = (i) => {
    if (done || i + 1 >= schedule.length || h.exited()) return;
    timer = setTimeout(() => attempt(i + 1), schedule[i + 1] - schedule[i]);
    if (timer.unref) timer.unref();
  };
  attempt(0);
  proc.once('exit', () => { done = true; clearTimeout(timer); stamper.stop(); register.unregister(pid, expect); });
  return stamper;
}

module.exports = { registerOrchestrator };
