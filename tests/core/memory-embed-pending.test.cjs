'use strict';
// memory-embed-pending.test.cjs — notes stored without a vector (a hand-back under on_embedder_failure keyword) are counted by a
// plain read, embedded only by memory.embedNote (the operator's `belay memory embed`), and compared then with the same code and
// levers as a normal hand-back. A fake embedder gives the notes vectors we choose.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine, METHODS } = core('engine.cjs');

let dir, store, E, failEmbed = false, embedCalls = 0, mode = 'keyword';
const RUN = 'r-emb';
const orch = callerFor('orchestrator', { run_id: RUN });
const worker = callerFor('worker', { run_id: RUN, worker_id: 'w1' });
const operator = callerFor('operator', { run_id: 'cli' });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const bodyOf = id => JSON.parse(rowOf(id).body);
let seq = 0;

// K<n> is the n-th axis; K<n>x the same axis tilted by 8 degrees (cosine 0.99), a near-duplicate of K<n>.
const DIM = 16;
const vecOf = text => {
  const m = /\bK(\d+)(x?)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  if (!m) v[DIM - 1] = 1; else if (m[2]) { v[Number(m[1])] = 0.99; v[0] = 0.141; } else v[Number(m[1])] = 1;
  return v;
};
const embedder = {
  embed: async (text) => {
    embedCalls += 1;
    if (failEmbed) throw Object.assign(new Error('the embedder is down'), { code: 'E_MODEL_ABSENT', detail: { embedder: true, cause: 'absent' } });
    return { embedding: vecOf(text), embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
  },
};
const note = (marker) => ({
  kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, basis: 'observed',
  evidence: [{ where: `src/${marker}.js`, saw: 'the unlisted file was never read' }], applies_to: [`src/${marker}.js`], subjects: [marker],
});
async function handBack(notes) {
  const t = await call('task.create', orch, { spec: `job ${++seq}` });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: 'w1' });
  return call('lease.release', worker, { lease_id: a.new_lease.id, notes });
}

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  const owner = { opts: { embedderMode: () => mode } };
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => embedder, owner, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  await call('worker.write', orch, { id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-w1', last_event_at: Date.now(), model: 'claude-test-1' });
});
after(() => { store.close(); cleanup(dir); });

test('a hand-back under keyword with the embedder down stores bare notes, and the count reads them without writing', async () => {
  // K1 is already a live embedded note; K1x and K2 arrive while the embedder is down.
  const first = await handBack([note('K1')]);
  assert.strictEqual(first.notes[0].state, 'stored');
  assert.ok(rowOf(first.notes[0].id).embedding, 'the first note has a vector');
  failEmbed = true;
  const out = await handBack([note('K1x'), note('K2')]);
  failEmbed = false;
  assert.deepStrictEqual(out.notes.map(n => n.embedded), [false, false]);
  for (const n of out.notes) assert.strictEqual(rowOf(n.id).embedding, null);

  const before = store.p('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM memory_entries').get();
  const u = await call('memory.unembedded', operator, {});
  assert.strictEqual(u.total, 2);
  assert.deepStrictEqual(u.by_project, { acme: 2 });
  assert.ok(u.newest_at > 0);
  const listed = await call('memory.unembedded', operator, { project: 'acme', list: true });
  assert.deepStrictEqual(listed.notes.map(n => n.id).sort(), out.notes.map(n => n.id).sort());
  assert.strictEqual((await call('memory.unembedded', operator, { project: 'other' })).total, 0);
  assert.deepStrictEqual(store.p('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM memory_entries').get(), before, 'the count wrote nothing');
  assert.strictEqual(METHODS['memory.unembedded'].kind, 'read');

  const st = await call('status.get', operator, { run_id: RUN });
  assert.deepStrictEqual([st.notes_unembedded.total, st.notes_unembedded.by_project], [2, { acme: 2 }]);
});

