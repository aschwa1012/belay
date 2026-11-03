'use strict';
// embedder-dead-child.test.cjs — the embedder child dies after its load (ADR 0034 and amendment 1). The owner keeps handing out the same
// Embedder object, so every later call must still be an embedder failure (detail.embedder true, cause dead) for the run's guard to hear
// of it: under required the run pauses, under keyword the failure is recorded and a write is stored without a vector, under off the
// memory goes off and a hand-back drops its notes and releases its lease, even when the hand-back is the first call to meet the death.
// A real embed-worker child is started and killed by its own handle; no model is loaded (pipe is set by hand, as a load would).

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Embedder } = core('embedder.cjs');
const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');
const { createEmbedderGuard } = require('../../src/run/embedder-guard.cjs');

let dead = null;
async function deadEmbedder() {
  if (dead) return dead;
  const e = new Embedder({ cacheDir: sandbox() });
  e._start();
  e.pipe = { process: e.pid }; // what a good load leaves behind
  const gone = new Promise((res) => e.child.once('exit', res));
  e.child.kill(); // the exact child this test started
  await gone;
  dead = e;
  return e;
}
after(async () => { if (dead) { await dead.close(); cleanup(dead.cacheDir); } });

test('a call after the child died is an embedder failure with cause dead, naming the pid', async () => {
  const e = await deadEmbedder();
  for (const call of [() => e.embed('x', { as: 'query' }), () => e.tokenCount('x')]) {
    const x = await call().then(() => null, (y) => y);
    assert.ok(x, 'refused');
    assert.strictEqual(x.code, 'E_MODEL_ABSENT');
    assert.ok(x.detail && x.detail.embedder === true, `detail.embedder must be true: ${JSON.stringify(x.detail)}`);
    assert.strictEqual(x.detail.cause, 'dead');
    assert.strictEqual(x.detail.pid, e.pid);
    assert.match(x.message, /exited/);
  }
});

const RUN = 'r';
const orch = callerFor('orchestrator', { run_id: RUN });
const worker = callerFor('worker', { run_id: RUN, worker_id: 'wd' });
const note = (m) => ({ kind: 'lesson', title: `the ${m} loader skips unlisted fixtures`, when: `add a ${m} test fixture`, basis: 'observed', evidence: [{ where: `src/${m}.js`, saw: 'never read' }], applies_to: [`src/${m}.js`], subjects: [m] });

