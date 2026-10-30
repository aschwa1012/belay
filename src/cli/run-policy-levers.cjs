'use strict';
// run-policy-levers.cjs — the user's default plan for a run (ADR 0071 decision 3). `policy` in the run spec (an object, or null to turn a
// project default off for one run) merged field by field over `run.policy` in belay.config.json, over nothing: belay ships no value. The object is checked with the
// task plan's own rules, so a value v1 does not accept is refused at launch, before any process starts. A task's own policy still wins over
// it, field by field, at task.create. Kept apart from the budget and memory levers so the three do not meet.

const PP = require('../core/policy-plan.cjs');

// Adds policy_default / policy_source to `out` when a default applies. Returns { error } or {}. `opts.config` is { path, memory, run }.
// Field by field, spec over config: a spec field beats the config's, the config fills what the spec leaves unsaid; a spec null turns the
// config's default off for the run. A task's own plan still beats both at task.create.
function applyPolicy(out, spec, opts = {}) {
  const cfgPath = opts.config && opts.config.path;
  let fromConfig = null, fromSpec = null;
  if (opts.config && opts.config.run && opts.config.run.policy !== undefined && opts.config.run.policy !== null) {
    try { fromConfig = PP.check(opts.config.run.policy, `run.policy in ${cfgPath}`); } catch (e) { return { error: e.message }; }
  }
  if (spec.policy !== undefined && spec.policy !== null) {
    try { fromSpec = PP.check(spec.policy, 'spec policy'); } catch (e) { return { error: e.message }; }
  }
  const off = spec.policy === null;
  const value = off ? null : PP.resolve(fromSpec, fromConfig);
  const sources = [];
  if (off) sources.push('spec (off)');
  else {
    if (fromSpec && Object.keys(fromSpec).length) sources.push('spec');
    if (fromConfig && Object.keys(fromConfig).length) sources.push(cfgPath);
  }
  if (spec.policy !== undefined && !sources.length) sources.push('spec'); // an empty spec plan is stated too
  if (sources.length) out.policy_source = sources.join(' + '); // a spec null is recorded, so a restart does not read it as "not stated"
  if (value) out.policy_default = value;
  return {};
}

module.exports = { applyPolicy };
