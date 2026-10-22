'use strict';
// memory-search-copy.test.cjs — ADR 0040 §2, routing and invariant 6: a keyword search with no owner answers
// from a copy of the store and writes nothing to the live files; a store with no keyword index says
// E_NO_INDEX in modes_failed and never answers an empty "no match".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, listDataDir } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { Store } = core('store.cjs');

// Name, size and mtime of every file in the data dir: any sidecar a read created, or any write to the live
// file, shows up as a difference.
const fingerprint = dir => listDataDir(dir).map(n => { const s = fs.statSync(path.join(dir, n)); return `${n}:${s.size}:${s.mtimeMs}`; });

async function seeded() {
  const dir = sandbox();
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  const a = await orch.memory.store({ namespace: 'ns', text: 'Wedged pipe handling raises E_OWNER_LOST after a ping timeout', embedding: [1, 0, 0], embedding_model: 'm', dim: 3 });
  const b = await orch.memory.store({ namespace: 'ns', text: 'Cold model loads happen in the embedder process', embedding: [0, 1, 0], embedding_model: 'm', dim: 3 });
  await orch.shutdownOwner(); // the only way to stop an owner; never a signal
  await orch.close();
  return { dir, a, b };
}

test('keyword search with no owner answers from the copy and leaves the live files untouched', async (tcx) => {
  const { dir, a } = await seeded();
  try {
    const before = fingerprint(dir);
    assert.ok(before.length >= 1);
    const reader = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => reader.close()).catch(() => {}));
    const r = await reader.memory.search({ namespace: 'ns', query: 'E_OWNER_LOST', mode: 'keyword' });
    assert.deepStrictEqual(r.results.map(x => x.id), [a.id]);
    assert.deepStrictEqual(r.modes_run, ['keyword']);
    assert.strictEqual(r.searched.fts, true, 'the owner built the index, the copy carries it');
    const h = await reader.memory.search({ namespace: 'ns', query: 'E_OWNER_LOST', mode: 'hybrid' });
    assert.deepStrictEqual(h.results.map(x => x.id), [a.id]);
    assert.strictEqual(h.modes_failed[0].mode, 'semantic');
    assert.strictEqual(h.modes_failed[0].code, 'E_NO_EMBEDDER');
    assert.strictEqual(h.absence_established, false);
    const v = await reader.memory.search({ namespace: 'ns', query: 'E_OWNER_LOST', mode: 'hybrid', query_embedding: [1, 0, 0] });
    assert.deepStrictEqual(v.modes_run, ['semantic', 'keyword'], 'a supplied vector needs no embedder, so the copy runs both');
    assert.strictEqual(v.modes_failed.length, 0);
    for (const m of [() => reader.memory.timeline({ anchor_id: a.id }), () => reader.memory.get_many({ ids: [a.id] }), () => reader.memory.list({ namespace: 'ns' })]) await m();
    await reader.close();
    assert.deepStrictEqual(fingerprint(dir), before, 'reads from the copy created no file and changed none');
  } finally { cleanup(dir); }
});

test('a store with no keyword index gives E_NO_INDEX in modes_failed, never an empty no-match', async (tcx) => {
  const dir = sandbox();
  try {
    const s = new Store(path.join(dir, 'memory.db')); // not stamped: what an older core left behind
    tcx.after(() => Promise.resolve().then(() => s.close()).catch(() => {}));
    s.db.prepare("INSERT INTO memory_entries(id, namespace, worker_id, type, text, text_hash, created_at, updated_at) VALUES ('old', 'ns', 'w', 'fact', 'an old row mentioning pidAlive', 'h', 1, 1)").run();
    s.close();
    const before = fingerprint(dir);
    const reader = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => reader.close()).catch(() => {}));
    const r = await reader.memory.search({ namespace: 'ns', query: 'pidAlive', mode: 'keyword' });
    assert.deepStrictEqual(r.results, []);
    assert.deepStrictEqual(r.modes_run, []);
    assert.strictEqual(r.modes_failed.length, 1);
    assert.strictEqual(r.modes_failed[0].mode, 'keyword');
    assert.strictEqual(r.modes_failed[0].code, 'E_NO_INDEX');
    assert.strictEqual(r.absence_established, false);
    assert.strictEqual(r.searched.fts, false);
    assert.strictEqual(r.searched.rows_considered, 1, 'the row exists; only the index does not');
    assert.ok(r.warning.includes('E_NO_INDEX'));
    assert.strictEqual(Object.keys(r)[0], 'warning');
    await reader.close();
    assert.deepStrictEqual(fingerprint(dir), before, 'the live file and its sidecars are unchanged');
    const raw = new Store(path.join(dir, 'memory.db'));
    tcx.after(() => Promise.resolve().then(() => raw.close()).catch(() => {}));
    assert.strictEqual(raw.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'memory_fts'").get().n, 0, 'a read never made the index');
    raw.close();
  } finally { cleanup(dir); }
});

test('a data dir with no store at all: keyword search says E_NO_INDEX and creates no file', async (tcx) => {
  const dir = sandbox();
  try {
    const reader = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => reader.close()).catch(() => {}));
    const r = await reader.memory.search({ namespace: 'ns', query: 'anything', mode: 'keyword' });
    assert.deepStrictEqual(r.results, []);
    assert.strictEqual(r.modes_failed[0].code, 'E_NO_INDEX');
    assert.strictEqual(r.absence_established, false);
    assert.deepStrictEqual(listDataDir(dir), []);
    await reader.close();
  } finally { cleanup(dir); }
});
