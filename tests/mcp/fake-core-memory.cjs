// fake-core-memory.cjs — the stand-in core of fake-core.cjs plus the three memory methods that ADR 0040
// adds (memory.timeline, memory.get_many, memory.setStatus) and a memory.get / memory.search that
// answer the new arguments. Each answers with the arguments it received and the caller it was opened
// for, so a test can prove the route and that identity came from argv, without a store. Used only through
// BELAY_FAKE_CORE, like fake-core.cjs, which it wraps.
'use strict';

const base = require('./fake-core.cjs');

async function openCore(opts) {
  const core = await base.openCore(opts);
  const who = core.__caller.worker_id || core.__caller.role;
  const echo = (method, a) => ({ method, __args: a, __caller: { role: core.__caller.role, worker_id: core.__caller.worker_id || null, run_id: core.__caller.run_id } });
  const plainGet = core.memory.get;
  core.memory.get = async (a = {}) => (Array.isArray(a.ids)
    ? { ...echo('memory.get', a), rows: a.ids.map((id) => ({ id, found: true })), found: a.ids.length, missing: [] }
    : plainGet(a));
  core.memory.search = async (a = {}) => ({
    ...echo('memory.search', a),
    warning: null, results: [], scanned: 0, model: 'fake-embed', dim: 4,
    modes_run: [a.mode || 'semantic'], modes_failed: [], absence_established: false,
  });
  core.memory.timeline = async (a = {}) => ({ ...echo('memory.timeline', a), anchor: { id: a.anchor_id }, before: [], after: [], scope: a.scope || 'namespace', scope_key: 'ns' });
  core.memory.getMany = async (a = {}) => ({ ...echo('memory.get_many', a), rows: [], found: 0, missing: a.ids || [] });
  core.memory.setStatus = async (a = {}) => ({
    ...echo('memory.setStatus', a),
    id: a.id, status: a.status, previous_status: 'unverified', status_receipt: a.receipt, status_by: who, status_at: 1757000000000,
  });
  const store = core.memory.store;
  core.memory.store = async (a = {}) => ({ ...(await store(a)), __args: a });
  return core;
}

module.exports = { ...base, openCore };
