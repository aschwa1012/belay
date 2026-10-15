'use strict';
// shutdown-owner-gone.test.cjs — the order shutdown keeps around the store owner: the closed flag first, the
// owner-gone flag next, every paired write already sent allowed to land, and only then the owner's shutdown.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LC = require('../../src/run/lifecycle.cjs');
const MC = require('../../src/run/memory-capture.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { memoryCore } = require('./fake-memory.cjs');
const { cleanup } = require('../core/helpers.cjs');

const tick = () => new Promise((r) => setImmediate(r));

test('lifecycle: a store resolving after close keeps its event, and the owner waits for paired writes', async () => {
  const flags = { closed: false, ownerGone: false, paired: new Set() };
  const events = [];
  let releaseStore;
  let landed = false;
  const core = {
    memory: {
      store: () => new Promise((r) => { releaseStore = () => r({ id: 'mem-1' }); }),
      recordEvent: async (ev) => { events.push(ev); await tick(); await tick(); landed = true; },
    },
    isOwner: () => true,
    shutdownOwner: async () => {
      assert.strictEqual(flags.ownerGone, true, 'the owner-gone flag is set before the owner goes');
      assert.strictEqual(flags.paired.size, 0, 'no paired write is still in flight');
      assert.strictEqual(landed, true, 'the paired event landed first');
      core.shutDown = true;
    },
  };
  const ctx = { core, shutdownFlags: flags };
  const w = { id: 'w-1', taskId: 't-1', turns: 1, substrate: 'claude-code', worktree: null, queue: Promise.resolve() };
  const plan = { levers: { observations: true }, events: [], dropped: 0, snap: { turn: 1, workerId: 'w-1', taskId: 't-1', substrate: 'claude-code', finalText: 'done' } };
  w.memoryQueue = MC.storeObservation(w, { kind: 'turn_end' }, ctx, plan);
  const workers = new Map([[w.id, w]]);
  const res = await LC.shutdown(workers, {
    stop: async () => ({}), core, clearPoll() {},
    markClosed: () => { flags.closed = true; setImmediate(() => releaseStore()); },
    markOwnerGone: () => { flags.ownerGone = true; return flags.paired; },
  });
  assert.strictEqual(core.shutDown, true);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].ok, 1);
  assert.strictEqual(res.paired_gave_up, 0);
});

test('lifecycle: a paired write begun while the drain runs is awaited before the owner goes', async () => {
  const flags = { closed: false, ownerGone: false, paired: new Set() };
  let landed = false;
  let release;
  const core = {
    isOwner: () => true,
    shutdownOwner: async () => { assert.strictEqual(landed, true); assert.strictEqual(flags.paired.size, 0); },
  };
  const ctx = { core, shutdownFlags: flags };
  const res = await LC.shutdown(new Map(), {
    stop: async () => ({}), core, clearPoll() {},
    markClosed: () => { flags.closed = true; },
    markOwnerGone: () => {
      flags.ownerGone = true;
      MC.pairedWrite(ctx, () => new Promise((r) => { release = () => { landed = true; r(); }; }));
      setImmediate(() => release());
      return flags.paired;
    },
  });
  assert.strictEqual(res.paired_gave_up, 0);
});

test('manager: shutdown sets the owner-gone flag and waits for the tracked paired writes before the owner goes', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-owner-gone-'));
  let m;
  let landed = false;
  const core = memoryCore();
  core.isOwner = () => true;
  core.shutdownOwner = async () => {
    const f = m._flags();
    assert.strictEqual(f.closed, true);
    assert.strictEqual(f.ownerGone, true);
    assert.strictEqual(landed, true, 'the manager hands its paired set to shutdown');
  };
  try {
    m = createRunManager({ core, dataDir: d.split(path.sep).join('/'), runId: 'run-fake', paths: {} });
    m._flags().paired.add(new Promise((r) => setTimeout(() => { landed = true; r(); }, 30)));
    await m.shutdown();
  } finally { cleanup(d); }
  assert.strictEqual(landed, true);
});
