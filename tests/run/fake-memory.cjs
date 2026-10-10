'use strict';
// fake-memory.cjs — the fake core plus the memory surface the capture and jobs paths call: run.get (the
// levers), a memory.store that records every argument (and can be told to fail), memory.recordEvent and
// memory.events. Kept apart from fake-core.cjs so the base fake stays what the base suites were written
// against.

const crypto = require('node:crypto');
const { createFakeCore } = require('./fake-core.cjs');

// opts.levers: the memory block stored on the run row (null for none); opts.failStore: 'turn' | 'observation'
// | 'all' makes that store reject; opts.failEvent makes recordEvent reject.
function memoryCore(opts = {}) {
  const { levers = null, failStore = null, failEvent = false, runId = 'run-fake', resumeLineText = null } = opts;
  const core = createFakeCore({ runId, resumeLineText });
  const events = [];
  const stores = [];
  core.run = { get: async () => ({ run: { memory_levers: levers === null ? null : JSON.stringify(levers) } }) };
  const baseStore = core.memory.store;
  core.memory.store = async (a) => {
    stores.push(a);
    const kind = a.type === 'observation' ? 'observation' : 'turn';
    if (failStore === 'all' || failStore === kind) {
      core.calls.push({ method: 'memory.store', args: a, result: null });
      const e = new Error('store down');
      e.code = 'E_OWNER_LOST';
      throw e;
    }
    return baseStore(a);
  };
  core.memory.recordEvent = async (a) => {
    core.calls.push({ method: 'memory.recordEvent', args: a });
    if (failEvent) {
      const e = new Error('ledger down');
      e.code = 'E_OWNER_LOST';
      throw e;
    }
    const ev = { id: 'me-' + crypto.randomUUID(), ...a, ok: a.ok === undefined ? (a.code ? 0 : 1) : a.ok };
    events.push(ev);
    return ev;
  };
  core.memory.events = async (a) => ({ events: events.filter((e) => !a || !a.kinds || a.kinds.includes(e.kind)) });
  core.stores = stores;
  core.events = events;
  return core;
}

module.exports = { memoryCore };
