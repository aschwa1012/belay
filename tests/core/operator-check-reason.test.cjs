'use strict';
// operator-check-reason.test.cjs — when the owner's operator check refuses a connection, the client's E_UNBOUND says why. The ping
// carried only a boolean, so a refusal read the same whatever the cause. A real owner, a real second connection, the host tables injected.

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, OLD_ROOT_CREATED, ownSpawnRegistry } = require('./helpers.cjs');

const { Owner } = core('owner.cjs');
const { Client } = core('client.cjs');
const OC = core('operator-check.cjs');

const T0 = Date.now();
ownSpawnRegistry();
const caller = { role: 'operator', run_id: 'run-reason', pid: process.pid };

async function refused(snapshotChain, verify) {
  const dir = sandbox();
  const ports = new Set();
  const o = new Owner(dir, { embed: false, mode: 'bound', operatorCheckDeps: {
    table: async () => [...ports].map(p => `  TCP    127.0.0.1:${p}        127.0.0.1:${o.tcpPort}        ESTABLISHED     4242\r\n`).join(''),
    snapshot: async () => snapshotChain,
  }, ...(verify || {}) });
  await o.start();
  const c = new Client(dir, { caller, elect: false, connectRetries: 1 });
  try {
    await c.connect(); ports.add(c.sock.localPort);
    return await c.call('memory.get', { id: 'x', caller }).then(() => null, (e) => e);
  } finally { await c.close().catch(() => {}); await o.stop().catch(() => {}); cleanup(dir); }
}

test('a refused operator check puts the owner\'s reason in the client error, bounded and on one line', { skip: !OC.SUPPORTED && 'bound mode needs the Windows peer check', timeout: 60000 }, async () => {
  // the chain ends at a root created after the owner started: the check refuses with its own wording
  const e = await refused(new Map([[4242, { ppid: 4000, created: T0 + 60000, image: 'node.exe' }], [4000, { ppid: 1, created: T0 + 60000, image: 'pwsh.exe\n' + 'x'.repeat(1000) }]]));
  assert.ok(e, 'the call was refused');
  assert.strictEqual(e.code, 'E_UNBOUND', e.message);
  assert.match(e.message, /the owner said: the peer's chain ends at pid 4000/, e.message);
  assert.ok(typeof e.detail.operator_reason === 'string' && e.detail.operator_reason.length <= 300, String(e.detail.operator_reason && e.detail.operator_reason.length));
  assert.ok(!/[\r\n]/.test(e.detail.operator_reason));
});

test('a vouched connection carries no operator_reason', { skip: !OC.SUPPORTED && 'bound mode needs the Windows peer check', timeout: 60000 }, async () => {
  const e = await refused(new Map([[4242, { ppid: 4000, created: T0 - 5000, image: 'node.exe' }], [4000, { ppid: 1, created: OLD_ROOT_CREATED, image: 'pwsh.exe' }]]));
  assert.ok(!e || !(e.detail && e.detail.operator_reason), e && e.message);
});

test('the owner\'s own refusal of a write bounds the reason the same way', { skip: !OC.SUPPORTED && 'bound mode needs the Windows peer check', timeout: 60000 }, async () => {
  const dir = sandbox();
  const ports = new Set();
  const snap = new Map([[4242, { ppid: 4000, created: T0 + 60000, image: 'node.exe' }], [4000, { ppid: 1, created: T0 + 60000, image: 'pwsh.exe\n' + 'y'.repeat(1000) }]]);
  const o = new Owner(dir, { embed: false, mode: 'bound', operatorCheckDeps: {
    table: async () => [...ports].map(p => `  TCP    127.0.0.1:${p}        127.0.0.1:${o.tcpPort}        ESTABLISHED     4242\r\n`).join(''),
    snapshot: async () => snap,
  } });
  await o.start();
  const c = new Client(dir, { caller, elect: false, connectRetries: 1 });
  try {
    await c.connect(); ports.add(c.sock.localPort);
    const e = await c.call('memory.store', { text: 'x', namespace: 'project/p', embed: false, caller }).then(() => null, (err) => err);
    assert.ok(e && e.code === 'E_UNBOUND', e && e.message);
    const reason = /\((the peer's chain.*)\)$/s.exec(e.message);
    assert.ok(reason, e.message);
    assert.ok(reason[1].length <= 300 && !/[\r\n]/.test(reason[1]), String(reason[1].length));
  } finally { await c.close().catch(() => {}); await o.stop().catch(() => {}); cleanup(dir); }
});
