'use strict';
// call-signal.cjs — ADR 0074: a cancelled worker_wait claims nothing. The MCP adapter runs a worker_wait call inside `run`, which gives
// it an AbortSignal that the substrate's `notifications/cancelled` for that request id aborts. The run wait reads the signal and
// registers what it claimed (`claim.release`), so that a cancel arriving after the claim but before the reply was sent can undo the claim:
//   - before the claim: the wait takes nothing; its polled exceptions stay pending for the next wait.
//   - after the claim: the reply is not sent (a cancelled request gets no response), so the claim is RELEASED, not kept. Keeping it would lose
//     the exceptions and steps for good, because the orchestrator never saw them; releasing re-offers them to the next wait, and nothing
//     else has delivered them in between (the claim files are the only record of delivery).
// The store travels by AsyncLocalStorage so the call needs no new argument through the layers between the adapter and the wait.

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();
const open = new Map(); // request id -> the call's store

const current = () => als.getStore() || null;

// -> { value, confirm } or { cancelled: true } (the reply is to be dropped). `confirm` is called once the reply is written: the claim then stands for good. Any tool but worker_wait runs as it always did.
async function run(id, name, fn) {
  if (name !== 'worker_wait' || id === undefined || id === null) return { value: await fn(), confirm: () => {} };
  const ac = new AbortController();
  const store = { signal: ac.signal, claim: null };
  open.set(String(id), { ac, store });
  try {
    const value = await als.run(store, fn);
    if (ac.signal.aborted) {
      if (store.claim && typeof store.claim.release === 'function') store.claim.release();
      return { cancelled: true };
    }
    return { value, confirm: () => { if (store.claim && typeof store.claim.confirm === 'function') store.claim.confirm(); } };
  } finally { open.delete(String(id)); }
}

// notifications/cancelled { requestId }: true when a worker_wait was in flight under that id.
function cancel(id) {
  const c = open.get(String(id));
  if (!c) return false;
  c.ac.abort();
  return true;
}

module.exports = { run, cancel, current };
