'use strict';
// A reply the owner owes for a call it has served must reach the client even when the owner is stopped at once,
// before the client has read it. `stop()` destroys every connection; a destroy that comes before the reply is written
// (or that discards it unread) makes the client see E_OWNER_LOST (sent: true) for a write that committed.
// The stop is called at the exact point the call finishes, with no macrotask in between: deterministic, no load.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Owner } = require('../../src/core/owner.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('./helpers.cjs');

async function started(t) {
  const dir = sandbox();
  const owner = new Owner(dir, { embed: false });
  const info = await owner.start();
  t.after(async () => { try { await owner.stop(); } catch { /* stopped */ } cleanup(dir); });
  return { dir, owner, info };
}

test('a stop called the moment a served call finishes still delivers its reply to a client that had not read it', async (t) => {
  const { owner, info } = await started(t);
  let stopping = null;
  owner.engine.handle = async () => {
    // The call has committed; the owner has not yet written the reply. A stop now must not drop it.
    queueMicrotask(() => { stopping = owner.stop(); });
    return { committed: true };
  };
  const sock = net.connect(info.pipe);
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  sock.setEncoding('utf8');
  sock.pause();
  sock.write(JSON.stringify({ id: 1, method: 'memory.reviewRelease', params: { caller: { role: 'operator', pid: process.pid } } }) + '\n');
  while (!stopping) await new Promise((res) => setImmediate(res));
  await stopping;
  let got = '';
  const line = await new Promise((res) => {
    sock.on('data', (d) => { got += d; const i = got.indexOf('\n'); if (i >= 0) res(got.slice(0, i)); });
    sock.once('close', () => res(got.split('\n')[0]));
    sock.resume();
  });
  sock.destroy();
  assert.ok(line, 'the connection closed with no reply: the answer of a served call was dropped');
  assert.deepEqual(JSON.parse(line), { id: 1, result: { committed: true } });
});

test('a real memory.reviewRelease whose owner is stopped right after its commit resolves for the review', async (t) => {
  const { dir, owner } = await started(t);
  const rev = await openCore({ dataDir: dir, caller: callerFor('operator', { run_id: 'r-stop-flush' }), embed: false });
  t.after(async () => { try { await rev.close(); } catch { /* owner gone */ } });
  const claim = (await rev.memory.reviewClaim({ project: 'p', pid: process.pid, job: 'archreview-stop-flush' })).claim;
  const real = owner.engine.handle.bind(owner.engine);
  let stopping = null;
  owner.engine.handle = async (method, params) => {
    const result = await real(method, params);
    if (method === 'memory.reviewRelease') queueMicrotask(() => { stopping = owner.stop(); });
    return result;
  };
  const released = await rev.memory.reviewRelease({ project: 'p', claim_id: claim.id, ok: true, message: 'ran' });
  assert.ok(released.release, 'the release call answered although the owner stopped right after committing it');
  await stopping;
});
