'use strict';
// read-timeout-keeps-write.test.cjs — a read that misses its 300 ms bound over a Core's shared pipe client does not close
// that client while a write is outstanding on it (audit 0.3.1 C5). Closing it failed the write E_OWNER_LOST "may have
// committed" while the owner went on and committed it. The owner is slowed by fault injection on its method table (a
// stalled call released by the test), never by load or a fixed sleep.

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { openCore } = core('index.cjs');
const { METHODS } = core('engine.cjs');
const unresponsive = core('unresponsive.cjs');

async function setup() {
  const dir = sandbox();
  const owner = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await owner.run.attach({ adapter_pid: process.pid }); // this Core elects and owns in-process
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.task.create({ spec: 'warm the client' }); // orch now holds a pipe client to the owner
  return { dir, owner, orch };
}

async function teardown({ dir, owner, orch }) {
  await orch.close();
  try { await owner.shutdownOwner(); } finally { await owner.close(); unresponsive.reset(); cleanup(dir); }
}

// Stall the owner's answer to `name` (its first call in the owner only: the copy fallback's engine runs the same table).
function stall(name) {
  const orig = METHODS[name].fn;
  let release, stalled = false, result = null;
  const gate = new Promise((r) => { release = r; });
  METHODS[name].fn = async (E, c, a) => {
    if (!stalled && E.owner) { stalled = true; await gate; result = await orig(E, c, a); return result; }
    return orig(E, c, a);
  };
  return { release, restore: () => { METHODS[name].fn = orig; }, get result() { return result; } };
}

test('a read that misses its bound does not fail a write in flight on the same connection', { timeout: 60000 }, async () => {
  const ctx = await setup();
  unresponsive.reset();
  const w = stall('task.create'), r = stall('status.get');
  try {
    const write = ctx.orch.task.create({ spec: 'slow write' }).then((v) => ({ ok: true, id: v.id }), (e) => ({ ok: false, code: e.code, message: e.message }));
    const read = await ctx.orch.status.get({}); // misses the 300 ms bound and is answered from a copy
    assert.match(read.established_by, /copy/, 'the timed-out read fell back to a copy');
    assert.ok(ctx.orch.client && ctx.orch.client.connected, 'the shared client was kept: the write is still outstanding on it');
    r.release(); w.release();
    const outcome = await write;
    assert.ok(outcome.ok, 'the write is answered by the owner that committed it: ' + JSON.stringify(outcome));
    assert.strictEqual(outcome.id, w.result.id, 'the answer names the row the owner committed');
  } finally { w.restore(); r.restore(); await teardown(ctx); }
});

test('while the kept client is backed off, a read goes to the copy without asking the owner; an answer clears it', { timeout: 60000 }, async () => {
  const ctx = await setup();
  unresponsive.reset();
  const w = stall('task.create'), r = stall('status.get');
  try {
    const write = ctx.orch.task.create({ spec: 'slow write' }).then((v) => v, (e) => e);
    await ctx.orch.status.get({}); // times out, arms the backoff, keeps the client
    const sent = ctx.orch.client.nextId;
    const again = await ctx.orch.status.get({});
    assert.match(again.established_by, /owner unresponsive \(answer timed out at 300 ms/, 'the copy read names the backoff');
    assert.strictEqual(ctx.orch.client.nextId, sent, 'nothing was sent to the owner during the backoff');
    r.release(); w.release();
    assert.ok((await write).id, 'the write is answered');
    unresponsive.setClock(() => Date.now() + 11000); // past the backoff: the next read asks the owner again, and its answer clears the mark
    const after = await ctx.orch.status.get({});
    assert.doesNotMatch(String(after.established_by), /copy/);
    assert.strictEqual(ctx.orch._readBackoff, null);
  } finally { w.restore(); r.restore(); await teardown(ctx); }
});

test('a read timeout with nothing else outstanding still closes the client, as before', { timeout: 60000 }, async () => {
  const ctx = await setup();
  unresponsive.reset();
  const r = stall('status.get');
  try {
    const read = await ctx.orch.status.get({});
    assert.match(read.established_by, /copy/);
    assert.strictEqual(ctx.orch.client, null, 'an idle client is closed on a read timeout');
  } finally { r.release(); r.restore(); await teardown(ctx); }
});