test('nothing but memory.embedNote embeds a bare note: warm-up, searches, the index query and a new hand-back leave it bare', async () => {
  const bare = () => store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'note' AND embedding IS NULL").get().n;
  assert.strictEqual(bare(), 2);
  await call('memory.warm', orch, { wait: true });
  for (const m of ['semantic', 'keyword', 'hybrid']) await call('memory.search', orch, { query: 'loader fixtures', namespace: 'project/acme', mode: m });
  await call('memory.embedQuery', Object.assign({}, orch, { channel: 'harness' }), { extra_texts: ['a query'] });
  await call('memory.index', orch, { namespaces: ['project/acme'], query: 'loader' });
  await handBack([note('K3')]); // a new note is embedded by its own hand-back; the bare ones are not touched
  assert.strictEqual(bare(), 2);
  // and no source file but the command module that the operator starts calls it
  const srcRoot = path.join(__dirname, '..', '..', 'src');
  const filesWith = (needle) => {
    const hits = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/[.](cjs|ts|tsx)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(needle)) hits.push(path.relative(srcRoot, p).split(path.sep).join('/')); } };
    walk(srcRoot);
    return hits.sort();
  };
  assert.deepStrictEqual(filesWith('embedNote'), ['cli/cmd-memory-embed.cjs', 'core/engine.cjs', 'core/index.cjs', 'core/methods-memory-embed.cjs']);
  // Store.setEmbedding is reached from embedNote's core path only
  assert.deepStrictEqual(filesWith('setEmbedding('), ['core/methods-memory-embed.cjs', 'core/store.cjs']);
});

test('memory.embedNote is the operator\'s alone', async () => {
  const id = store.p("SELECT id FROM memory_entries WHERE type = 'note' AND embedding IS NULL").get().id;
  for (const c of [worker, orch]) await assert.rejects(call('memory.embedNote', c, { id }), e => e.code === 'E_ROLE');
  assert.strictEqual(rowOf(id).embedding, null);
});

test('with the embedder down it refuses, and the row is exactly as it was', async () => {
  const rows = store.p('SELECT id, namespace, updated_at, body FROM memory_entries ORDER BY id').all();
  failEmbed = true;
  try {
    const id = store.p("SELECT id FROM memory_entries WHERE type = 'note' AND embedding IS NULL").get().id;
    await assert.rejects(call('memory.embedNote', operator, { id }), e => e.code === 'E_MODEL_ABSENT');
  } finally { failEmbed = false; }
  assert.deepStrictEqual(store.p('SELECT id, namespace, updated_at, body FROM memory_entries ORDER BY id').all(), rows);
});

