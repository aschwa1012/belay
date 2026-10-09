'use strict';
// client.test.cjs — ADR 0033 decision 1: every E_OWNER_LOST from Client.call says whether the request
// was handed to the socket, and a sent write carries may_have_committed. No real process is killed; a
// socket is destroyed in-process.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Client } = core('client.cjs');

// A client wired to a socket of its own making: the peer accepts and never answers, so a call stays
// pending until the test destroys one end.
async function pendingClient() {
  const dir = sandbox();
  const c = new Client(dir, { elect: false, connectRetries: 1 });
  const server = net.createServer(sock => { server.peer = sock; sock.on('data', () => {}); sock.on('error', () => {}); });
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\belay-client-test-${process.pid}-${Date.now()}` : `${dir}/c.sock`;
  await new Promise(r => server.listen(pipe, r));
  c.pipe = pipe;
  await c.connect();
  const done = async () => { await c.close(); server.close(); cleanup(dir); };
  return { c, server, done };
}

test('call() with no connection rejects E_OWNER_LOST with sent: false', async () => {
  const dir = sandbox();
  try {
    const c = new Client(dir, { elect: false, connectRetries: 1 });
    await assert.rejects(c.call('run.attach', {}), e => {
      assert.strictEqual(e.code, 'E_OWNER_LOST');
      assert.strictEqual(e.detail.sent, false);
      assert.strictEqual(e.detail.may_have_committed, undefined);
      return true;
    });
  } finally { cleanup(dir); }
});

test('a pending write whose socket is destroyed rejects sent: true, may_have_committed: true; a read has no may_have_committed', async () => {
  const { c, server, done } = await pendingClient();
  try {
    const w = c.call('run.end', {}, { timeoutMs: 5000 });
    const r = c.call('run.get', {}, { timeoutMs: 5000 });
    await new Promise(res => setTimeout(res, 100));
    assert.ok(server.peer, 'the peer accepted the connection');
    server.peer.destroy();
    await assert.rejects(w, e => {
      assert.strictEqual(e.code, 'E_OWNER_LOST');
      assert.strictEqual(e.detail.sent, true);
      assert.strictEqual(e.detail.may_have_committed, true);
      assert.strictEqual(e.detail.method, 'run.end');
      assert.match(e.message, /may already have committed it, so re-read before retrying/);
      return true;
    });
    await assert.rejects(r, e => {
      assert.strictEqual(e.code, 'E_OWNER_LOST');
      assert.strictEqual(e.detail.sent, true);
      assert.strictEqual(e.detail.may_have_committed, undefined);
      assert.doesNotMatch(e.message, /re-read before retrying/);
      return true;
    });
  } finally { await done(); }
});

test('close() with a pending write rejects sent: true, may_have_committed: true', async () => {
  const { c, server, done } = await pendingClient();
  try {
    const w = c.call('task.create', { spec: 'x' }, { timeoutMs: 5000 });
    await new Promise(res => setTimeout(res, 100));
    await c.close();
    await assert.rejects(w, e => {
      assert.strictEqual(e.code, 'E_OWNER_LOST');
      assert.strictEqual(e.detail.sent, true);
      assert.strictEqual(e.detail.may_have_committed, true);
      return true;
    });
  } finally { await done(); }
});
