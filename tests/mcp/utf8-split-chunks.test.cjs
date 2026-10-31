'use strict';
require('../helpers/tmp.cjs');
// utf8-split-chunks.test.cjs — a multi-byte character split across two 'data' chunks must reach every line reader intact. Each case
// forces the split by construction (a replaced stream or a fake socket delivering two chunks); nothing depends on timing.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const split = (text) => {
  const b = Buffer.from(text, 'utf8');
  const at = b.indexOf(0xc3) + 1; // between the two bytes of a two-byte character
  return [b.subarray(0, at), b.subarray(at)];
};

test('the adapter stdin reader keeps a character split across chunks', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'utf8-split-stdin-child.cjs')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const replies = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.ok(replies.some((s) => s.includes('x\u00e9y')), `reply lost the character: ${JSON.stringify(replies)}`);
  assert.ok(!replies.some((s) => s.includes('\ufffd')), 'reply holds a replacement character');
});

test('the core client reply reader keeps a character split across chunks', async () => {
  const realConnect = net.connect;
  net.connect = () => {
    const sock = new EventEmitter();
    sock.destroyed = false; sock.unref = () => {}; sock.destroy = () => { sock.destroyed = true; };
    sock.write = (s, cb) => {
      const req = JSON.parse(String(s));
      const [a, b] = split(JSON.stringify({ id: req.id, result: { s: '\u00e9' } }) + '\n');
      setImmediate(() => { sock.emit('data', a); sock.emit('data', b); });
      if (typeof cb === 'function') cb();
      return true;
    };
    setImmediate(() => sock.emit('connect'));
    return sock;
  };
  try {
    const { Client } = require('../../src/core/client.cjs');
    const c = new Client(path.join(__dirname, 'nonexistent-utf8-split'), { pipe: '//./pipe/utf8-split-fake', elect: false });
    await c.connect();
    const r = await c.call('ping', {});
    assert.strictEqual(r.s, '\u00e9');
  } finally { net.connect = realConnect; }
});

test('the worker control pipe request reader keeps a character split across chunks', async () => {
  const realCreate = net.createServer;
  let onConn;
  net.createServer = (fn) => { onConn = fn; const s = new EventEmitter(); s.listen = (p, cb) => setImmediate(cb); s.close = (cb) => cb && cb(); return s; };
  try {
    const { createWorkerControl } = require('../../src/run/control.cjs');
    let resolveSeen; const seen = new Promise((r) => { resolveSeen = r; });
    const manager = { message: async (p) => { resolveSeen(p); return { ok: true }; } };
    const ctl = createWorkerControl({ dataDir: path.join(__dirname, 'nonexistent-utf8-split'), manager, pid: 4242, redeem: null });
    await ctl.listen();
    const c = new EventEmitter(); c.destroyed = false;
    c.write = (s, cb) => { if (cb) cb(); return true; }; c.destroy = () => { c.destroyed = true; };
    onConn(c);
    const [a, b] = split(JSON.stringify({ id: 1, method: 'worker.message', params: { caller: { role: 'operator' }, worker_id: 'w1', text: 'caf\u00e9' } }) + '\n');
    c.emit('data', a); c.emit('data', b);
    const got = await seen;
    assert.strictEqual(got.text, 'caf\u00e9');
  } finally { net.createServer = realCreate; }
});
