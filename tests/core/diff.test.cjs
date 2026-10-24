'use strict';
// diff.test.cjs — build step 4c, done item 1. store.diff
// (src/core/methods-diff.cjs) as a Core API read method: rows added, updated, superseded or expired
// since a mark the caller supplies. Every core that elects is declared with `let` before the `try` and
// shut down through `shutdownOwner()` in a `finally`.

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, listDataDir, sleep } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const rows = core('rows.cjs');

const vec = (seed) => Array.from({ length: 384 }, (_, i) => (((i + seed) % 7) + 1) / 10);

test('store.diff: rows written after the mark are added or updated per table, an updated row names the seq it supersedes, and rows at or before the mark are absent', async () => {
  const dir = sandbox();
  let orch;
  try {
    orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-x' }), embed: false });
    await orch.run.attach({ adapter_pid: process.pid });
    const w1a = await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'starting', started_at: Date.now() });
    const t1 = await orch.task.create({ spec: 'a task planted before the mark' });

    await sleep(20);
    const sinceMs = Date.now();
    // The at-mark boundary itself (FINDINGS.json line 15): a row written in the same millisecond as the
    // mark, planted directly through rows.append with an explicit `at`, must be absent — changing the
    // core's `written_at > ?` to `>=` would surface it as an added row and fail the counts below.
    rows.append(orch.owner.store, 'worker', { id: 'w-at-mark', run_id: 'run-x', substrate: 'claude-code', state: 'starting' }, 'test', sinceMs);
    await sleep(20);

    const w1b = await orch.worker.write({ id: 'w1', state: 'running' }); // worker: updated, supersedes w1a
    const assign = await orch.task.assign({ task_id: t1.id, worker_id: 'w1' }); // task: updated; lease: added
    const ckpt = await orch.continuity.checkpoint({ task_id: t1.id, worker_id: 'w1', turn: 1, files_touched: ['a.txt'] }); // checkpoint: added

    const d = await orch.store.diff({ since_ms: sinceMs, run_id: 'run-x' });
    assert.strictEqual(d.since_ms, sinceMs);
    assert.strictEqual(d.run_id, 'run-x');
    assert.strictEqual(d.established_by, 'owner');

    assert.deepStrictEqual(d.counts.run, { added: 0, updated: 0 }, 'the run row was written before the mark');
    assert.deepStrictEqual(d.counts.task, { added: 0, updated: 1 });
    assert.strictEqual(d.tables.task.updated[0].id, t1.id);
    assert.strictEqual(d.tables.task.updated[0].supersedes_seq, t1.seq);

    assert.deepStrictEqual(d.counts.worker, { added: 0, updated: 1 }, 'the at-mark row must not be counted');
    assert.ok(!d.tables.worker.added.some(r => r.id === 'w-at-mark') && !d.tables.worker.updated.some(r => r.id === 'w-at-mark'),
      'a row written exactly at the mark must be absent');
    assert.strictEqual(d.tables.worker.updated[0].id, 'w1');
    assert.strictEqual(d.tables.worker.updated[0].seq, w1b.seq);
    assert.strictEqual(d.tables.worker.updated[0].supersedes_seq, w1a.seq);

    assert.deepStrictEqual(d.counts.lease, { added: 1, updated: 0 }, 'the first lease row for this task is added, never updated');
    assert.strictEqual(d.tables.lease.added[0].id, assign.new_lease.id);
    assert.strictEqual(d.tables.lease.added[0].supersedes_seq, undefined, 'an added row carries no supersedes_seq');

    assert.deepStrictEqual(d.counts.checkpoint, { added: 1, updated: 0 });
    assert.strictEqual(d.tables.checkpoint.added[0].id, ckpt.id);

    // since_ms: 0 returns everything as added or updated: the run row and each id's first row are
    // added, the worker's second row and the task's assigned row are updated. The at-mark plant is its
    // own id's only row, so from the epoch it is added, never updated.
    const dAll = await orch.store.diff({ since_ms: 0, run_id: 'run-x' });
    assert.deepStrictEqual(dAll.counts.run, { added: 1, updated: 0 });
    assert.deepStrictEqual(dAll.counts.worker, { added: 2, updated: 1 });
    assert.deepStrictEqual(dAll.counts.task, { added: 1, updated: 1 });
    assert.deepStrictEqual(dAll.counts.lease, { added: 1, updated: 0 });
    assert.deepStrictEqual(dAll.counts.checkpoint, { added: 1, updated: 0 });
  } finally {
    if (orch) { await orch.shutdownOwner(); await orch.close(); }
    cleanup(dir);
  }
});

