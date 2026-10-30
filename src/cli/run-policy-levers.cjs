'use strict';
// run-policy-levers.cjs — the user's default plan for a run (ADR 0071 decision 3). `policy` in the run spec (an object, or null to turn a
// project default off for one run) over `run.policy` in belay.config.json, over nothing: belay ships no value. The object is checked with the
// task plan's own rules, so a value v1 does not accept is refused at launch, before any process starts. A task's own policy still wins over
// it, field by field, at task.create. Kept apart from the budget and memory levers so the three do not meet.

const PP = require('../core/policy-plan.cjs');

// Adds policy_default / policy_source to `out` when a default applies. Returns { error } or {}. `opts.config` is { path, memory, run }.
function applyPolicy(out, spec, opts = {}) {
  let value, source = null;
  if (spec.policy !== undefined) {
    value = spec.policy; source = value === null ? 'spec (off)' : 'spec';
    if (value !== null) { try { value = PP.check(value, 'spec policy'); } catch (e) { return { error: e.message }; } }
  } else if (opts.config && opts.config.run && opts.config.run.policy !== undefined && opts.config.run.policy !== null) {
    try { value = PP.check(opts.config.run.policy, `run.policy in ${opts.config.path}`); } catch (e) { return { error: e.message }; }
    source = opts.config.path;
  }
  if (source) out.policy_source = source; // a spec null is recorded too, so a restart does not read it as "not stated"
  if (value && Object.keys(value).length) out.policy_default = value;
  return {};
}

module.exports = { applyPolicy };