test('a verified note with a near-duplicate stays live: matches are recorded in its body and an event, and nothing moves, merges or is deleted', async () => {
  const k1 = store.p("SELECT id FROM memory_entries WHERE type = 'note' AND title LIKE '%K1 loader%'").get().id;
  const dup = store.p("SELECT id FROM memory_entries WHERE type = 'note' AND title LIKE '%K1x loader%'").get().id;
  const distinct = store.p("SELECT id FROM memory_entries WHERE type = 'note' AND title LIKE '%K2 loader%'").get().id;
  store.setStatus(dup, { status: 'verified', receipt: 'test:verified', by: 'operator', at: Date.now() });
  const total = store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  const namespaces = store.p('SELECT id, namespace FROM memory_entries ORDER BY id').all();

  const r1 = await call('memory.embedNote', operator, { id: dup, embed_run: 'embed-test' });
  assert.deepStrictEqual([r1.embedded, r1.state, r1.namespace], [true, 'stored', 'project/acme']);
  assert.deepStrictEqual(r1.matches.map(m => m.id), [k1]);
  assert.ok(r1.matches[0].similarity >= 0.8);
  const row = rowOf(dup);
  assert.ok(row.embedding, 'it has its vector');
  assert.deepStrictEqual([row.namespace, row.status], ['project/acme', 'verified']);
  const b = bodyOf(dup);
  assert.deepStrictEqual([b.state, b.matches.map(m => m.id)], ['live', [k1]], 'body.matches in the hand-back shape, the note still live');

  const ev = (await call('memory.events', operator, { kinds: ['note_matches'] })).events;
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual(ev[0].row_ids, [dup, k1]);
  const msg = JSON.parse(ev[0].message);
  assert.deepStrictEqual([msg.note_id, msg.matches.map(m => m.id), msg.embed_run, msg.notes_match_n], [dup, [k1], 'embed-test', 3]);

  // still delivered: found by search and in the first-message index
  const found = await call('memory.search', operator, { query: 'K1x loader', namespace: 'project/acme', mode: 'keyword' });
  assert.ok(found.results.some(r => r.id === dup), 'search finds it');
  const idx = await call('memory.index', orch, { namespaces: ['project/acme'], query: 'K1x loader' });
  assert.ok(idx.row_ids.includes(dup), 'the index carries it');

  const r2 = await call('memory.embedNote', operator, { id: distinct });
  assert.deepStrictEqual([r2.embedded, r2.state, r2.namespace, r2.matches], [true, 'stored', 'project/acme', []]);
  assert.strictEqual((await call('memory.events', operator, { kinds: ['note_matches'] })).events.length, 1, 'no event for a note with no match');
  assert.strictEqual(store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n, total, 'nothing was added or deleted');
  assert.deepStrictEqual(store.p('SELECT id, namespace FROM memory_entries ORDER BY id').all(), namespaces, 'no row changed namespace');
  assert.strictEqual((await call('memory.unembedded', operator, {})).total, 0);
});

test("a worker's reported_wrong of an embedded note still releases the lease", async () => {
  const dup = store.p("SELECT id FROM memory_entries WHERE type = 'note' AND title LIKE '%K1x loader%'").get().id;
  const t = await call('task.create', orch, { spec: `job ${++seq}` });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: 'w1' });
  const out = await call('lease.release', worker, { lease_id: a.new_lease.id, notes: [], reported_wrong: [{ id: dup, why: 'the loader was fixed' }] });
  assert.strictEqual(out.state, 'released');
  assert.strictEqual(out.reported_wrong[0].id, dup);
  assert.strictEqual(bodyOf(dup).reported_wrong.length, 1);
});

test('a second run embeds nothing new: the note answers already_embedded and no vector is made', async () => {
  const id = store.p("SELECT id FROM memory_entries WHERE type = 'note' AND title LIKE '%K2 loader%'").get().id;
  const calls = embedCalls, row = rowOf(id);
  const r = await call('memory.embedNote', operator, { id });
  assert.deepStrictEqual([r.action, r.embedded], ['already_embedded', false]);
  assert.strictEqual(embedCalls, calls);
  assert.deepStrictEqual(rowOf(id), row);
});

test('the levers are the hand-back\'s: a threshold above the cosine finds no match, and a bad value is refused', async () => {
  failEmbed = true;
  const out = await handBack([note('K4'), note('K4x')]);
  failEmbed = false;
  const [a, b] = out.notes.map(n => n.id);
  await call('memory.embedNote', operator, { id: a });
  const r = await call('memory.embedNote', operator, { id: b, notes_match_threshold: 0.999 });
  assert.deepStrictEqual([r.state, r.matches, r.notes_match_threshold, r.notes_match_n], ['stored', [], 0.999, 3]);
  await assert.rejects(call('memory.embedNote', operator, { id: a, notes_match_n: 99 }), e => e.code === 'E_ARGS');
  await assert.rejects(call('memory.embedNote', operator, { id: 'no-such-row' }), e => e.code === 'E_NOT_FOUND');
  const fact = (await call('memory.store', operator, { namespace: 'project/acme', text: 'a fact', embed: false })).id;
  await assert.rejects(call('memory.embedNote', operator, { id: fact }), e => e.code === 'E_ARGS');
});
