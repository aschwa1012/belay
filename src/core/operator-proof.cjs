'use strict';
// operator-proof.cjs — ADR 0045 decision 4: does a bound owner vouch for this process as the operator? An act that does not go through
// the owner (a signal the CLI sends to a worker's pid itself) asks first. -> { verified: true | false | null, via }.
//   null   there is no check to ask: this process is the owner, or no live owner serves bound callers;
//   false  the owner was asked and would not vouch, or could not be asked (fails closed);
//   true   the owner's operator check accepted this process.

const { Client } = require('./client.cjs');
const { readOwnerLock, pidAlive } = require('./lock.cjs');

async function operatorProof(core) {
  if (core.isOwner()) return { verified: null, via: 'this process is the owner' };
  const lock = readOwnerLock(core.dataDir);
  if (!lock || lock.mode !== 'bound' || !pidAlive(lock.pid)) return { verified: null, via: 'no owner serves bound callers' };
  const c = new Client(core.dataDir, { caller: core.caller, elect: false, connectRetries: 1, dialTimeoutMs: 1000 });
  try { await c.connect(); return { verified: await c._verifyOperator(), via: 'the owner operator check' }; }
  catch (e) { return { verified: false, via: `the owner could not be asked (${(e && e.code) || (e && e.message)})` }; }
  finally { await c.close(); }
}

module.exports = { operatorProof };
