'use strict';
// operator-check-memory-reads.test.cjs — ADR 0045 amendment 3. A bound owner serves an open read to an unverified caller as the
// anonymous worker. A memory read answers a worker by hiding the rows outside its reach (memory.get says found:false, memory.timeline
// says not found), so an operator served that way would be told that existing rows are missing. The client therefore asks for the
// operator check before any memory read. A real owner, a real second connection, the host tables injected.

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Owner } = core('owner.cjs');
const { Client } = core('client.cjs');
const OC = core('operator-check.cjs');

const RUN = 'run-mem-reads';
const OTHER_NS = 'run/some-other-run';
const T0 = Date.now();
const caller = { role: 'operator', run_id: RUN, pid: process.pid };

test('a new operator connection reads another run\'s row by get, get_many and timeline; the row is not reported missing', { skip: !OC.SUPPORTED && 'bound mode needs the Windows peer check', timeout: 60000 }, async () => {
  const dir = sandbox();
  const ports = new Set();
  const o = new Owner(dir, { embed: false, mode: 'bound', operatorCheckDeps: {
    table: async () => [...ports].map(p => `  TCP    127.0.0.1:${p}        127.0.0.1:${o.tcpPort}        ESTABLISHED     4242\r\n`).join(''),
    snapshot: async () => new Map([[4242, { ppid: 4000, created: T0 - 5000, image: 'node.exe' }], [4000, { ppid: 1, created: T0 - 9000, image: 'pwsh.exe' }]]),
  } });
  await o.start();
  const clients = [];
  const open = async () => {
    const c = new Client(dir, { caller, elect: false, connectRetries: 1 });
    await c.connect(); clients.push(c); ports.add(c.sock.localPort); return c;
  };
  try {
    const writer = await open();
    const w = await writer.call('memory.store', { text: 'a row in another run namespace', namespace: OTHER_NS, embed: false, caller });
    assert.strictEqual(w.written_by, 'operator');
    const id = w.id;
    assert.ok(id, JSON.stringify(w));

    const reader = await open(); // a new connection: unverified until it asks
    assert.ok(reader._viaPort && !reader._opChecked);
    const got = await reader.call('memory.get', { id, caller });
    assert.strictEqual(got.found, true, `memory.get reported an existing row missing: ${JSON.stringify(got)}`);
    const many = await reader.call('memory.get_many', { ids: [id], caller });
    assert.ok(JSON.stringify(many).includes(id) && !/"found":\s*false/.test(JSON.stringify(many)), JSON.stringify(many));
    const tl = await reader.call('memory.timeline', { anchor_id: id, caller });
    assert.ok(JSON.stringify(tl).includes(id), JSON.stringify(tl));
  } finally { for (const c of clients) await c.close().catch(() => {}); await o.stop().catch(() => {}); cleanup(dir); }
});
