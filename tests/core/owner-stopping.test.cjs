'use strict';
// A stopping owner: a write that meets it waits for it to finish and goes to the next owner, its ping is not liveness, and a run
// control that arrives after stop() began is refused and never runs. Deterministic: stop() is held by a promise the test releases.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Owner } = require('../../src/core/owner.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { ping } = require('../../src/core/ping.cjs');
const { sandbox, cleanup, callerFor } = require('./helpers.cjs');

async function started(t, opts = {}) {
  const dir = sandbox();
  const owner = new Owner(dir, { embed: false, ...opts });
  const info = await owner.start();
  t.after(async () => { try { await owner.stop(); } catch { /* stopped */ } cleanup(dir); });
  return { dir, owner, info };
}

async function dial(info) {
  const sock = net.connect(info.pipe);
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  sock.setEncoding('utf8');
  return sock;
}

function oneLine(sock, request) {
  return new Promise((res) => {
    let got = '';
    sock.on('data', (d) => { got += d; const i = got.indexOf('\n'); if (i >= 0) res(got.slice(0, i)); });
    sock.write(JSON.stringify(request) + '\n');
  });
}

test('a write refused twice by a stopping owner waits for it to finish and is committed once by the next owner', async (t) => {
  const { dir, owner } = await started(t);
  const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'r-stopping-wait' }), embed: false });
  t.after(async () => { try { await c.shutdownOwner(); } catch { /* none */ } try { await c.close(); } catch { /* closed */ } });
  await c.task.create({ spec: 'warm-up: connected to the first owner' });
  let release;
  owner.inFlightControls.add(new Promise((res) => { release = res; }));
  const refuse = owner._refuse.bind(owner);
  let refused = 0;
  // The stop is held past the first refusal: a client that re-dials the same stopping owner meets a second refusal at once and fails.
  // The hold ends on that second refusal, or on a short timer after the first, which only lets the fixed client's wait finish.
  let timer = null;
  owner._refuse = (conn, req, why) => {
    refused++; refuse(conn, req, why);
    if (refused >= 2) release(); else timer = setTimeout(release, 300);
  };
  const stopping = owner.stop();
  const made = await c.task.create({ spec: 'raced a slow stop' });
  clearTimeout(timer);
  await stopping;
  assert.ok(made.id, 'the write was committed by the next owner');
  assert.equal(refused, 1, 'the stopping owner refused the call once; the client did not dial it again');
  const tasks = (await c.task.list({})).tasks || [];
  assert.equal(tasks.filter((x) => x.spec === 'raced a slow stop').length, 1, 'committed exactly once');
});

test('a stopping owner does not answer a ping as a serving one', async (t) => {
  const { dir, owner } = await started(t);
  let release;
  owner.inFlightControls.add(new Promise((res) => { release = res; }));
  const stopping = owner.stop();
  const p = await ping(dir, 1000);
  release();
  await stopping;
  assert.equal(p.ok, false);
  assert.equal(p.code, 'E_OWNER_STOPPING');
});

test('a run control that arrives after stop() began is refused E_OWNER_STOPPING and has no effect', async (t) => {
  let effect = 0;
  const { owner, info } = await started(t, { controls: { 'run.pause': async () => { effect++; return { ok: true }; } } });
  const sock = await dial(info);
  let releaseCalls;
  owner.inFlightCalls.add(new Promise((res) => { releaseCalls = res; })); // holds stop() in its in-flight-calls wait
  const stopping = owner.stop();
  const line = await oneLine(sock, { id: 1, method: 'run.pause', params: { caller: { role: 'operator', pid: process.pid } } });
  sock.destroy();
  releaseCalls();
  await stopping;
  const reply = JSON.parse(line);
  assert.equal(reply.error.code, 'E_OWNER_STOPPING');
  assert.equal(reply.error.detail.sent, false);
  assert.equal(effect, 0, 'the refused control did not run');
});
