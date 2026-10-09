'use strict';
// maintenance.test.cjs — the owner behaviours the prototype measured and the lift had to keep:
// the TTL sweep, the idle TRUNCATE checkpoint that stops the WAL growing without bound (C3 watched it
// reach 30 MB), and VACUUM INTO as the only backup path.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, sleep } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { Store } = core('store.cjs');

const vec = i => [Math.cos(i), Math.sin(i)];

test('a row with a ttl is swept by the owner and is then genuinely gone', async () => {
  const dir = sandbox();
  try {
    const c = await openCore({
      dataDir: dir, caller: callerFor('orchestrator'), embed: false,
      ownerOpts: { sweepMs: 50, heartbeatMs: 50 },
    });
    const keep = await c.memory.store({ namespace: 'ttl', text: 'permanent', embedding: vec(1), embedding_model: 'm', dim: 2 });
    const go = await c.memory.store({ namespace: 'ttl', text: 'ephemeral', ttl_seconds: 0.05, embedding: vec(2), embedding_model: 'm', dim: 2 });
    assert.ok(go.ttl_at > Date.now(), 'the row carries the moment it expires');
    assert.strictEqual((await c.memory.get({ id: go.id })).found, true);

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (await c.memory.get({ id: go.id })).found) await sleep(40);
    assert.strictEqual((await c.memory.get({ id: go.id })).found, false, 'the TTL sweep must remove an expired row');
    assert.strictEqual((await c.memory.get({ id: keep.id })).found, true, 'and must remove nothing else');
    // A swept row must also be gone from the search cache, not merely from the table.
    const s = await c.memory.search({ namespace: 'ttl', query_embedding: vec(2), k: 5 });
    assert.ok(!s.results.some(r => r.id === go.id), 'an expired row must not come back from the vector cache');

    await c.shutdownOwner();
    await c.close();
  } finally { cleanup(dir); }
});

test('the WAL is truncated once the owner goes idle', async () => {
  const dir = sandbox();
  try {
    const c = await openCore({
      dataDir: dir, caller: callerFor('orchestrator'), embed: false,
      ownerOpts: { idleMs: 150, idleCheckMs: 50, checkpointMs: 100000, sweepMs: 100000 },
    });
    for (let i = 0; i < 300; i++) {
      await c.memory.store({ namespace: 'wal', text: `row ${i} ${'padding '.repeat(20)}`, embedding: vec(i), embedding_model: 'm', dim: 2 });
    }
    const wal = path.join(dir, 'memory.db-wal');
    assert.ok(fs.statSync(wal).size > 0, 'continuous writes leave frames in the WAL');

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && fs.statSync(wal).size > 0) await sleep(50);
    assert.strictEqual(fs.statSync(wal).size, 0, 'once idle, one TRUNCATE checkpoint reclaims the WAL');

    // The rows are still there: a checkpoint moves frames into the database, it does not drop them.
    const stats = await c.memory.stats({});
    assert.strictEqual(stats.n, 300);
    assert.strictEqual(stats.wal_bytes, 0);

    await c.shutdownOwner();
    await c.close();
  } finally { cleanup(dir); }
});

test('backup is VACUUM INTO, and the copy passes its own integrity check', async () => {
  const dir = sandbox();
  try {
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    for (let i = 0; i < 50; i++) await c.memory.store({ namespace: 'bk', text: `row ${i}`, embedding: vec(i), embedding_model: 'm', dim: 2 });
    await c.shutdownOwner();
    await c.close();

    const s = new Store(path.join(dir, 'memory.db'));
    try {
      const dest = path.join(dir, 'backup', 'copy.db');
      const r = s.backup(dest);
      assert.strictEqual(r.dest, dest);
      assert.ok(r.bytes > 0);
      assert.ok(!fs.existsSync(dest + '-wal'), 'VACUUM INTO leaves no sidecars beside the backup');
      const b = new Store(dest);
      try {
        assert.deepStrictEqual(b.integrity(), ['ok']);
        assert.strictEqual(b.count(), 50);
      } finally { b.close(); }
    } finally { s.close(); }
  } finally { cleanup(dir); }
});

test('the heartbeat row names the live owner and its pipe', async () => {
  const dir = sandbox();
  try {
    const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false, ownerOpts: { heartbeatMs: 50 } });
    await c.memory.store({ namespace: 'hb', text: 'x', embedding: vec(1), embedding_model: 'm', dim: 2 });
    const first = (await c.memory.stats({})).heartbeat;
    assert.strictEqual(first.pid, process.pid);
    assert.strictEqual(first.pipe, c.ownerInfo().pipe);
    await sleep(200);
    const later = (await c.memory.stats({})).heartbeat;
    assert.ok(later.beat_at > first.beat_at, 'the heartbeat keeps beating while the owner lives');
    assert.strictEqual(later.started_at, first.started_at);
    await c.shutdownOwner();
    await c.close();
  } finally { cleanup(dir); }
});
