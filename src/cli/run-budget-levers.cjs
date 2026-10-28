'use strict';
// run-budget-levers.cjs — the run's dollar budget lever. `budget_usd` in the run spec (a positive number, or null to turn a
// project default off for one run) over `run.budget_usd` in belay.config.json, over nothing: absent means off. A run with a budget
// writes the usage ledger whatever the memory lever cost_ledger says, and its recorded levers say so. Kept apart from the memory
// block's parsing (run-levers.cjs) so the two levers' code does not meet.

const ML = require('../core/memory-levers.cjs');

const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// Adds budget_usd / budget_source to `out` (the levers) when a budget applies, and turns the ledger on. Returns { error } or {}.
// `opts.config` is { path, memory, run } as run-spec.cjs passes it.
function applyBudget(out, spec, opts = {}) {
  let value, source = null;
  if (spec.budget_usd !== undefined) {
    if (spec.budget_usd !== null && !valid(spec.budget_usd)) return { error: 'budget_usd must be a positive number (the run\'s spend limit in dollars) or null' };
    value = spec.budget_usd; source = value === null ? 'spec (off)' : 'spec';
  } else if (opts.config && opts.config.run && opts.config.run.budget_usd !== undefined && opts.config.run.budget_usd !== null) {
    if (!valid(opts.config.run.budget_usd)) return { error: `run.budget_usd in ${opts.config.path} must be a positive number (dollars at API rates)` };
    value = opts.config.run.budget_usd; source = opts.config.path;
  }
  if (!valid(value)) { if (source) out.budget_source = source; return {}; } // a spec null is recorded, so a restart does not read it as "not stated"
  out.budget_usd = value;
  out.budget_source = source;
  const have = out.memory_levers;
  if (have) have.cost_ledger = true;
  else {
    const full = { ...ML.parseMemoryBlock({ cost_ledger: true }).value };
    delete full.on_embedder_failure;
    for (const k of ML.EVAL_ONLY) delete full[k];
    out.memory_levers = full;
  }
  if (out.memory_sources) out.memory_sources.cost_ledger = 'budget';
  return {};
}

module.exports = { applyBudget };
