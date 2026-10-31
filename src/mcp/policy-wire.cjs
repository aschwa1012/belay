'use strict';
// policy-wire.cjs — starts the policy executor (src/run/policy-exec.cjs) in the orchestrator adapter, beside the run manager it acts
// through (ADR 0072 decision 1). It adds no process and no timer the manager does not already stop: a tick interval that is unref'd
// and cleared at the manager's shutdown, which closes the executor first. A run with no plan costs one task.list at start and nothing
// after (the executor is not armed): it is armed by the run's default plan, by a task_create that states a plan, or by a plan found
// at start.

const { createCompose } = require('./compose.cjs');
const { createPolicyExecutor } = require('../run/policy-exec.cjs');

const TICK_MS = Number(process.env.BELAY_POLICY_TICK_MS) > 0 ? Number(process.env.BELAY_POLICY_TICK_MS) : 2000;
let current = null; let armEarly = false;

// task_create states a plan before the manager exists: remember it, and arm the executor when it starts.
function arm() { if (current) current.arm(); else armEarly = true; }

const viaPath = (core, dotted, args) => {
  const fn = dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), core);
  if (typeof fn !== 'function') throw Object.assign(new Error(`the core exposes no method ${dotted}`), { code: 'E_INTERNAL' });
  return fn(args);
};

// `core`: the adapter's core (it has harness()); `manager`: the run manager just created; `run`: the attached run row or null.
function start({ core, manager, opts, run = null, log = () => {} }) {
  const h = typeof core.harness === 'function' ? core.harness() : null;
  if (!h || typeof h.policyAs !== 'function') return null; // a fixture core has no policy channel
  const assignFor = (stepCore) => createCompose({ callCore: (d, a) => viaPath(stepCore, d, a), manager: () => manager, openManager: async () => manager, dataDir: opts.dataDir, runId: opts.runId }).assign;
  const exec = createPolicyExecutor({ core: h, runId: opts.runId, assignFor, closing: () => manager._closing(), log });
  current = exec;
  const waitEnd = new AbortController(); // aborted at the manager's shutdown: a wait in flight takes no step and returns cancelled
  // ADR 0074: a worker_wait that names no worker waits for the run once a plan is in force (the run manager asks `active()` at each call).
  if (typeof manager.setPolicyWait === 'function') manager.setPolicyWait(require('../run/run-wait.cjs').createRunWait({ core: h, runId: opts.runId, dataDir: opts.dataDir, armed: () => exec.isArmed(), signal: waitEnd.signal }));
  if (armEarly || (run && run.policy_default)) exec.arm();
  // One task.list at start (an indexed read of the run's task rows, once per adapter life) arms the executor when any task already carries a plan, so a restart mid-run loses nothing. A run with no plan pays only this read.
  else h.task.list({}).then((r) => { if (((r && r.tasks) || []).some((t) => t.run_id === opts.runId && t.policy)) exec.arm(); }, () => {});
  const timer = setInterval(() => { exec.tick().catch((e) => log(`policy tick: ${e && e.code}: ${e && e.message}`)); }, TICK_MS);
  if (timer.unref) timer.unref();
  const shutdown = manager.shutdown;
  manager.shutdown = async (...a) => { waitEnd.abort(); clearInterval(timer); await exec.close(); current = null; return shutdown.apply(manager, a); };
  return exec;
}

module.exports = { start, arm, TICK_MS };
