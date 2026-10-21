'use strict';
// memory-levers.cjs — ADR 0041 decision 1: the run's memory levers. `parseMemoryBlock` validates the spec's
// optional `memory` block; `leversFor` reads the parsed block back from the run row once and caches it for
// the life of the manager; `isDefault` says whether a block differs from the defaults (the receipt prints
// `memory_levers` only then). A run without the block has every lever at its default, and every lever that
// does anything new defaults off.

const core = require('../core/memory-levers.cjs'); // the pure spec, shared with run.attach
const { defaultLevers, EVAL_ONLY, parseMemoryBlock, isDefault } = core;
// What a run with no memory block has: the core's DEFAULTS, the one source (notes off: it needs a project, which is never derived).
const DEFAULTS = Object.freeze(defaultLevers());

// One read per manager. The cache holds the promise, so concurrent callers share the read; a failed read is
// not cached, so the next call tries again. A row with no block (an older run, or a run that gave none) is
// the defaults, and so is an unreadable column: a bad stored value is never silently half-applied.
const cache = new WeakMap(); // core -> Map(runId -> Promise<levers>)

// The levers a run row records: its parsed memory block, or the defaults for none or an unreadable one. An unreadable value that
// may have carried an eval-only lever (text that is not JSON, a non-object, or a block naming native_memory or handback_question
// that does not validate) is still the defaults for every other reader, but the object carries an unread marker (non-enumerable,
// so it never shows in a copy or a listing) that a spawn which needs those levers reads with `unreadOf` and refuses on.
const UNREAD = Symbol.for('belay.levers.unread');
const unreadOf = (lv) => (lv && lv[UNREAD]) || null;
function defaultsUnread(reason) {
  const lv = { ...DEFAULTS };
  Object.defineProperty(lv, UNREAD, { value: reason, enumerable: false });
  return lv;
}
function leversOfRow(row) {
  const raw = row ? row.memory_levers : null;
  if (raw == null) return defaultLevers();
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return defaultsUnread('the stored memory levers are not valid JSON'); }
  const parsed = parseMemoryBlock(obj, { stored: true }); // the removed note-review keys of an older run are dropped, never refused
  if (!parsed.error) return parsed.value;
  const plain = obj !== null && typeof obj === 'object' && !Array.isArray(obj);
  if (!plain) return defaultsUnread(parsed.error);
  return EVAL_ONLY.some((k) => Object.prototype.hasOwnProperty.call(obj, k)) ? defaultsUnread(parsed.error) : { ...DEFAULTS };
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

module.exports = { DEFAULTS, defaultLevers, EVAL_ONLY, parseMemoryBlock, leversFor, leversOfRow, unreadOf, isDefault };
