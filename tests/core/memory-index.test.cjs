'use strict';
// memory-index.test.cjs — ADR 0042 decision 2 and 5: memory.index returns only lasting rows, ranks them in
// the three mechanical tiers, honours exclude_ids and the byte bound, and renders no clock. These run an
// Engine over a real stamped store, with supplied vectors so no model is loaded.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { FOOTER, HEADER } = core('memory-index.cjs');

let dir, store, E, orch;
const call = (method, args, caller = orch) => E.handle(method, { ...args, caller });
const put = (ns, text, extra = {}) => call('memory.store', { namespace: ns, text, embedding: [1, 0, 0], embedding_model: 'm', dim: 3, ...extra });
const setCols = (id, cols) => {
  const keys = Object.keys(cols);
  store.db.prepare(`UPDATE memory_entries SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), id);
};
const ids = (r) => r.row_ids;

before(() => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  orch = callerFor('orchestrator');
});
after(() => { store.close(); cleanup(dir); });

// Each test uses its own namespace so rows never leak between cases.
let n = 0;
const fresh = () => `ix${++n}`;
async function row(ns, text, cols = {}, extra = {}) {
  const r = await put(ns, text, { type: 'summary', created_at: 1000 + (n * 100), ...extra });
  if (Object.keys(cols).length) setCols(r.id, cols);
  return r.id;
}

test('only lasting rows count: summary, decision or verified; never refuted, superseded or expired', async () => {
  const ns = fresh();
  const sum = await row(ns, 'a summary');
  const dec = await row(ns, 'a decision', {}, { type: 'decision' });
  const ver = await row(ns, 'a verified fact', { status: 'verified' }, { type: 'fact' });
  await row(ns, 'an unverified fact', {}, { type: 'fact' });
  await row(ns, 'an observation', {}, { type: 'observation' });
  await row(ns, 'a refuted summary', { status: 'refuted' });
  await row(ns, 'a refuted verified-type decision', { status: 'refuted' }, { type: 'decision' });
  await row(ns, 'an expired summary', { ttl_at: 1 });
  const old = await row(ns, 'a superseded summary');
  const newer = await row(ns, 'its replacement', { supersedes: old });
  const r = await call('memory.index', { namespaces: [ns] });
  assert.deepStrictEqual([...r.row_ids].sort(), [sum, dec, ver, newer].sort());
  assert.strictEqual(r.considered, 4);
  assert.strictEqual(r.dropped, 0);
  assert.strictEqual(r.over_budget, false);
  assert.ok(r.text.startsWith(HEADER) && r.text.endsWith(FOOTER));
  assert.ok(r.text.includes(`- ${ver} [fact/verified] a verified fact`), r.text);
  assert.ok(r.text.includes(`- ${sum} [summary/unverified] a summary`), r.text);
  assert.strictEqual(r.bytes, Buffer.byteLength(r.text));
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
});

test('the tiers: rows under files_owned, then rows for the task, then the rest; verified first, then newest', async () => {
  const ns = fresh();
  const t = await call('task.create', { spec: 'tiered', files_owned: ['src/run'] });
  const tier3Old = await row(ns, 'tier three old', {}, { created_at: 100 });
  const tier3New = await row(ns, 'tier three new', {}, { created_at: 900 });
  const tier3Ver = await row(ns, 'tier three verified', { status: 'verified' }, { created_at: 50 });
  const tier2Tag = await row(ns, 'tier two by tag', { tags: JSON.stringify([t.id]) }, { created_at: 300 });
  const tier2Task = await row(ns, 'tier two by task', { task_id: t.id }, { created_at: 400 });
  const tier1 = await row(ns, 'tier one', { body: JSON.stringify({ files_modified: ['src/run/manager.cjs'] }) }, { created_at: 10 });
  const r = await call('memory.index', { namespaces: [ns], task_id: t.id });
  assert.deepStrictEqual(ids(r), [tier1, tier2Task, tier2Tag, tier3Ver, tier3New, tier3Old]);
  // Without a task there are no first two tiers: the rest is by status then recency.
  const plain = await call('memory.index', { namespaces: [ns] });
  assert.deepStrictEqual(ids(plain), [tier3Ver, tier3New, tier2Task, tier2Tag, tier3Old, tier1]);
});

test('R17 matches by path prefix on a directory, and by folder for an owned file; not by string prefix', async () => {
  const ns = fresh();
  const t = await call('task.create', { spec: 'paths', files_owned: ['lib/run/', 'tests\\core\\a.test.cjs'] });
  const under = await row(ns, 'under the owned directory', { body: JSON.stringify({ files_read: ['lib/run/deep/x.cjs'] }) });
  const sibling = await row(ns, 'beside the owned file', { body: JSON.stringify({ files_modified: ['tests/core/b.test.cjs'] }) });
  const lookalike = await row(ns, 'a lookalike directory', { body: JSON.stringify({ files_modified: ['lib/runner/x.cjs'] }) });
  const elsewhere = await row(ns, 'elsewhere', { body: JSON.stringify({ files_modified: ['notes/x.md'] }) });
  const r = await call('memory.index', { namespaces: [ns], task_id: t.id });
  assert.deepStrictEqual(new Set(ids(r).slice(0, 2)), new Set([under, sibling]));
  assert.deepStrictEqual(new Set(ids(r).slice(2)), new Set([lookalike, elsewhere]));
});

test('R17 matches a real summary body: looked_at and done.files_modified, as the summariser writes them', async () => {
  const { summarise } = require('../../src/run/summarise.cjs');
  const ns = fresh();
  const t = await call('task.create', { spec: 'summary paths', files_owned: ['src/mcp'] });
  const bodyOf = async (obs) => {
    const s = await summarise({ task: { spec: 'x', state: 'done' }, observations: obs, checkpoints: [], handoff: {} }, { kind: 'mechanical' });
    return JSON.stringify({ v: 1, ...s.fields, generator: s.generator });
  };
  const read = await bodyOf([{ body: { files_read: ['src/mcp/belay-mcp.cjs'], files_modified: [] } }]);
  const wrote = await bodyOf([{ body: { files_read: [], files_modified: ['src/mcp/tools.cjs'] } }]);
  const none = await bodyOf([{ body: { files_read: ['docs/x.md'], files_modified: ['notes/y.md'] } }]);
  assert.ok(!('files_modified' in JSON.parse(read)), 'the summariser writes no top-level files_modified');
  const other = await row(ns, 'a summary elsewhere', { body: none }, { created_at: 9000 });
  const r1 = await row(ns, 'a summary that read the folder', { body: read }, { created_at: 10 });
  const r2 = await row(ns, 'a summary that changed the folder', { body: wrote }, { created_at: 20 });
  const r = await call('memory.index', { namespaces: [ns], task_id: t.id });
  assert.deepStrictEqual(ids(r), [r2, r1, other]);
});

test('exclude_ids removes rows and counts them', async () => {
  const ns = fresh();
  const a = await row(ns, 'first');
  const b = await row(ns, 'second');
  const r = await call('memory.index', { namespaces: [ns], exclude_ids: [a] });
  assert.deepStrictEqual(ids(r), [b]);
  assert.strictEqual(r.excluded_already_injected, 1);
  assert.strictEqual(r.considered, 2);
  const none = await call('memory.index', { namespaces: [ns], exclude_ids: [a, b] });
  assert.deepStrictEqual(none, { text: '', bytes: 0, row_ids: [], dropped: 0, over_budget: false, sha256: none.sha256, considered: 2, excluded_already_injected: 2 });
});

test('the byte bound drops whole rows, worst rank first, and reports dropped', async () => {
  const ns = fresh();
  const t = await call('task.create', { spec: 'bounded', files_owned: ['src/a'] });
  const best = await row(ns, 'best '.repeat(8), { body: JSON.stringify({ files_modified: ['src/a/x.cjs'] }) }, { created_at: 1 });
  const mids = [];
  for (let i = 0; i < 30; i++) mids.push(await row(ns, `filler row number ${i} with some words`, {}, { created_at: 2000 + i }));
  const full = await call('memory.index', { namespaces: [ns], task_id: t.id, max_bytes: 4096 });
  assert.strictEqual(full.dropped, 0);
  const small = await call('memory.index', { namespaces: [ns], task_id: t.id, max_bytes: 700 });
  assert.ok(small.bytes <= 700, `${small.bytes} bytes`);
  assert.ok(small.dropped > 0 && small.dropped === 31 - small.row_ids.length);
  assert.strictEqual(small.row_ids[0], best, 'the best-ranked row survives');
  assert.deepStrictEqual(small.row_ids, full.row_ids.slice(0, small.row_ids.length), 'what is kept is a prefix of the full ranking');
  assert.ok(small.text.endsWith(FOOTER) && small.text.startsWith(HEADER));
  assert.strictEqual(small.over_budget, false);
});

test('a frame that cannot fit injects nothing and says over_budget', async () => {
  const ns = fresh();
  await row(ns, 'a row');
  const r = await call('memory.index', { namespaces: [ns], max_bytes: 100 });
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.bytes, 0);
  assert.deepStrictEqual(r.row_ids, []);
  assert.strictEqual(r.over_budget, true);
  assert.strictEqual(r.dropped, 1);
});

test('an empty namespace gives an empty block, not an error', async () => {
  const r = await call('memory.index', { namespaces: [fresh()] });
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.bytes, 0);
  assert.strictEqual(r.considered, 0);
});

test('namespaces default to the run project, then the run', async () => {
  const caller = callerFor('orchestrator', { run_id: 'run-ix' });
  await E.handle('run.attach', { caller, adapter_pid: process.pid, project: 'demo' });
  const inProject = await put('project/demo', 'project knowledge', { caller, type: 'decision' });
  const inRun = await put('run/run-ix', 'run knowledge', { caller, type: 'summary' });
  const other = await put('project/other', 'someone else', { caller, type: 'summary' });
  const r = await E.handle('memory.index', { caller });
  assert.deepStrictEqual(new Set(r.row_ids), new Set([inProject.id, inRun.id]));
  assert.ok(!r.row_ids.includes(other.id));
  const caller2 = callerFor('orchestrator', { run_id: 'run-noproject' });
  const none = await E.handle('memory.index', { caller: caller2 });
  assert.deepStrictEqual(none.row_ids, [], 'a run without a project reads only its own namespace');
});

test('R7: identical inputs give identical bytes under two clocks, and the text holds no time', async () => {
  const ns = fresh();
  await row(ns, 'Retry policy was decided on 12 retries', {}, { type: 'decision' });
  await row(ns, 'second', { status: 'verified' });
  const realNow = Date.now;
  let a, b;
  try {
    Date.now = () => 1_700_000_000_000;
    a = await call('memory.index', { namespaces: [ns] });
    Date.now = () => 1_900_000_000_000;
    b = await call('memory.index', { namespaces: [ns] });
  } finally { Date.now = realNow; }
  assert.strictEqual(a.text, b.text);
  assert.strictEqual(a.sha256, b.sha256);
  assert.doesNotMatch(a.text, /\d{4}-\d{2}-\d{2}/, 'no ISO date');
  assert.doesNotMatch(a.text, /\b\d{10,}\b/, 'no epoch seconds or milliseconds');
  assert.doesNotMatch(a.text, /\bago\b|\bminutes?\b|\bhours?\b|\byesterday\b/i, 'no relative time');
});

test('the footer stays within its 300 byte bound', () => {
  assert.ok(Buffer.byteLength(FOOTER) <= 300, `${Buffer.byteLength(FOOTER)} bytes`);
});

test('arguments are checked: max_bytes has a ceiling, ids are strings', async () => {
  const bad = (args) => assert.rejects(call('memory.index', args), (e) => e.code === 'E_ARGS');
  await bad({ max_bytes: 4097 });
  await bad({ max_bytes: 0 });
  await bad({ max_bytes: 1.5 });
  await bad({ exclude_ids: 'x' });
  await bad({ exclude_ids: [1] });
  await bad({ namespaces: [] });
  await bad({ task_id: 7 });
});

test('a worker may call it, and reading it writes nothing', async () => {
  const ns = fresh();
  await row(ns, 'readable by all');
  const snap = () => JSON.stringify([
    store.db.prepare('SELECT id, accessed_at, updated_at, created_at FROM memory_entries ORDER BY id').all(),
    store.db.prepare('SELECT COUNT(*) AS n FROM memory_event').get(),
  ]);
  const before = snap();
  const r = await call('memory.index', { namespaces: [ns] }, callerFor('worker', { worker_id: 'w1' }));
  assert.strictEqual(r.row_ids.length, 1);
  assert.strictEqual(snap(), before);
});

test('the module requires nothing that reaches the embedder', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'memory-index.cjs'), 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]).filter((r) => !r.startsWith('node:'));
  assert.deepStrictEqual(reqs.sort(), ['./errors.cjs', './fit-budget.cjs', './memory-rows.cjs', './rows.cjs']);
});
