'use strict';
// retire.cjs — the owners in this process that have been released but are still serving other clients.
//
// A short command that won the election (belay memory review, for one) may finish while another client is still attached to
// its owner. Shutting the owner down then would pull the store from under that client, so the owner is RETIRED instead
// (owner.cjs `retire`): it keeps serving until the last attached client is gone and then stops itself. The process must stay alive
// until then, so a command that ends the process by hand (belay.cjs `finish`, mode R) waits on `idle()` first. This file holds only
// that list and loads nothing else: a read command that never elected pays for a Set.

const waiting = new Set();

// `p` settles when a retired owner has stopped.
function register(p) {
  waiting.add(p);
  const done = () => waiting.delete(p);
  p.then(done, done);
  return p;
}

// Resolves once every retired owner of this process has stopped; at once when there is none.
async function idle() {
  while (waiting.size) await Promise.allSettled([...waiting]);
}

module.exports = { register, idle, pending: () => waiting.size };
