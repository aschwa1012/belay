'use strict';
// model-fallback-note.cjs: the headless orchestrator's session was moved to another model. The run row is written at once (run.setModelFallback),
// so `belay status` shows it while the run is live. A failed write is logged and the loop carries on; run.end's usage carries the same fact again.

function noteOrchestratorFallback(core, ev, log) {
  let p;
  try { p = Promise.resolve(core.run.setModelFallback({ at: ev.at, from: ev.from, to: ev.to, trigger: ev.trigger, scope: ev.scope, category: ev.category })); } catch (e) { p = Promise.reject(e); }
  return p.catch((e) => { try { log(`model_fallback not written to the run row: ${(e && e.message) || e}`); } catch { /* the loop never depends on this */ } });
}

module.exports = { noteOrchestratorFallback };
