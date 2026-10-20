'use strict';
// memory-levers.cjs — ADR 0041 decision 1: the run's memory levers. `parseMemoryBlock` validates the spec's
// optional `memory` block; `leversFor` reads the parsed block back from the run row once and caches it for
// the life of the manager; `isDefault` says whether a block differs from the defaults (the receipt prints
// `memory_levers` only then). A run without the block has every lever at its default, and every lever that
// does anything new defaults off.

const core = require('../core/memory-levers.cjs'); // the pure spec, shared with run.attach
const { defaultLevers, parseMemoryBlock, isDefault } = core;
// What a run with no memory block has: the core's defaults with `notes` resolved to off (it needs a project, which is never derived).
const DEFAULTS = Object.freeze(defaultLevers());

// One read per manager. The cache holds the promise, so concurrent callers share the read; a failed read is
// not cached, so the next call tries again. A row with no block (an older run, or a run that gave none) is
// the defaults, and so is an unreadable column: a bad stored value is never silently half-applied.
const cache = new WeakMap(); // core -> Map(runId -> Promise<levers>)

// The levers a run row records: its parsed memory block, or the defaults for none or an unreadable one.
function leversOfRow(row) {
  const raw = row ? row.memory_levers : null;
  if (raw == null) return defaultLevers();
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return defaultLevers(); }
  const parsed = parseMemoryBlock(obj);
  return parsed.error ? { ...DEFAULTS } : parsed.value;
}

async function readLevers(core, runId) {
  const got = await core.run.get();
  // run.get answers for the caller's own run only; a different runId would silently get that run's levers.
  if (core.caller && core.caller.run_id !== undefined && core.caller.run_id !== runId) {
    throw new Error(`leversFor(${runId}): this core is bound to run ${core.caller.run_id}, and run.get reads only that run`);
  }
  if (got && got.run && got.run.id !== undefined && got.run.id !== runId) {
    throw new Error(`leversFor(${runId}): run.get answered for run ${got.run.id}`);
  }
  return leversOfRow(got && got.run);
}

function leversFor(core, runId) {
  let byRun = cache.get(core);
  if (!byRun) { byRun = new Map(); cache.set(core, byRun); }
  if (!byRun.has(runId)) {
    const p = readLevers(core, runId).catch((e) => { byRun.delete(runId); throw e; });
    byRun.set(runId, p);
  }
  return byRun.get(runId);
}

module.exports = { DEFAULTS, defaultLevers, parseMemoryBlock, leversFor, leversOfRow, isDefault };
