'use strict';
// run-policy-levers.cjs — the user's default plan for a run (ADR 0071 decision 3). `policy` in the run spec (an object, or null to turn a
// project default off for one run) merged field by field over `run.policy` in belay.config.json, over belay's own plan-first default
// (SHIPPED_PLAN, 0.4.0; ADR 0074 amendment 4): every work task is built, reviewed, fixed by its builder, re-reviewed by its refuter and
// merged once its review holds, unless the spec or the config says otherwise or the orchestrator overrides a task. The object is checked with the
// task plan's own rules, so a value v1 does not accept is refused at launch, before any process starts. A task's own policy still wins over
// it, field by field, at task.create. Kept apart from the budget and memory levers so the three do not meet.

const PP = require('../core/policy-plan.cjs');

// The plan a run takes when neither the spec nor the config states one. A spec or config field replaces its field; `policy: null` in the spec turns
// it off for the run. The reviewer and the builder are spawned in the task's own belay worktree, so tasks are created with `worktree: true`.
const SHIPPED_PLAN = Object.freeze({ build: { spawn: { agent_type: 'coder' } }, review: { spawn: { agent_type: 'reviewer' } }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' });

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
  const value = off ? null : PP.resolve(fromSpec, PP.resolve(fromConfig, SHIPPED_PLAN));
  const sources = [];
  if (off) sources.push('spec (off)');
  else {
    if (fromSpec && Object.keys(fromSpec).length) sources.push('spec');
    if (fromConfig && Object.keys(fromConfig).length) sources.push(cfgPath);
    sources.push('belay default'); // whatever the spec and the config leave unsaid
  }
  if (spec.policy !== undefined && !sources.length) sources.push('spec'); // an empty spec plan is stated too
  if (sources.length) out.policy_source = sources.join(' + '); // a spec null is recorded, so a restart does not read it as "not stated"
  if (value) out.policy_default = value;
  return {};
}

module.exports = { applyPolicy, SHIPPED_PLAN };
