'use strict';
// request-line-limit.test.cjs — a request line over the owner's 1 MB limit (audit 0.3.1 P7). The owner dropped it with no reply
// and closed the connection, which the client read as a lost owner with `may_have_committed`, failing every other call on that
// connection too. Now the client refuses such a call unsent, and the owner answers a peer that sends one before it closes.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { openCore } = core('index.cjs');
const { Client, MAX_LINE_BYTES } = core('client.cjs');
const { pipeName } = core('lock.cjs');

async function owned() {
  const dir = sandbox();
  const owner = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await owner.run.attach({ adapter_pid: process.pid });
  return { dir, owner, done: async () => { try { await owner.shutdownOwner(); } finally { await owner.close(); cleanup(dir); } } };
}

test('the client refuses a call longer than the owner reads, unsent, and its connection keeps working', async () => {
  const o = await owned();
  const c = new Client(o.dir, { caller: callerFor('orchestrator'), elect: false });
  try {
    await c.connect();
    await assert.rejects(c.call('task.create', { spec: 'x'.repeat(MAX_LINE_BYTES) }), (e) => {
      assert.strictEqual(e.code, 'E_TOO_LONG');
      assert.strictEqual(e.detail.sent, false);
      assert.ok(e.detail.bytes > MAX_LINE_BYTES);
      return true;
    });
    assert.ok(c.connected, 'nothing was sent, so the connection is untouched');
    const t = await c.call('task.create', { spec: 'short', caller: callerFor('orchestrator') });
    assert.ok(t.id);
  } finally { await c.close(); await o.done(); }
});

test('a peer that sends a line past the limit is told why before the owner closes the connection', async () => {
  const o = await owned();
  const s = net.connect(pipeName(o.dir));
  try {
    await new Promise((r, j) => { s.once('connect', r); s.once('error', j); });
    let got = '';
    s.on('data', (d) => { got += d.toString('utf8'); });
    const closed = new Promise((r) => s.once('close', r));
    s.write('{"id":1,"method":"ping","params":{"pad":"' + 'é'.repeat(MAX_LINE_BYTES / 2 + 1)); // over the limit in bytes, under it in characters
    await closed;
    const msg = JSON.parse(got.trim().split('\n').pop());
    assert.strictEqual(msg.id, null);
    assert.strictEqual(msg.error.code, 'E_TOO_LONG');
    assert.strictEqual(msg.error.detail.limit_bytes, MAX_LINE_BYTES);
  } finally { s.destroy(); await o.done(); }
});
