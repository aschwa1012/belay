'use strict';
// memory-held-matches.test.cjs — the orchestrator's memory.search names the held notes that matched but did not make the page
// (`held_matches`: `{id, kind}` each), only when there is one, never to a worker, and a search writes nothing. Real core, sandbox store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');

let X;
before(async () => { X = await setup('r-hmatch'); });
after(() => X.cleanup());

const NS = ['project/acme'];
function direct(title, k) {
  const v = new Array(64).fill(0); v[k] = 1;
  return X.store.storeIn({ namespace: 'project/acme', worker_id: 'w-direct', type: 'note', text: title, title,
    body: { kind: 'lesson', basis: 'observed', evidence: [], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: 64, run_id: null, task_id: null, source: 'model', written_by: 'worker:w-direct' }).id;
}
const dump = () => JSON.stringify(X.store.db.prepare('SELECT * FROM memory_entries ORDER BY id').all());

test('held notes pushed off a full page are named; a page that holds them, a worker and a page with none see no field; nothing is written', async () => {
  const held = await X.written('w-a1', 'K21');
  await X.reported('w-b1', held.note, 'the loader does read unlisted fixtures');
  assert.ok(X.activeHold(held.note), 'the report held the note');
  const plain = [direct('K21 one', 21), direct('K21 two', 21), direct('K21 three', 21)];

  const before = dump();
  const q = { namespaces: NS, query: 'K21 loader', view: 'compact' };
  const small = await X.call('memory.search', X.orch, { ...q, k: 3 });
  assert.deepStrictEqual(small.results.map((r) => r.id).sort(), [...plain].sort(), 'the page is full of notes that are not held');
  assert.deepStrictEqual(small.held_matches, [{ id: held.note, kind: 'wrong' }]);
  assert.deepStrictEqual((await X.call('memory.search', X.operator, { ...q, k: 3 })).held_matches, [{ id: held.note, kind: 'wrong' }]);

  const big = await X.call('memory.search', X.orch, { ...q, k: 50 });
  assert.ok(big.results.some((r) => r.id === held.note), 'on the page, it is marked there');
  assert.ok(!('held_matches' in big), 'a held note on the page is not repeated');

  const worker = await X.call('memory.search', X.worker('w-c1'), { ...q, k: 3 });
  assert.ok(!('held_matches' in worker) && !JSON.stringify(worker).includes(held.note), 'a worker is never told');

  const none = await X.call('memory.search', X.orch, { namespaces: NS, query: 'K22 unrelated', view: 'compact', k: 50 });
  assert.ok(!('held_matches' in none));
  assert.ok(!JSON.stringify(none).includes('held_matches'), 'zero bytes when absent');
  assert.strictEqual(dump(), before, 'the searches wrote nothing');
});
