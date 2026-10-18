'use strict';
// gated-core.cjs — a Core (or harness view) whose every call first checks a gate.
//
// `belay run` cuts a run-close step at the fast close's deadline but the step keeps running behind the cut. It is told to stop by
// setting `gate.aborted`; a step that has not yet sent its next call then gets E_TIMEOUT instead of reaching the store. Without
// this, a call begun after the owner's shutdown would elect a stray owner in the run process (invariant 2). A call already sent
// is not recalled: it was handed to the owner before the shutdown.

function gatedCore(core, gate, what = 'the run-close step') {
  if (!gate) return core;
  const refuse = () => Promise.reject(Object.assign(new Error(`${what} gave up`), { code: 'E_TIMEOUT' }));
  // The proxies' targets are empty objects: the harness view is frozen, and a get trap may not return another value for a frozen property.
  const group = (g) => new Proxy({}, { get: (_, k) => (typeof g[k] === 'function' ? (...a) => (gate.aborted ? refuse() : g[k](...a)) : g[k]) });
  return new Proxy({}, { get: (_, k) => (k !== 'caller' && core[k] && typeof core[k] === 'object' ? group(core[k]) : core[k]) });
}

module.exports = { gatedCore };