test('store.diff: memory rows are added, updated, superseded or expired, and an expired row is reported only while it is still present', async () => {
  const dir = sandbox();
  let orch;
  try {
    orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-y' }) });
    const ns = 'run/run-y';
    const rowA = await orch.memory.store({ namespace: ns, text: 'original row A', embedding: vec(0), embedding_model: 'fixture', dim: 384 });
    const rowDInitial = await orch.memory.store({ namespace: ns, text: 'row d text, stable across an update', embedding: vec(3), embedding_model: 'fixture', dim: 384 });

    await sleep(20);
    const sinceMs = Date.now();
    await sleep(20);

    const rowB = await orch.memory.store({ namespace: ns, text: 'row B, supersedes A', embedding: vec(1), embedding_model: 'fixture', dim: 384, supersedes: rowA.id });
    const rowC = await orch.memory.store({ namespace: ns, text: 'row C, expires almost at once', embedding: vec(2), embedding_model: 'fixture', dim: 384, ttl_seconds: 0.001 });
    const rowDUpdated = await orch.memory.store({ namespace: ns, text: 'row d text, stable across an update', embedding: vec(3), embedding_model: 'fixture', dim: 384, tags: ['touched'] });
    assert.strictEqual(rowDUpdated.action, 'updated', 'the fixture must actually re-store the same text');
    assert.strictEqual(rowDUpdated.id, rowDInitial.id);

    await sleep(50); // past rowC's ttl_at

    const d = await orch.store.diff({ since_ms: sinceMs, run_id: 'run-y' });
    const m = d.tables.memory;

    assert.deepStrictEqual(m.added.map(r => r.id).sort(), [rowB.id, rowC.id].sort(), 'rowD was not newly created after the mark');
    assert.deepStrictEqual(m.updated.map(r => r.id), [rowDInitial.id], 'rowD is updated_at after the mark but created_at at or before it');
    assert.strictEqual(m.superseded.length, 1);
    assert.strictEqual(m.superseded[0].id, rowA.id);
    assert.strictEqual(m.superseded[0].superseded_by, rowB.id);
    assert.strictEqual(m.expired.length, 1);
    assert.strictEqual(m.expired[0].id, rowC.id);
    assert.ok(m.note && /sweep/i.test(m.note), `the note must name what sweep does to an expired row: ${m.note}`);
    assert.strictEqual(m.added[0].embedding, undefined, 'a diff row carries no vector');
    assert.deepStrictEqual(d.counts.memory, { added: 2, updated: 1, superseded: 1, expired: 1 });

    // Once swept, the expired row is no longer reported (through whatever the store exposes to a test:
    // the owner's own store instance, in-process — this is a core-level test, not the CLI).
    assert.ok(orch.owner && orch.owner.store, 'this test needs the in-process owner to reach its store');
    const swept = orch.owner.store.sweep();
    assert.ok(swept.expired_deleted >= 1, 'the sweep must actually have deleted something');
    const dAfterSweep = await orch.store.diff({ since_ms: sinceMs, run_id: 'run-y' });
    assert.strictEqual(dAfterSweep.tables.memory.expired.length, 0, 'a swept row cannot be reported after the fact');
  } finally {
    if (orch) { await orch.shutdownOwner(); await orch.close(); }
    cleanup(dir);
  }
});

