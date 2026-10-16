'use strict';
// memory-note-contract-lifecycle.test.cjs — how the notes lifecycle sees the `when` field and the text template: a stream quote of a
// note's own `when` is refused as self-quoting; the reviewer's brief and the scrub items show the `when`; and the near-duplicate
// threshold (measured on v1 text) is applied only between vectors of the same template, never across v1 and v2.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const CC = core('memory-citations.cjs');
const F = core('memory-facts.cjs');
const { noteFacts } = core('methods-memory-stages.cjs');
const { notesUnderReview } = core('note-review-facts.cjs');
const { reviewerTail } = require('../../src/run/note-review-text.cjs');

let dir, store, E;
const RUN = 'r-lc';
const orch = callerFor('orchestrator', { run_id: RUN });
const worker = callerFor('worker', { run_id: RUN, worker_id: 'w1' });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
let seq = 0;

const DIM = 16;
const vecOf = (text) => { const m = /\bK(\d+)\b/.exec(text); const v = new Array(DIM).fill(0); v[m ? Number(m[1]) : DIM - 1] = 1; return v; };
const embedder = { embed: async (text) => ({ embedding: vecOf(text), embedding_model: 'fake', embedding_revision: 'r', dim: DIM }) };
const note = (marker) => ({ kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `load a ${marker} test fixture`, basis: 'inferred', subjects: [marker] });
async function handBack(notes) {
  const t = await call('task.create', orch, { spec: `job ${++seq}` });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: 'w1' });
  return call('lease.release', worker, { lease_id: a.new_lease.id, notes });
}

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => embedder, owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  await call('worker.write', orch, { id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-w1', last_event_at: Date.now(), model: 'claude-test-1' });
});
after(() => { store.close(); cleanup(dir); });

test('a quote of the note\'s own when is refused as the note\'s own text, even where the stored text would not hold it', () => {
  const when = 'rotate the signing keys before a release';
  const own = F.ownTexts({ title: 'keys rotate on a schedule', text: 'keys rotate on a schedule', b: { when, evidence: [] } });
  assert.ok(own.includes(when), 'when is among the note\'s own words');
  assert.strictEqual(CC.selfQuoted(own, 'keys rotate on a schedule', 'rotate the signing keys'), true);
  assert.strictEqual(CC.selfQuoted(own, 'keys rotate on a schedule', 'something a tool actually printed'), false);
});

test('the reviewer\'s brief shows the when beside the claim, as data the writer stated', () => {
  const text = reviewerTail({ notes: [{ id: 'n1', kind: 'lesson', basis: 'inferred', task_id: 't1', written_by: 'worker:w1', title: 'the claim', when: 'add a migration', evidence: [] }], refuted_shown: [] });
  assert.match(text, /writer-stated: the claim \| writer-stated situation \(when\): add a migration/);
  const old = reviewerTail({ notes: [{ id: 'n2', kind: 'lesson', basis: 'inferred', task_id: 't1', written_by: 'worker:w1', title: 'older claim', evidence: [] }], refuted_shown: [] });
  assert.ok(!old.includes('situation'), 'a note without a when shows none');
});

test('the facts a reviewer and a scrubber are given carry the when', async () => {
  const out = await handBack([note('K1')]);
  const id = out.notes[0].id;
  const under = notesUnderReview(E, [out.notes[0].id && store.p('SELECT task_id FROM memory_entries WHERE id = ?').get(id).task_id], 'acme');
  assert.strictEqual(under.find((n) => n.id === id).when, 'load a K1 test fixture');
  const row = F.loadNote(E, id);
  assert.strictEqual(noteFacts(row).when, 'load a K1 test fixture');
});

test('a v1 note and a v2 note are never matched, even at cosine 1; two v2 notes are', async () => {
  // A v1 note with exactly the vector the new K2 note will get (axis 2).
  const v = vecOf('K2');
  const v1 = store.store({ namespace: 'project/acme', worker_id: 'harness', type: 'note', text: 'the K2 legacy loader note', title: 'the K2 legacy loader note', body: { kind: 'lesson', state: 'live' }, embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM, written_by: 'harness' }).id;
  assert.strictEqual(store.p('SELECT text_template FROM memory_entries WHERE id = ?').get(v1).text_template, 'v1');
  const first = await handBack([note('K2')]);
  assert.strictEqual(first.notes[0].state, 'stored', 'the v1 look-alike is not a match for a v2 note');
  assert.strictEqual(first.pending, 0);
  const second = await handBack([{ ...note('K2'), title: 'the K2 loader also skips unlisted fixtures' }]);
  assert.strictEqual(second.notes[0].state, 'pending', 'but the earlier v2 note is');
  assert.deepStrictEqual(second.notes[0].matches.map((m) => [m.id, m.template]), [[first.notes[0].id, 'v2']]);
  // the stored-cosine fact the scrubber uses follows the same rule
  const a = F.loadNote(E, v1), b = F.loadNote(E, first.notes[0].id), c = F.loadNote(E, second.notes[0].id);
  assert.strictEqual(F.storedCosine(a, b), null);
  assert.ok(F.storedCosine(b, c) > 0.99);
  // a v1 look-alike embedded later through the operator's embed is compared with v1 notes only
  const bare = store.store({ namespace: 'project/acme', worker_id: 'harness', type: 'note', text: 'the K2 other legacy note', title: 'the K2 other legacy note', body: { kind: 'lesson', state: 'live' }, written_by: 'harness' }).id;
  const done = await call('memory.embedNote', callerFor('operator', { run_id: 'cli' }), { id: bare });
  assert.deepStrictEqual(done.matches.map((m) => m.id), [v1], 'only the v1 note is compared with a v1 note');
});
