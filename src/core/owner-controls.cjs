'use strict';
// owner-controls.cjs — the owner's run controls (run.stop, run.pause, run.resume), split out of owner.cjs. The owner keeps the
// `inFlightControls` set; this module adds each control's flushed reply to it so `Owner.stop()` can await them.
const { decodeWire } = require('./owner.cjs');

// 5c: `run.stop` ahead of the engine, after `ping` and `shutdown` — operator only (the shape
// `shutdown` refuses on), then E_NOT_FOUND if no control is registered, else the control is called
// and its flushed reply tracked in `inFlightControls` so `stop()` can await it.
// build step 6f, ADR 0023 amendment 3 decision 4: generalised from `_dispatchRunStop` to serve
// `run.pause` and `run.resume` too — same gate, same E_NOT_FOUND wording naming the method actually
// called, same `controls` map keyed by method name.
//
// 5c-2 design item 2: a refusal's own write is tracked in `inFlightControls` exactly as the
// dispatched path is (round-1 finding: an E_ROLE or E_NOT_FOUND refusal racing an owner shutdown was
// dropped rather than flushed, because `fail` started the write but never added it to the set).
function dispatchRunControl(owner, method, c, req) {
  const write = (payload) => new Promise((resolve) => { if (c.destroyed) resolve(); else c.write(payload, resolve); });
  const fail = (code, message, detail) => {
    owner.counters.errors++;
    const p = write(JSON.stringify({ id: req.id, error: { code, message, detail } }) + '\n');
    owner.inFlightControls.add(p);
    p.then(() => owner.inFlightControls.delete(p));
    return p;
  };
  const role = req.params && req.params.caller && req.params.caller.role;
  if (role !== 'operator') {
    return fail('E_ROLE', `${method} is available to operator and this call came from role ${JSON.stringify(role === undefined ? null : role)}`,
      { method, role: role === undefined ? null : role, allowed: ['operator'] });
  }
  const control = owner.controls[method];
  if (typeof control !== 'function') {
    return fail('E_NOT_FOUND', `this owner (pid ${process.pid}) registers no ${method} control: it is not a belay run process`,
      { method, controls: Object.keys(owner.controls) });
  }
  const dispatched = Promise.resolve()
    .then(() => control(decodeWire(req.params)))
    .then((result) => write(JSON.stringify({ id: req.id, result }) + '\n'))
    .catch((e) => {
      owner.counters.errors++;
      return write(JSON.stringify({ id: req.id, error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail } }) + '\n');
    });
  owner.inFlightControls.add(dispatched);
  dispatched.then(() => owner.inFlightControls.delete(dispatched));
}

module.exports = { dispatchRunControl };
