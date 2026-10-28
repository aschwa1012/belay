'use strict';
// A reply the owner has already written for a committed call must reach the client even when the owner is
// stopped before the client has read it. `stop()` destroys every connection; a destroy that discards the
// unread reply makes the client see E_OWNER_LOST (sent: true) for a write that committed. The client here
// stops reading (socket paused) while the owner commits and then stops, and reads afterwards: deterministic,
// no timing, no load.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Owner } = require('../../src/core/owner.cjs');
const { sandbox, cleanup } = require('./helpers.cjs');

test('a stopped owner still delivers the reply of a call it committed to a client that had not read it', async (t) => {
  const dir = sandbox();
  const owner = new Owner(dir, { embed: false });
  const info = await owner.start();
  t.after(async () => { try { await owner.stop(); } catch { /* stopped */ } cleanup(dir); });
  let handled = null;
  const committed = new Promise((res) => { handled = res; });
  owner.engine.handle = async (method) => { handled(method); return { committed: true }; };

  const sock = net.connect(info.pipe);
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  let got = '';
  sock.setEncoding('utf8');
  sock.pause();
  sock.write(JSON.stringify({ id: 1, method: 'memory.reviewRelease', params: { caller: { role: 'operator', pid: process.pid } } }) + '\n');
  await committed;
  // The owner writes the reply in the microtasks after the engine returns; give them the turn they need.
  await new Promise((res) => setImmediate(res));
  await owner.stop();
  const line = await new Promise((res) => {
    sock.on('data', (d) => { got += d; const i = got.indexOf('\n'); if (i >= 0) res(got.slice(0, i)); });
    sock.once('close', () => res(got.split('\n')[0]));
    sock.resume();
  });
  sock.destroy();
  assert.ok(line, 'the connection closed with no reply: the committed call\'s answer was dropped');
  assert.deepEqual(JSON.parse(line), { id: 1, result: { committed: true } });
});
