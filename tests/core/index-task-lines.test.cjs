'use strict';
// index-task-lines.test.cjs — the first-message index of a worker the PLAN EXECUTOR spawns: the orchestrator never calls worker_spawn, so the
// only search lines a worker can have are the ones kept on its task (task_create memory_queries). The core reads them from the task row at
// memory.embedQuery, embeds them as plain lines beside the whole spec, and memory.index scores the two apart. A stub embedder stands in for
// the model: texts about timers sit at [1, 0, 0], texts about dates at [0, 1, 0], anything else at [0, 0, 1].

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const rows = core('rows.cjs');
const NANO = require('../../src/core/retrieval-profiles.cjs').NANO;

const vecOf = (text) => (/timer|midnight/i.test(text) ? [1, 0, 0] : /date|calendar/i.test(text) ? [0, 1, 0] : [0.05, 0.05, 1]);
const embedded = [];
const RUN = 'itl-run';
let dir, store, E, harness, orch;

before(async () => {
  dir = sandbox();
  store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  const owner = { opts: { embedderMode: 'required', onEmbedderFailure: () => {} } };
  const embedder = { embed: async (text) => { embedded.push(text); return { embedding: vecOf(text), embedding_model: NANO, embedding_revision: 'r', dim: 3 }; } };
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => embedder, owner, establishedBy: 'test' });
  harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
  orch = callerFor('orchestrator', { run_id: RUN });
  await E.handle('run.attach', { caller: orch, adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
});
after(() => { store.close(); cleanup(dir); });

let n = 0;
function note(title, vec) {
  const r = store.storeIn({
    namespace: 'project/acme', worker_id: 'w1', type: 'note', text: title, title,
    body: { kind: 'lesson', basis: 'inferred', evidence: [], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: vec, embedding_model: NANO, embedding_revision: 'r', dim: 3, run_id: 'old-run', task_id: null, source: 'model', written_by: 'worker:w1',
  });
  store.db.prepare('UPDATE memory_entries SET created_at = ? WHERE id = ?').run(1000 + n++, r.id);
  return r.id;
}

// What the run manager does for a worker the plan spawns: embedQuery by task id (no extra texts), then index with the vectors.
async function indexFor(taskId, extra) {
  const q = await E.handle('memory.embedQuery', { caller: harness, task_id: taskId, worker_id: 'w-plan', ...(extra ? { extra_texts: extra } : {}) });
  const query_embeddings = q.queries.filter((x) => x.ok).map((x) => ({ vector: x.query_embedding, model: x.embedding_model, label: x.label }));
  return E.handle('memory.index', { caller: orch, task_id: taskId, query_embeddings });
}

test('a plan-spawned worker\'s boilerplate spec lists nothing, and the task\'s lines list the note they name', async () => {
  const timer = note('the midnight rollover rule of the timer', [1, 0, 0]);
  note('a note about calendar dates', [0, 1, 0]);
  rows.append(store, 'task', { id: 't-boiler', run_id: RUN, spec: 'Tickets: T11', state: 'open' }, 'orchestrator');
  const bare = await indexFor('t-boiler');
  assert.deepStrictEqual(bare.row_ids, [], 'no lines and a spec that says nothing: nothing is listed');
  assert.strictEqual(bare.bar.spec_only, true);
  assert.strictEqual(bare.none_passed, true);

  rows.append(store, 'task', { id: 't-lines', run_id: RUN, spec: 'Tickets: T11', state: 'open', memory_queries: ['stop --at just after midnight', 'lib/timer.js start and stop'] }, 'orchestrator');
  embedded.length = 0;
  const r = await indexFor('t-lines');
  assert.deepStrictEqual(embedded, ['Tickets: T11', 'stop --at just after midnight', 'lib/timer.js start and stop'], 'the spec and the lines, plain, with no Task: prefix');
  assert.deepStrictEqual(r.row_ids, [timer]);
  assert.deepStrictEqual(r.bar.listed.map((x) => [x.id, x.sub, x.why]), [[timer, 1, 'sub']]);
  assert.deepStrictEqual([r.bar.subqueries, r.bar.spec_only], [2, false]);
});

test('a spec that is itself about the note lists it with no lines (spec-only), and with lines through the stricter spec floor', async () => {
  rows.append(store, 'task', { id: 't-spec', run_id: RUN, spec: 'Fix the timer so midnight rolls over', state: 'open' }, 'orchestrator');
  const r = await indexFor('t-spec');
  assert.deepStrictEqual(r.bar.listed.map((x) => x.why), ['spec_only']);
  rows.append(store, 'task', { id: 't-spec-l', run_id: RUN, spec: 'Fix the timer so midnight rolls over', state: 'open', memory_queries: ['calendar dates'] }, 'orchestrator');
  const w = await indexFor('t-spec-l');
  assert.deepStrictEqual(w.bar.listed.map((x) => x.why).sort(), ['spec', 'sub'], 'the timer note by the spec leg, the date note by the line');
});
