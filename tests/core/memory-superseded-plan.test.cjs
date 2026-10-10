'use strict';
// memory-superseded-plan.test.cjs — the superseded predicate of memory.search, memory.index and memory.corpus
// (NOT EXISTS a row of the same namespace that supersedes this one) must look the newer row up by
// ix_entries_supersedes. On ix_entries_ns_created it scans the namespace once per outer row, which made a
// 9,500-row namespace's count take minutes. The SQL is captured from the modules themselves, so the test checks
// the statements they run, then asks SQLite for each one's query plan.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const orch = callerFor('orchestrator');
const call = (method, args) => E.handle(method, { ...args, caller: orch });

before(async () => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  let prev = null;
  for (let i = 0; i < 40; i += 1) {
    const r = await call('memory.store', { namespace: 'project/plan', text: `plan row ${i} about supersession`, type: 'decision', embed: false, ...(prev && i % 2 ? { supersedes: prev } : {}) });
    prev = r.id;
  }
  // No ANALYZE: a real store has no statistics, and without them SQLite picks ix_entries_ns_created for the plain
  // s.namespace = e.namespace form, which is the plan this test exists to refuse.
});
after(() => { store.close(); cleanup(dir); });

// Every statement prepared while fn runs that holds the superseded subquery.
async function capture(fn) {
  const seen = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => { if (/NOT EXISTS \(SELECT 1 FROM memory_entries s WHERE s\.supersedes/.test(sql)) seen.push(sql); return prepare(sql); };
  try { await fn(); } finally { store.db.prepare = prepare; }
  return seen;
}

// The plan's detail lines for one statement; parameters are bound as nulls, which leaves the plan as it is.
function plan(sql) {
  const n = (sql.match(/\?/g) || []).length;
  return store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill(null)).map((r) => r.detail);
}

function assertSupersedesIndex(sqls, what) {
  assert.ok(sqls.length >= 1, `${what} ran the superseded subquery`);
  for (const sql of sqls) {
    const lines = plan(sql);
    const inner = lines.filter((d) => /SEARCH s /.test(d));
    assert.ok(inner.length >= 1, `${what}: the subquery is a search on s\n${lines.join('\n')}`);
    for (const d of inner) assert.match(d, /USING (COVERING )?INDEX ix_entries_supersedes/, `${what}: ${d}\n${lines.join('\n')}`);
  }
}

test('memory.search (keyword, so its count and its FTS query both run) looks superseding rows up by ix_entries_supersedes', async () => {
  const sqls = await capture(() => call('memory.search', { namespace: 'project/plan', query: 'supersession', mode: 'keyword' }));
  assertSupersedesIndex(sqls, 'memory.search');
});

test('memory.index looks superseding rows up by ix_entries_supersedes', async () => {
  assertSupersedesIndex(await capture(() => call('memory.index', { namespaces: ['project/plan'] })), 'memory.index');
});

test('memory.corpus looks superseding rows up by ix_entries_supersedes', async () => {
  assertSupersedesIndex(await capture(() => call('memory.corpus', { project: 'plan' })), 'memory.corpus');
});