// Expired is judged since the mark, not merely against now_ms (FINDINGS.json line 76).
test('store.diff: expired is judged since the mark, and a row created after the mark that is also already expired appears in both added and expired', async () => {
  const dir = sandbox();
  let orch;
  try {
    orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-mark' }) });
    const ns = 'run/run-mark';
    const rowX = await orch.memory.store({ namespace: ns, text: 'row X expires long before the mark', embedding: vec(0), embedding_model: 'fixture', dim: 384, ttl_seconds: 0.001 });
    await sleep(30);
    const rowY = await orch.memory.store({ namespace: ns, text: 'row Y created before the mark, expires after it', embedding: vec(1), embedding_model: 'fixture', dim: 384, ttl_seconds: 0.4 }); // long enough that a stalled machine cannot expire it before the mark (the test's own wall clock, not the store's)
    await sleep(30);
    const sinceMs = Date.now();
    await sleep(30);
    const rowZ = await orch.memory.store({ namespace: ns, text: 'row Z created and expired after the mark', embedding: vec(2), embedding_model: 'fixture', dim: 384, ttl_seconds: 0.001 });
    await sleep(450);

    const d = await orch.store.diff({ since_ms: sinceMs, run_id: 'run-mark' });
    const m = d.tables.memory;

    assert.ok(!m.expired.some(r => r.id === rowX.id), 'a row already expired at or before the mark must not be reported as expired');
    assert.ok(!m.added.some(r => r.id === rowX.id), 'row X was created before the mark');

    assert.ok(m.expired.some(r => r.id === rowY.id), 'row Y expired since the mark and must be reported');
    assert.ok(!m.added.some(r => r.id === rowY.id), 'row Y was created before the mark, so it is not added');

    assert.ok(m.added.some(r => r.id === rowZ.id), 'row Z was created after the mark');
    assert.ok(m.expired.some(r => r.id === rowZ.id), 'row Z is also already expired since the mark');
    assert.ok(/both/i.test(m.note), `the note must say a row can be in both added and expired: ${m.note}`);
  } finally {
    if (orch) { await orch.shutdownOwner(); await orch.close(); }
    cleanup(dir);
  }
});

test('store.diff: run_id filters every table to that run and memory to its namespace; since_ms is required and validated; a copy read answers established_by copy and creates nothing', async () => {
  const dir = sandbox();
  let orchP, orchQ, reader;
  try {
    orchP = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-p' }), embed: false });
    await orchP.run.attach({ adapter_pid: process.pid });
    const tp = await orchP.task.create({ spec: 'belongs to run-p' });
    await orchP.memory.store({ namespace: 'run/run-p', text: 'a row in run-p namespace', embedding: vec(4), embedding_model: 'fixture', dim: 384 });

    orchQ = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-q' }), embed: false });
    await orchQ.run.attach({ adapter_pid: process.pid });
    const tq = await orchQ.task.create({ spec: 'belongs to run-q' });
    await orchQ.memory.store({ namespace: 'run/run-q', text: 'a row in run-q namespace', embedding: vec(5), embedding_model: 'fixture', dim: 384 });

    const dP = await orchP.store.diff({ since_ms: 0, run_id: 'run-p' });
    assert.deepStrictEqual(dP.tables.task.added.map(r => r.id), [tp.id]);
    assert.strictEqual(dP.tables.memory.added.length, 1);
    assert.strictEqual(dP.tables.memory.added[0].namespace, 'run/run-p');
    assert.ok(!dP.tables.task.added.some(r => r.id === tq.id), "run-p's diff must never name run-q's task");

    // since_ms validation: E_ARGS on missing, negative or non-integer.
    await assert.rejects(orchP.store.diff({ run_id: 'run-p' }), e => e.code === 'E_ARGS');
    await assert.rejects(orchP.store.diff({ since_ms: -1 }), e => e.code === 'E_ARGS');
    await assert.rejects(orchP.store.diff({ since_ms: 1.5 }), e => e.code === 'E_ARGS');
    await assert.rejects(orchP.store.diff({ since_ms: 'now' }), e => e.code === 'E_ARGS');

    // A copy read: shut both owners down, open a fresh operator core, and read through the copy.
    await orchP.shutdownOwner(); await orchP.close(); orchP = null;
    await orchQ.shutdownOwner(); await orchQ.close(); orchQ = null;

    const before = listDataDir(dir);
    reader = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const dCopy = await reader.store.diff({ since_ms: 0 });
    assert.strictEqual(dCopy.established_by, 'copy');
    assert.deepStrictEqual(listDataDir(dir), before, 'a copy read must create nothing in the data dir');
  } finally {
    if (orchP) { await orchP.shutdownOwner(); await orchP.close(); }
    if (orchQ) { await orchQ.shutdownOwner(); await orchQ.close(); }
    if (reader) await reader.close();
    cleanup(dir);
  }
});
