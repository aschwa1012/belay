'use strict';
// core-views.cjs — the two channel views of a Core (index.cjs). Each is the same connection and owner with a frozen caller that
// carries a channel, built only by code that holds the Core object: a tool call reaches `core[group][name]` and nothing else.
// - harness (ADR 0044 decision 6): the run manager's view. Every Core API method, on the harness channel, so the core records
//   its memory rows as `harness`.
// - keepalive (ADR 0054 amendment 1): the worker adapter's lease keep-alive. The engine does not count a call on this
//   channel as the worker's own (a review grant's baseline reads the worker's calls), so the view holds exactly the calls the
//   keep-alive makes, task.list, worker.get and lease.renew, and nothing else: no later write can slip through it unstamped.

const KEEPALIVE_METHODS = Object.freeze(['task.list', 'worker.get', 'lease.renew']);

// `invoke(method, args, caller)` is the Core's own dispatch; `methods` the dotted names the view carries.
// `sealed`: each group frozen too (the keep-alive view), so nothing can be added to a group after it is built.
function build(caller, methods, invoke, sealed = false) {
  const view = { caller };
  for (const m of methods) {
    const [group, name] = m.split('.');
    if (!view[group]) view[group] = {};
    view[group][name] = (args) => invoke(m, args, caller);
  }
  if (sealed) for (const g of Object.keys(view)) if (g !== 'caller') Object.freeze(view[g]);
  return view;
}

// The harness view also carries the Core's own public helpers (bound to it), its owner, and `handle`.
function harnessView(core, METHOD_NAMES, proto) {
  const caller = Object.freeze({ ...core.caller, channel: 'harness' });
  const invoke = (m, args, c) => core._invoke(m, args, c);
  const view = build(caller, METHOD_NAMES, invoke);
  Object.defineProperty(view, 'owner', { get() { return core.owner; }, enumerable: true });
  for (const k of Object.getOwnPropertyNames(proto)) {
    if (k !== 'constructor' && !k.startsWith('_') && k !== 'harness' && k !== 'keepalive' && k !== 'handle' && typeof core[k] === 'function') view[k] = core[k].bind(core);
  }
  view.handle = (method, args) => core._invoke(method, args, caller);
  return Object.freeze(view);
}

function keepaliveView(core) {
  const caller = Object.freeze({ ...core.caller, channel: 'keepalive' });
  return Object.freeze(build(caller, KEEPALIVE_METHODS, (m, args, c) => core._invoke(m, args, c), true));
}

module.exports = { harnessView, keepaliveView, KEEPALIVE_METHODS };
