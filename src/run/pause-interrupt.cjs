'use strict';
// pause-interrupt.cjs — build step 6i-2 fix round (item 7/R9: pause.cjs was at 299 of its own 300-line
// budget, with no room left for the isOwnActiveRow discriminator fix). sendInterrupt moved here whole,
// unchanged, from pause.cjs.

const crypto = require('node:crypto');

const now = () => Date.now();

// The unconditional interrupt (ADR 0023 amendment 2 decision 1): a control_request on stdin, then a
// bounded wait for its own control_response only, never a turn end. Stdin is re-checked synchronously
// right here, since the process can still end on its own between the pre-slot liveness check and this write.
function sendInterrupt(w, interrupt_timeout_ms) {
  const requestId = 'belay-pause-' + crypto.randomUUID();
  const stdin = w.child && w.child.stdin;
  let sent = !!stdin && !stdin.destroyed && !stdin.writableEnded;
  if (sent) {
    try {
      stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n');
    } catch { sent = false; }
  }
  const t0 = now();
  return new Promise((resolve) => {
    const finish = (subtype) => {
      clearTimeout(timer);
      w.controlWaiters.delete(requestId);
      resolve({ sent, request_id: requestId, response_subtype: subtype, response_ms: subtype != null ? Date.now() - t0 : null });
    };
    const timer = setTimeout(() => finish(null), interrupt_timeout_ms);
    if (timer.unref) timer.unref();
    if (!sent) { finish(null); return; }
    w.controlWaiters.set(requestId, (ev) => finish(ev.subtype));
  });
}

module.exports = { sendInterrupt };
