'use strict';
// operator-check-concurrent.test.cjs — the client's operator check is one shared in-flight promise per connection, and a failed check is
// an error for a memory read, never an anonymous answer. A real owner, a real second connection, the host tables injected (a delayed
// connection table; an unreadable one that then recovers).

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Owner } = core('owner.cjs');
const { Client } = core('client.cjs');
const OC = core('operator-check.cjs');

const RUN = 'run-concurrent';
const OTHER_NS = 'run/some-other-run';
const T0 = Date.now();
const caller = { role: 'operator', run_id: RUN, pid: process.pid };

async function fixture(tableHook) {
  const dir = sandbox();
  const ports = new Set();
  const state = { delayMs: 0, broken: false, tables: 0 };
  const o = new Owner(dir, { embed: false, mode: 'bound', operatorCheckDeps: {
    table: async () => {
      state.tables++;
      if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
      if (state.broken) throw new Error('connection table unreadable');
      return [...ports].map(p => `  TCP    127.0.0.1:${p}        127.0.0.1:${o.tcpPort}        ESTABLISHED     4242\r\n`).join('');
    },
    snapshot: async () => new Map([[4242, { ppid: 4000, created: T0 - 5000, image: 'node.exe' }], [4000, { ppid: 1, created: T0 - 9000, image: 'pwsh.exe' }]]),
  } });
  await o.start();
  const clients = [];
  const open = async () => {
    const c = new Client(dir, { caller, elect: false, connectRetries: 1 });
    await c.connect(); clients.push(c); ports.add(c.sock.localPort); return c;
  };
  const done = async () => { for (const c of clients) await c.close().catch(() => {}); await o.stop().catch(() => {}); cleanup(dir); };
  return { open, state, done };
}

const skip = !OC.SUPPORTED && 'bound mode needs the Windows peer check';

test('two concurrent memory reads on a new connection both wait for the one check and both see the row', { skip, timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const writer = await f.open();
    const w = await writer.call('memory.store', { text: 'a row in another run namespace', namespace: OTHER_NS, embed: false, caller });
    const reader = await f.open();
    f.state.delayMs = 700; // the check is slow; the second read arrives while it is in flight
    const before = f.state.tables;
    const [a, b] = await Promise.all([reader.call('memory.get', { id: w.id, caller }), reader.call('memory.get', { id: w.id, caller })]);
    assert.strictEqual(a.found, true, JSON.stringify(a));
    assert.strictEqual(b.found, true, `the second concurrent read was served before the check finished: ${JSON.stringify(b)}`);
    assert.strictEqual(f.state.tables - before, 1, 'one check, shared by both calls');
  } finally { await f.done(); }
});

test('a failed check is an error for a memory read, not found:false, and a later call recovers', { skip, timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const writer = await f.open();
    const w = await writer.call('memory.store', { text: 'a row in another run namespace', namespace: OTHER_NS, embed: false, caller });
    const reader = await f.open();
    f.state.broken = true;
    await assert.rejects(() => reader.call('memory.get', { id: w.id, caller }), (e) => e.code === 'E_UNBOUND' && e.detail && e.detail.reason === 'operator_check');
    assert.ok(!reader._opChecked, 'a failed check is not remembered as done');
    // a second concurrent pair also fails rather than being served anonymous
    const settled = await Promise.allSettled([reader.call('memory.get', { id: w.id, caller }), reader.call('memory.get', { id: w.id, caller })]);
    assert.ok(settled.every(s => s.status === 'rejected'), JSON.stringify(settled.map(s => s.status)));
    f.state.broken = false;
    const got = await reader.call('memory.get', { id: w.id, caller });
    assert.strictEqual(got.found, true, JSON.stringify(got));
    assert.ok(reader._opChecked);
  } finally { await f.done(); }
});