// An engine in a run's owner: the guard is the run's, the embedder is the dead child's.
async function inRun(mode, fn) {
  const dir = sandbox();
  const store = new Store(path.join(dir, 'memory.db'), { stamp: true });
  try {
    const emb = await deadEmbedder();
    const pauses = [];
    const guard = createEmbedderGuard({ mode, pauseRun: async (why) => { pauses.push(why); return {}; }, stopRun: async () => {} });
    const owner = { stopped: false, opts: { embedderMode: () => guard.mode(), memoryOff: () => guard.memoryOff(), onEmbedderFailure: (ev) => guard.onFailure(ev) } };
    const E = new Engine({ dataDir: dir, store, getEmbedder: async () => emb, owner, establishedBy: 'owner' });
    owner.engine = E;
    await E.handle('run.attach', { caller: orch, adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
    await E.handle('worker.write', { caller: orch, id: 'wd', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-wd', last_event_at: Date.now(), model: 'claude-test-1' });
    store.store({ namespace: `run/${RUN}`, worker_id: 'wd', text: 'the owner pipe wedges when the loop blocks', embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3 });
    const lease = async () => {
      const t = await E.handle('task.create', { caller: orch, spec: 'job' });
      const a = await E.handle('task.assign', { caller: orch, task_id: t.id, worker_id: 'wd' });
      return { lease_id: a.new_lease.id, task_id: t.id };
    };
    await fn({ E, store, guard, pauses, lease });
    await guard.settled();
  } finally { store.close(); cleanup(dir); }
}
const search = (E, caller) => E.handle('memory.search', { caller, namespace: `run/${RUN}`, query: 'owner pipe', mode: 'hybrid' });

test('required: a search after the child died pauses the run and is refused with the pause advice', async () => {
  await inRun('required', async ({ E, guard, pauses }) => {
    const x = await search(E, worker).then(() => null, (y) => y);
    assert.ok(x, 'refused, not answered from keywords');
    assert.strictEqual(x.code, 'E_MODEL_ABSENT', `${x.code}: ${x.message}`);
    assert.match(x.message, /Stop and wait: you will be resumed/);
    await guard.settled();
    assert.strictEqual(pauses.length, 1, 'the run was asked to pause');
    assert.match(pauses[0], /^embedder-failure \(wd, memory\.search, E_MODEL_ABSENT, dead\)$/);
    assert.deepStrictEqual(guard.events().map((v) => [v.call, v.cause, v.action]), [['memory.search', 'dead', 'pause']]);
  });
});

test('keyword: the death is recorded, the search answers from keywords, and a store is kept without a vector', async () => {
  await inRun('keyword', async ({ E, store, guard, pauses }) => {
    const r = await search(E, worker);
    assert.deepStrictEqual(r.modes_run, ['keyword']);
    assert.strictEqual(r.modes_failed[0].code, 'E_MODEL_ABSENT');
    const w = await E.handle('memory.store', { caller: worker, text: 'a lesson written after the death' });
    assert.strictEqual(w.embedded, false);
    assert.strictEqual(w.embedder_failure.code, 'E_MODEL_ABSENT');
    assert.strictEqual(store.p('SELECT embedding IS NULL AS nul FROM memory_entries WHERE id = ?').get(w.id).nul, 1);
    const turn = await E.handle('memory.store', { caller: callerFor('orchestrator', { run_id: RUN, channel: 'harness' }), text: 'turn 1 of wd', type: 'turn', worker_id: 'wd', turn: 1 });
    assert.strictEqual(turn.embedded, false, 'a harness turn row is kept too');
    await guard.settled();
    assert.deepStrictEqual(pauses, []);
    assert.deepStrictEqual(guard.events().map((v) => [v.call, v.cause, v.action]), [['memory.search', 'dead', 'continue'], ['memory.store', 'dead', 'continue'], ['memory.store', 'dead', 'continue']]);
  });
});

test('off: a search after the death turns memory off, and the hand-back then drops its notes and releases', async () => {
  await inRun('off', async ({ E, guard, lease }) => {
    const x = await search(E, worker).then(() => null, (y) => y);
    assert.strictEqual(x && x.code, 'E_LEVER_OFF');
    assert.strictEqual(guard.memoryOff(), true);
    const l = await lease();
    const out = await E.handle('lease.release', { caller: worker, lease_id: l.lease_id, notes: [note('D1')], reported_wrong: [] });
    assert.strictEqual(out.state, 'released');
    assert.strictEqual(out.notes_dropped.notes, 1);
  });
});

test('off: a hand-back that is the first call to meet the death drops its notes and still releases the lease', async () => {
  await inRun('off', async ({ E, store, guard, lease }) => {
    const l = await lease();
    const out = await E.handle('lease.release', { caller: worker, lease_id: l.lease_id, notes: [note('D2')], reported_wrong: [] });
    assert.strictEqual(out.state, 'released');
    assert.strictEqual(out.notes_dropped.notes, 1);
    assert.match(out.notes_dropped.reason, /notes are off/);
    assert.strictEqual(store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'note'").get().n, 0);
    assert.strictEqual((await E.handle('task.get', { caller: orch, task_id: l.task_id })).state, 'released');
    assert.strictEqual(guard.memoryOff(), true);
    assert.deepStrictEqual(guard.events().map((v) => [v.call, v.cause, v.action]), [['memory.store', 'dead', 'off']]);
  });
});
