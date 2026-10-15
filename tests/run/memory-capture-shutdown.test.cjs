'use strict';
// memory-capture-shutdown.test.cjs — the observation row and the event that names it are one write unit across
// shutdown: a store already sent keeps its event until the owner is gone; a store not yet sent is dropped whole.
// A fake core holds `memory.store` open on a promise the test resolves after it flips the shutdown flags.

const test = require('node:test');
const assert = require('node:assert');

const MC = require('../../src/run/memory-capture.cjs');

function held() {
  const stores = [];
  const events = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let sentResolve;
  const sent = new Promise((r) => { sentResolve = r; });
  const core = {
    memory: {
      async store(args) { stores.push(args); sentResolve(); await gate; return { id: 'mem-1' }; },
      async recordEvent(ev) { events.push(ev); return { id: 'ev-1' }; },
    },
  };
  return { core, stores, events, release, sent };
}
const worker = () => ({ id: 'w-1', taskId: 't-1', turns: 1, substrate: 'claude-code', worktree: null, lastError: null });
const plan = () => ({ levers: { observations: true }, events: [], dropped: 0, snap: { turn: 1, workerId: 'w-1', taskId: 't-1', substrate: 'claude-code', finalText: 'did the thing' } });

test('a store sent before close still records its event after the flag closes', async () => {
  const h = held();
  const ctx = { core: h.core, shutdownFlags: { closed: false, ownerGone: false } };
  const w = worker();
  const done = MC.storeObservation(w, { kind: 'turn_end' }, ctx, plan());
  await h.sent;
  ctx.shutdownFlags.closed = true;
  h.release();
  const row = await done;
  assert.strictEqual(row.id, 'mem-1');
  assert.strictEqual(h.events.length, 1);
  assert.strictEqual(h.events[0].kind, 'observation');
  assert.strictEqual(h.events[0].ok, 1);
  assert.deepStrictEqual(h.events[0].row_ids, ['mem-1']);
});

test('a store that fails after close still records its ok 0 event', async () => {
  const h = held();
  h.core.memory.store = async (args) => { h.stores.push(args); throw Object.assign(new Error('write refused'), { code: 'E_BUSY' }); };
  const ctx = { core: h.core, shutdownFlags: { closed: false, ownerGone: false } };
  const w = worker();
  const done = MC.storeObservation(w, { kind: 'turn_end' }, ctx, plan());
  ctx.shutdownFlags.closed = true;
  assert.strictEqual(await done, null);
  assert.strictEqual(h.events.length, 1);
  assert.strictEqual(h.events[0].ok, 0);
  assert.strictEqual(h.events[0].code, 'E_BUSY');
});

test('a job not yet started at close writes neither the row nor the event', async () => {
  const h = held();
  const ctx = { core: h.core, shutdownFlags: { closed: true, ownerGone: false } };
  const w = worker();
  const row = await MC.storeObservation(w, { kind: 'turn_end' }, ctx, plan());
  assert.strictEqual(row, null);
  assert.strictEqual(h.stores.length, 0);
  assert.strictEqual(h.events.length, 0);
  assert.strictEqual(w.lastError.where, 'after-shutdown');
});

test('once the owner is gone the paired event is not sent and the drop is named', async () => {
  const h = held();
  const ctx = { core: h.core, shutdownFlags: { closed: false, ownerGone: false } };
  const w = worker();
  const done = MC.storeObservation(w, { kind: 'turn_end' }, ctx, plan());
  await h.sent;
  ctx.shutdownFlags.closed = true;
  ctx.shutdownFlags.ownerGone = true;
  h.release();
  await done;
  assert.strictEqual(h.events.length, 0);
  assert.deepStrictEqual(w.lastError, { where: 'after-shutdown', state: 'turn-observation-event' });
});
