'use strict';
// memory-corpus.test.cjs — ADR 0043 decision 1: memory.corpus selects verified rows, summaries and decisions
// from one namespace, renders them through fit, carries no clock, and reads without writing.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { corpus } = core('memory-corpus.cjs');

let dir, store, E, orch;
const rejects = async (p, code) => assert.rejects(p, e => { assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); return true; });
const put = (ns, text, extra = {}) => E.handle('memory.store', { namespace: ns, text, embedding: [1, 0, 0], embedding_model: 'm', dim: 3, caller: orch, ...extra });
const setCols = (id, cols) => {
  const keys = Object.keys(cols);
  store.db.prepare(`UPDATE memory_entries SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => cols[k]), id);
};
const rows = {};

before(async () => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => { throw new Error('the corpus must not embed'); }, owner: null, establishedBy: 'test' });
  orch = callerFor('orchestrator');
  const ns = 'project/demo';
  rows.verified = await put(ns, 'The owner lock is a pid file', { type: 'fact', created_at: 1000 });
  rows.unverified = await put(ns, 'A claim nobody checked', { type: 'fact', created_at: 2000 });
  rows.summary = await put(ns, 'Task T1 finished with two files changed', { type: 'summary', created_at: 3000 });
  rows.decision = await put(ns, 'We chose a pipe over a signal', { type: 'decision', created_at: 4000 });
  rows.refuted = await put(ns, 'The owner is a daemon', { type: 'decision', created_at: 5000 });
  rows.old = await put(ns, 'Old verified statement', { type: 'fact', created_at: 6000 });
  rows.newer = await put(ns, 'New verified statement', { type: 'fact', created_at: 7000, supersedes: rows.old.id });
  rows.expired = await put(ns, 'Expired verified statement', { type: 'fact', created_at: 8000 });
  rows.other = await put('project/other', 'Verified elsewhere', { type: 'fact', created_at: 9000 });
  rows.run = await put('run/test-run', 'Verified in the run namespace', { type: 'fact', created_at: 9500 });
  for (const k of ['verified', 'old', 'newer', 'expired', 'other', 'run']) setCols(rows[k].id, { status: 'verified' });
  setCols(rows.refuted.id, { status: 'refuted' });
  setCols(rows.verified.id, { title: 'Owner lock' });
  setCols(rows.expired.id, { ttl_at: 1 });
});
after(() => { store.close(); cleanup(dir); });

test('a project corpus holds the verified rows, summaries and decisions, and nothing else', async () => {
  const r = await corpus(E, orch, { project: 'demo' });
  assert.deepStrictEqual(r.row_ids.slice().sort(), [rows.verified.id, rows.summary.id, rows.decision.id, rows.newer.id].sort());
  assert.strictEqual(r.dropped, 0);
  assert.strictEqual(r.over_budget, false);
  assert.ok(r.text.startsWith('# belay memory corpus: project/demo'));
  assert.ok(r.text.includes(`[${rows.verified.id}] [fact/verified] Owner lock\n  The owner lock is a pid file`));
  assert.ok(r.text.includes(`[${rows.decision.id}] [decision/unverified]`), 'a decision is shown with its own status, never promoted');
  for (const k of ['unverified', 'refuted', 'old', 'expired', 'other', 'run']) assert.ok(!r.text.includes(`[${rows[k].id}]`), `${k} is not in the corpus`);
  assert.strictEqual(r.bytes, Buffer.byteLength(r.text));
});

test('without a project the corpus is the run namespace', async () => {
  const r = await corpus(E, orch, {});
  assert.deepStrictEqual(r.row_ids, [rows.run.id]);
  assert.ok(r.text.startsWith('# belay memory corpus: run/test-run'));
});

test('the same rows give the same bytes and sha256, and a change gives a different one', async () => {
  const a = await corpus(E, orch, { project: 'demo' });
  // A worker reaches its own run's project only: give the test run the project demo for this read.
  store.db.prepare("INSERT INTO run(id, epoch, written_at, written_by, project) VALUES ('test-run', 1, 0, 'test', 'demo')").run();
  const b = await corpus(E, callerFor('worker', { worker_id: 'w1' }), { project: 'demo' });
  await assert.rejects(corpus(E, callerFor('worker', { worker_id: 'w1' }), { project: 'other' }), (e) => e.code === 'E_ROLE');
  store.db.prepare("DELETE FROM run WHERE id = 'test-run'").run();
  assert.strictEqual(a.sha256, b.sha256);
  assert.strictEqual(a.text, b.text);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  const extra = await put('project/demo', 'One more decision', { type: 'decision', created_at: 10000 });
  const c = await corpus(E, orch, { project: 'demo' });
  assert.notStrictEqual(c.sha256, a.sha256);
  assert.ok(c.row_ids.includes(extra.id));
  store.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(extra.id);
});

test('a small budget drops whole rows, lowest priority first, and says how many', async () => {
  const full = await corpus(E, orch, { project: 'demo' });
  const lineBytes = Buffer.byteLength(full.text.split('\n').slice(1).join('\n'));
  const r = await corpus(E, orch, { project: 'demo', max_bytes: full.bytes - 1 });
  assert.ok(r.bytes <= full.bytes - 1);
  assert.ok(r.dropped >= 1);
  assert.ok(r.row_ids.includes(rows.decision.id), 'the decision outranks the verified fact');
  assert.ok(!r.row_ids.includes(rows.verified.id), 'the lowest priority, oldest row goes first');
  assert.strictEqual(r.over_budget, false);
  assert.ok(lineBytes > 0);
  const tiny = await corpus(E, orch, { project: 'demo', max_bytes: 5 });
  assert.strictEqual(tiny.over_budget, true);
  assert.deepStrictEqual(tiny.row_ids, []);
  assert.strictEqual(tiny.dropped, 4);
});

test('an empty namespace says so rather than returning nothing', async () => {
  const r = await corpus(E, orch, { project: 'nothing-here' });
  assert.deepStrictEqual(r.row_ids, []);
  assert.ok(r.text.includes('no verified rows, summaries or decisions'));
});


test('bad arguments are refused with E_ARGS', async () => {
  await rejects(corpus(E, orch, { project: 'Bad Name' }), 'E_ARGS');
  await rejects(corpus(E, orch, { project: 7 }), 'E_ARGS');
  await rejects(corpus(E, orch, { max_bytes: 0 }), 'E_ARGS');
  await rejects(corpus(E, orch, { max_bytes: 'big' }), 'E_ARGS');
});

test('reading the corpus writes nothing and stamps no accessed_at', async () => {
  const snap = () => store.db.prepare('SELECT id, accessed_at, updated_at FROM memory_entries ORDER BY id').all();
  const before = snap();
  const changes = store.db.prepare('SELECT total_changes() AS n').get().n;
  await corpus(E, orch, { project: 'demo' });
  assert.deepStrictEqual(snap(), before);
  assert.strictEqual(store.db.prepare('SELECT total_changes() AS n').get().n, changes);
});

test('the module requires only read-safe modules', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'memory-corpus.cjs'), 'utf8');
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]).filter(r => !r.startsWith('node:'));
  assert.deepStrictEqual(reqs.sort(), ['./errors.cjs', './fit-budget.cjs', './memory-reach.cjs', './memory-rows.cjs']);
});

test('a row superseded only by a row of another namespace stays in this namespace\'s corpus, as in memory.index', async () => {
  const kept = await put('project/scope', 'Scoped verified statement', { type: 'fact', created_at: 10000 });
  const other = await put('project/elsewhere', 'A row elsewhere that names it', { type: 'fact', created_at: 10001 });
  setCols(kept.id, { status: 'verified' });
  setCols(other.id, { supersedes: kept.id });
  const r = await corpus(E, orch, { project: 'scope' });
  assert.deepStrictEqual(r.row_ids, [kept.id]);
  const same = await put('project/scope', 'Its replacement in the same namespace', { type: 'fact', created_at: 10002 });
  setCols(same.id, { status: 'verified', supersedes: kept.id });
  assert.deepStrictEqual((await corpus(E, orch, { project: 'scope' })).row_ids, [same.id], 'a same-namespace successor still hides it');
});
