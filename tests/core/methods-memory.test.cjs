'use strict';
// methods-memory.test.cjs — the memory methods' row shapes and refusals (api.md §3, §6).
// These tests share the `mem` namespace in one store; split from methods.test.cjs under the 500-line rule.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, worker, wid = 'w1';

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: wid, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-1', last_event_at: Date.now() });
  worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: wid }), embed: false });
});

after(async () => {
  await worker.close();
  await orch.shutdownOwner(); // the only way to stop an owner; never a signal
  await orch.close();
  cleanup(dir);
});


const rejects = async (p, code) => {
  await assert.rejects(p, e => {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    assert.ok(e.message.length > 10, 'the message must name the reason, not be a status word');
    return true;
  });
};

test('memory.get is a read and leaves the store untouched', async () => {
  const row = await orch.memory.store({ namespace: 'reads', text: 'read me', embedding: [1, 0], embedding_model: 'r', dim: 2 });
  const db = orch.owner.store.db;
  const before = db.prepare('SELECT accessed_at FROM memory_entries WHERE id = ?').get(row.id).accessed_at;
  await orch.memory.get({ id: row.id });
  const after = db.prepare('SELECT accessed_at FROM memory_entries WHERE id = ?').get(row.id).accessed_at;
  assert.strictEqual(after, before, 'invariant 6: reading never writes');
});


// ---- memory ----------------------------------------------------------------
test('memory.store returns the row it wrote and dedups by text within a namespace', async () => {
  const a = await orch.memory.store({ namespace: 'mem', text: 'one', embedding: [1, 0, 0], embedding_model: 'm', dim: 3, tags: ['t'] });
  assert.strictEqual(a.action, 'inserted');
  assert.strictEqual(a.namespace, 'mem');
  assert.strictEqual(a.worker_id, 'orchestrator');
  assert.ok(a.text_hash && a.id && a.updated_at);
  const b = await orch.memory.store({ namespace: 'mem', text: 'one', embedding: [1, 0, 0], embedding_model: 'm', dim: 3 });
  assert.strictEqual(b.action, 'updated');
  assert.strictEqual(b.id, a.id);
  assert.strictEqual(b.worker_id, 'orchestrator');
  assert.strictEqual(b.last_writer_id, 'orchestrator');
  // A worker reaches its run's namespace and its project only, and never passes a vector of its own.
  await rejects(worker.memory.store({ namespace: 'mem', text: 'one', embed: false }), 'E_ROLE');
  await rejects(worker.memory.store({ text: 'one', embedding: [1, 0, 0], embedding_model: 'm', dim: 3 }), 'E_ARGS');
});

test('memory.get, list, search and delete return rows, and a namespace is bound to its first model', async () => {
  const got = await orch.memory.get({ id: (await orch.memory.list({ namespace: 'mem' })).rows[0].id });
  assert.strictEqual(got.found, true);
  assert.strictEqual(got.has_embedding, true);
  assert.strictEqual(got.embedding, undefined, 'a read never returns the vector');
  assert.deepStrictEqual(await orch.memory.get({ id: 'no-such-row' }), { id: 'no-such-row', found: false });

  const s = await orch.memory.search({ namespace: 'mem', query: 'ignored', query_embedding: [1, 0, 0], k: 5, mode: 'semantic' });
  assert.strictEqual(s.model, 'm');
  assert.strictEqual(s.dim, 3);
  assert.ok(s.results.length >= 1);
  assert.ok(s.results[0].score > 0.99);
  assert.strictEqual(s.results[0].near_duplicate, true);
  assert.ok(typeof s.scanned === 'number');
  // A call that supplies only a vector (no query string) defaults to semantic mode, not hybrid.
  const sv = await orch.memory.search({ namespace: 'mem', query_embedding: [1, 0, 0], k: 5 });
  assert.deepStrictEqual(sv.modes_run, ['semantic']);
  assert.ok(sv.results[0].score > 0.99);

  await rejects(orch.memory.store({ namespace: 'mem', text: 'two', embedding: [1, 0], embedding_model: 'other', dim: 2 }), 'E_MODEL');
  await rejects(orch.memory.store({ namespace: 'mem', text: 'three', embedding: [1, 0], embedding_model: 'm', dim: 3 }), 'E_DIM');
  await rejects(orch.memory.store({ namespace: 'mem', text: 'four', embedding: [0, 0, 0], embedding_model: 'm', dim: 3 }), 'E_VEC');
  await rejects(orch.memory.store({ namespace: 'mem', text: 'five', supersedes: 'ghost', embedding: [0, 1, 0], embedding_model: 'm', dim: 3 }), 'E_SUPERSEDES');
  await rejects(orch.memory.store({ namespace: 'mem', text: '   ', embedding: [0, 1, 0], embedding_model: 'm', dim: 3 }), 'E_ARGS');
  // With no embedder loaded and no vector supplied there is nothing to embed with, and a row nobody can
  // ever find is not a success: the write is refused rather than silently stored unsearchable.
  await rejects(orch.memory.store({ namespace: 'mem', text: 'no vector, no embedder' }), 'E_NO_EMBEDDER');

  const row = await orch.memory.store({ namespace: 'del', text: 'delete me', embedding: [0, 0, 1], embedding_model: 'd', dim: 3 });
  const d = await orch.memory.delete({ id: row.id });
  assert.deepStrictEqual(d, { id: row.id, deleted: true, namespace: 'del' });
  assert.deepStrictEqual(await orch.memory.delete({ id: row.id }), { id: row.id, deleted: false });
});

test('without an embedder a search that needs one is refused, never answered empty', async () => {
  await rejects(orch.memory.search({ namespace: 'mem', query: 'needs a model', mode: 'semantic' }), 'E_NO_EMBEDDER');
  await rejects(orch.memory.search({ namespace: 'mem' }), 'E_ARGS');
});

test('memory.stats reports row counts and owner liveness together', async () => {
  const s = await orch.memory.stats({});
  assert.ok(s.n > 0);
  assert.ok(Array.isArray(s.by_namespace));
  assert.strictEqual(s.owner.alive, true);
  assert.strictEqual(s.owner.pid, process.pid);
  assert.ok(s.owner.established_by.length > 0);
  assert.ok(s.heartbeat && s.heartbeat.pid === process.pid);
});
