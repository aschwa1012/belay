'use strict';
// operator-check-reads.test.cjs — ADR 0045 decision 4 and invariants 2 and 9. The operator check reads the host's connection table and
// a process snapshot (netstat and PowerShell, about a second). A read command against a live `bound` owner must not pay it: an open
// read (status, worker reads) is served anonymously at once, and the check runs only for a call that needs the operator. The tables
// here are injected and counted, so the assertion is "never asked", not "fast enough"; a real owner, a real client on the loopback port.

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, OLD_ROOT_CREATED, ownSpawnRegistry } = require('./helpers.cjs');

const { Owner } = core('owner.cjs');
const { Client } = core('client.cjs');
const OC = core('operator-check.cjs');

const RUN = 'run-reads';
const T0 = Date.now();
ownSpawnRegistry(); // this file's fixture invents a shell as the root of the fake chain; no other file's spawned process may cover it

// The injected host: one fake operator process (pid 4242) with an intact chain to a root older than the owner. The connection table is
// built from the connection itself, so the check can find the "peer" the way netstat would.
function host(o, counts) {
  let clientPort = null;
  return {
    setClientPort: (p) => { clientPort = p; },
    deps: {
      table: async () => { counts.table++; return `  TCP    127.0.0.1:${clientPort}        127.0.0.1:${o.tcpPort}        ESTABLISHED     4242\r\n`; },
      snapshot: async () => { counts.snapshot++; return new Map([[4242, { ppid: 4000, created: T0 - 5000, image: 'node.exe' }], [4000, { ppid: 1, created: OLD_ROOT_CREATED, image: 'pwsh.exe' }]]); },
    },
  };
}

async function withLiveOwner(fn) {
  const dir = sandbox();
  const counts = { table: 0, snapshot: 0 };
  const hostBox = {};
  const o = new Owner(dir, { embed: false, mode: 'bound', operatorCheckDeps: {
    table: (...a) => hostBox.deps.table(...a), snapshot: (...a) => hostBox.deps.snapshot(...a),
  } });
  await o.start();
  Object.assign(hostBox, host(o, counts));
  const client = new Client(dir, { caller: { role: 'operator', run_id: RUN, pid: process.pid }, elect: false, connectRetries: 1 });
  try {
    await client.connect();
    hostBox.setClientPort(client.sock.localPort);
    return await fn({ o, client, counts, dir });
  } finally { await client.close().catch(() => {}); await o.stop().catch(() => {}); cleanup(dir); }
}

const caller = { role: 'operator', run_id: RUN, pid: process.pid };

test('connecting and reading status from a live bound owner asks neither the connection table nor a process snapshot', { skip: !OC.SUPPORTED && 'bound mode needs the Windows peer check', timeout: 60000 }, async () => {
  await withLiveOwner(async ({ client, counts }) => {
    assert.ok(client._viaPort, 'the operator is on the loopback port, where the check would run');
    const t0 = Date.now();
    const status = await client.call('status.get', { caller });
    const ms = Date.now() - t0;
    assert.ok(status && typeof status === 'object');
    await client.call('worker.list', { caller });
    await client.call('worker.list', { caller });
    assert.deepStrictEqual(counts, { table: 0, snapshot: 0 }, `an ordinary read started the operator check (status.get took ${ms} ms)`);
    process.stderr.write(`# status.get over the bound owner: ${ms} ms, check calls ${JSON.stringify(counts)}\n`);
  });
});

test('control: a write needs the operator, so it asks the check once, and later calls on the connection ask nothing more', { skip: !OC.SUPPORTED && 'bound mode needs the Windows peer check', timeout: 60000 }, async () => {
  await withLiveOwner(async ({ client, counts }) => {
    const r = await client.call('memory.store', { text: 'written by the verified operator', embed: false, caller });
    assert.strictEqual(r.written_by, 'operator');
    assert.deepStrictEqual(counts, { table: 1, snapshot: 1 }, 'the check ran for the write');
    await client.call('memory.store', { text: 'and a second one', embed: false, caller });
    await client.call('status.get', { caller });
    assert.deepStrictEqual(counts, { table: 1, snapshot: 1 }, 'a verified connection is not examined again');
  });
});

test('a read the anonymous role may not make is repeated once after the check, and succeeds as the operator', { skip: !OC.SUPPORTED && 'bound mode needs the Windows peer check', timeout: 60000 }, async () => {
  await withLiveOwner(async ({ client, counts }) => {
    const r = await client.call('memory.search', { query: 'anything', namespace: 'run/some-other-run', caller });
    assert.ok(r && !r.error, JSON.stringify(r));
    assert.deepStrictEqual(counts, { table: 1, snapshot: 1 }, 'asked for once, by the call that needed it');
  });
});

// The same read against an owner with the REAL check (netstat and a PowerShell snapshot, about a second when they run). A read that
// started them would take longer than this bound by itself; the bound is far above what a read costs and far below what the check costs.
test('budget: status.get over a live bound owner with the real operator check answers inside 400 ms (the check alone costs about a second)', { skip: !OC.SUPPORTED && 'bound mode needs the Windows peer check', timeout: 60000 }, async () => {
  const dir = sandbox();
  const o = new Owner(dir, { embed: false, mode: 'bound' });
  await o.start();
  const client = new Client(dir, { caller, elect: false, connectRetries: 1 });
  try {
    await client.connect();
    assert.ok(client._viaPort);
    const samples = [];
    for (let i = 0; i < 3; i++) { const t0 = Date.now(); await client.call('status.get', { caller }); samples.push(Date.now() - t0); }
    const best = Math.min(...samples);
    process.stderr.write(`# status.get over the bound owner with the real check: ${JSON.stringify(samples)} ms\n`);
    assert.ok(best < 400, `status.get took ${JSON.stringify(samples)} ms: a read paid for the operator check`);
  } finally { await client.close().catch(() => {}); await o.stop().catch(() => {}); cleanup(dir); }
});
