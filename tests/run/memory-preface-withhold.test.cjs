'use strict';
// memory-preface-withhold.test.cjs — the first-message index is delivered to a WORKER but built through the run manager's harness core
// (an orchestrator on the harness channel). Held-note withholding is by the recipient: the worker the spawn names, so a note held on a
// report does not reach the worker's injected index (ADR 0047 amendment, 2026-10-22). Driven through the real preface function and the
// real core method, not a direct index call.

const test = require('node:test');
const assert = require('node:assert');
const MP = require('../../src/run/memory-preface.cjs');
const { core: coreOf, sandbox, cleanup } = require('../core/helpers.cjs');
const { withTeardown } = require('../helpers/teardown.cjs');

const { Store } = coreOf('store.cjs');
const { Engine } = coreOf('engine.cjs');

const PROMPT = 'withholdcase';

async function fixture(levers) {
  const dir = sandbox();
  const store = new Store(`${dir}/memory.db`, { stamp: true });
  const E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const harness = { role: 'orchestrator', run_id: 'pf-run', pid: process.pid, channel: 'harness' };
  await E.handle('run.attach', { caller: { role: 'orchestrator', run_id: 'pf-run', pid: process.pid }, adapter_pid: process.pid, project: 'pf', memory_levers: JSON.stringify({ project: 'pf', notes: true, ...levers }) });
  const mk = (title) => store.storeIn({
    namespace: 'project/pf', worker_id: 'w1', type: 'note', text: `${title} withholdcase`, title,
    body: { kind: 'lesson', basis: 'inferred', evidence: [], applies_to: [], subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id: 'gone-run', task_id: null, source: 'model', written_by: 'worker:w1',
  }).id;
  const plain = mk('plain lesson');
  const held = mk('held lesson');
  store.storeIn({ namespace: 'held/pf', worker_id: 'harness', type: 'held', text: 'h', title: 'h', body: { state: 'held', note_id: held, kind: 'wrong', ground: 'reported', reports: [{ key: 'k1', by: 'orchestrator', why: 'x', at: 1 }], rev: 1 }, run_id: 'gone-run', source: 'harness', written_by: 'harness' });
  const core = { memory: {
    events: async () => ({ events: [] }),
    recordEvent: async (a) => a,
    index: (a) => E.handle('memory.index', { caller: harness, ...a }), // what the manager's harness core does
  } };
  const ctx = { core, runId: 'pf-run', memoryLevers: { first_message_index: true, index_bytes: 1200, project: 'pf', notes: true } };
  return { dir, store, ctx, plain, held, E, harness };
}

test('a worker\'s injected index leaves out a note held on a report; the orchestrator\'s index and warn mode keep it', async () => {
  const f = await fixture({});
  const w = await fixture({ held_visibility: 'warn' });
  await withTeardown(async () => {
    const text = await MP.memoryPreface({ id: 'w-new', taskId: null }, f.ctx, PROMPT);
    assert.ok(text.includes(f.plain), 'the plain note is listed');
    assert.ok(!text.includes(f.held), 'the held note is withheld from the worker it is delivered to');
    const own = await f.E.handle('memory.index', { caller: f.harness, query: PROMPT }); // no worker named: the orchestrator's own index
    assert.ok(own.row_ids.includes(f.held));
    const warned = await MP.memoryPreface({ id: 'w-new', taskId: null }, w.ctx, PROMPT);
    assert.ok(warned.includes(w.held), 'warn keeps today\'s display');
    const knowledge = await f.E.handle('memory.index', { caller: f.harness, query: PROMPT, worker_id: 'knowledge-1' });
    assert.ok(knowledge.row_ids.includes(f.held), 'the knowledge agent answers the orchestrator and sees it');
  }, [() => f.store.close(), () => w.store.close(), () => cleanup(f.dir), () => cleanup(w.dir)]);
});

test('a tool-channel call cannot name a recipient: the caller field is not the wire\'s', async () => {
  const f = await fixture({});
  await withTeardown(async () => {
    const o = await f.E.handle('memory.index', { caller: { role: 'orchestrator', run_id: 'pf-run', pid: process.pid }, query: PROMPT, worker_id: 'w-x' });
    assert.ok(o.row_ids.includes(f.held), 'the orchestrator on the tool channel is not withheld from, whatever worker_id it passes');
  }, [() => f.store.close(), () => cleanup(f.dir)]);
});
