'use strict';
// A bind or ticket call is served like an engine call around a stop: one served before the stop gets its reply written first,
// and one that arrives once the owner is stopping is refused E_OWNER_LOST with sent:false, so Core._callRedial dials again.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Owner } = require('../../src/core/owner.cjs');
const { sandbox, cleanup } = require('./helpers.cjs');

async function started(t) {
  const dir = sandbox();
  const owner = new Owner(dir, { embed: false });
  const info = await owner.start();
  t.after(async () => { try { await owner.stop(); } catch { /* stopped */ } cleanup(dir); });
  return { owner, info };
}

async function connect(pipe) {
  const sock = net.connect(pipe);
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  sock.setEncoding('utf8');
  return sock;
}

function firstLine(sock) {
  let got = '';
  return new Promise((res) => {
    sock.on('data', (d) => { got += d; const i = got.indexOf('\n'); if (i >= 0) res(got.slice(0, i)); });
    sock.once('close', () => res(got.split('\n')[0]));
    sock.resume();
  });
}

const req = (id, method) => JSON.stringify({ id, method, params: { caller: { role: 'operator', pid: process.pid } } }) + '\n';

test('a bind call served before a stop still delivers its reply to a client that had not read it', async (t) => {
  const { owner, info } = await started(t);
  let stopping = null;
  owner.bindCall = async () => { queueMicrotask(() => { stopping = owner.stop(); }); return { bound: true }; };
  const sock = await connect(info.pipe);
  sock.pause();
  sock.write(req(1, 'bind.status'));
  while (!stopping) await new Promise((res) => setImmediate(res));
  await stopping;
  const line = await firstLine(sock);
  sock.destroy();
  assert.ok(line, 'the connection closed with no reply: the answer of a served bind call was dropped');
  assert.deepEqual(JSON.parse(line), { id: 1, result: { bound: true } });
});

test('a bind or ticket call that arrives once the owner is stopping is refused unsent', async (t) => {
  const { owner, info } = await started(t);
  let ran = 0;
  owner.bindCall = async () => { ran += 1; return {}; };
  owner.ticketCall = async () => { ran += 1; return {}; };
  const sock = await connect(info.pipe);
  owner.stopped = true; // stop() sets this first; the connection is still open when the request lands
  try {
    for (const [id, method] of [[2, 'bind.open'], [3, 'ticket.issue']]) {
      const pending = firstLine(sock);
      sock.write(req(id, method));
      const r = JSON.parse(await pending);
      assert.equal(r.id, id);
      assert.equal(r.error.code, 'E_OWNER_LOST', JSON.stringify(r));
      assert.equal(r.error.detail.sent, false);
      sock.removeAllListeners('data'); sock.removeAllListeners('close');
    }
    assert.equal(ran, 0, 'a refused call was run');
  } finally { owner.stopped = false; sock.destroy(); }
});
