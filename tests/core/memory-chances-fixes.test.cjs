'use strict';
// memory-chances-fixes.test.cjs — regression tests for the review of the notes sink record: the required memory_ids,
// one record per worker's life of a task, opened by a full search answer, the reported-wrong and verdict flags, late
// citations, and caps that cut and count instead of losing the record.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const RUN = 'rf-rec', OFF = 'rf-off', RFL = 'rf-rfl';
const orch = (run) => callerFor('orchestrator', { run_id: run });
const worker = (id, run) => callerFor('worker', { run_id: run, worker_id: id });
const call = (run, method, args = {}) => E.handle(method, { caller: orch(run), ...args });
const base = { project: 'acme', notes: true, first_message_index: true };

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const levers = { [RUN]: { ...base, notes_sink: 'record' }, [OFF]: base, [RFL]: { ...base, notes_sink: 'record', notes_reflection: true } };
  for (const run of Object.keys(levers)) await call(run, 'run.attach', { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify(levers[run]) });
  for (const [id, run] of [['w1', RUN], ['w2', RUN], ['wa', RUN], ['wb', RUN], ['woff', OFF], ['wrf', RFL]]) {
    await call(run, 'worker.write', { id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), model: 'claude-test-1' });
  }
});
after(() => { store.close(); cleanup(dir); });

function note(title, applies_to = []) {
  return store.storeIn({
    namespace: 'project/acme', worker_id: 'w0', type: 'note', text: `${title}\n${applies_to.join(' ')}`, title,
    body: { kind: 'lesson', basis: 'observed', evidence: [{ where: 'src/x.js', saw: 'saw it' }], applies_to, subjects: [], model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id: 'old-run', task_id: null, source: 'model', written_by: 'worker:w0',
  }).id;
}
async function task(run, w, spec) {
  const t = await call(run, 'task.create', { spec });
  const a = await call(run, 'task.assign', { task_id: t.id, worker_id: w });
  return { task_id: t.id, lease_id: a.new_lease.id };
}
const release = (run, w, lease_id, extra = {}) => E.handle('lease.release', { caller: worker(w, run), lease_id, notes: [], ...extra });
const events = (kind, task_id) => store.p('SELECT * FROM memory_event WHERE kind = ? AND task_id = ? ORDER BY seq').all(kind, task_id);
const indexed = (run, w, task_id, ids) => call(run, 'memory.recordEvent', { kind: 'index_injected', worker_id: w, task_id, row_ids: ids, bytes: 1, sha256: 'x' });

test('B-1: with the sink on a release without memory_ids is refused by name and retried; sink off and the reflection release are exempt', async () => {
  const t = await task(RUN, 'w1', 'needs ids');
  await assert.rejects(E.handle('lease.release', { caller: worker('w1', RUN), lease_id: t.lease_id, notes: [] }), (e) => e.code === 'E_ARGS' && /memory_ids is required/.test(e.message));
  assert.ok(await release(RUN, 'w1', t.lease_id, { memory_ids: [] }), 'the retry releases');
  const off = await task(OFF, 'woff', 'sink off needs nothing');
  assert.ok(await E.handle('lease.release', { caller: worker('woff', OFF), lease_id: off.lease_id, notes: [] }));
  const r = await task(RFL, 'wrf', 'reflect');
  await release(RFL, 'wrf', r.lease_id, { memory_ids: [] });
  assert.ok(await E.handle('lease.release', { caller: worker('wrf', RFL), lease_id: r.lease_id, notes: [] }), 'a released lease takes notes again without memory_ids');
});

test('S-1: a retry by another worker is recorded on its own and does not inherit the first worker\'s deliveries or citations', async () => {
  const n = note('retry claim', ['src/retry.cjs']);
  const t = await call(RUN, 'task.create', { spec: 'retry job' });
  const give = async (w) => (await call(RUN, 'task.assign', { task_id: t.id, worker_id: w })).new_lease.id;
  const l1 = await give('wa');
  await indexed(RUN, 'wa', t.id, [n]);
  await release(RUN, 'wa', l1, { memory_ids: [n] });
  const first = await call(RUN, 'memory.recordChances', { task_id: t.id, worker_id: 'wa' });
  assert.deepStrictEqual(first.chances.map((c) => [c.worker_id, c.route, c.used]), [['wa', 'index', true]]);
  const l2 = await give('wb');
  await release(RUN, 'wb', l2, { memory_ids: [n] });
  const second = await call(RUN, 'memory.recordChances', { task_id: t.id, worker_id: 'wb', shown: [{ route: 'search', ids: [n] }] });
  assert.strictEqual(second.already, false, 'the second life is not swallowed by the first');
  assert.deepStrictEqual(second.chances.map((c) => [c.worker_id, c.route, c.used]), [['wb', 'search', true]], 'wa\'s index delivery is not wb\'s');
  await assert.rejects(call(RUN, 'memory.recordChances', { task_id: t.id }), (e) => e.code === 'E_ARGS');
  assert.strictEqual((await call(RUN, 'memory.recordChances', { task_id: t.id, worker_id: 'wa' })).already, true);
});

test('S-1: a citation by a worker that was never shown the note is not a use', async () => {
  const n = note('shown to a only', ['src/onlya.cjs']);
  const t = await call(RUN, 'task.create', { spec: 'crash then retry' });
  await call(RUN, 'task.assign', { task_id: t.id, worker_id: 'wa' });
  await indexed(RUN, 'wa', t.id, [n]); // wa crashed without releasing
  const b = await call(RUN, 'task.assign', { task_id: t.id, worker_id: 'wb' });
  await release(RUN, 'wb', b.new_lease.id, { memory_ids: [n] });
  const out = await call(RUN, 'memory.recordChances', { task_id: t.id, worker_id: 'wb' });
  assert.deepStrictEqual(out.chances, [], 'wb was shown nothing');
});

test('S-2: a search answer that carried the whole row is opened; an index-view answer is not', async () => {
  const full = note('seen whole'), brief = note('seen as title');
  const t = await task(RUN, 'w1', 'opened by search');
  const out = await call(RUN, 'memory.recordChances', { task_id: t.task_id, worker_id: 'w1', shown: [{ route: 'search', ids: [full, brief], full: [full] }] });
  const o = (id) => out.chances.find((c) => c.note_id === id).opened;
  assert.deepStrictEqual([o(full), o(brief)], [true, false]);
});

test('S-4: the chance says the note was reported wrong in that hand-back and that the hand-back carried a verdict', async () => {
  const wrong = note('reported wrong claim'), cited = note('cited claim');
  const t = await task(RUN, 'w2', 'review job');
  await release(RUN, 'w2', t.lease_id, { memory_ids: [wrong, cited], reported_wrong: [{ id: wrong, why: 'no longer true' }], result: { verdict: 'holds', summary: 's' } });
  const out = await call(RUN, 'memory.recordChances', { task_id: t.task_id, worker_id: 'w2', shown: [{ route: 'search', ids: [wrong, cited] }] });
  const c = (id) => out.chances.find((x) => x.note_id === id);
  assert.deepStrictEqual([c(wrong).reported_wrong, c(cited).reported_wrong, c(cited).review_handback], [true, false, true]);
});

test('S-5: ids cited in the reflection turn are joined on read as used_after_record', async () => {
  const n = note('cited late');
  const t = await task(RFL, 'wrf', 'late citation');
  await release(RFL, 'wrf', t.lease_id, { memory_ids: [] });
  await call(RFL, 'memory.recordChances', { task_id: t.task_id, worker_id: 'wrf', shown: [{ route: 'search', ids: [n] }] });
  await E.handle('lease.release', { caller: worker('wrf', RFL), lease_id: t.lease_id, notes: [], memory_ids: [n] });
  assert.deepStrictEqual(events('notes_applied', t.task_id).map((e) => JSON.parse(e.message).late), [false, true]);
  const got = await call(RFL, 'memory.noteDeliveries', { note_id: n });
  assert.deepStrictEqual(got.deliveries.map((d) => [d.used, d.used_after_record]), [[false, true]]);
});

test('S-6: more shown entries or files than the cap are cut and counted, never a lost record', async () => {
  const n = note('cap claim', ['src/cap.cjs']);
  const t = await task(RUN, 'w1', 'cap job');
  const shown = Array.from({ length: 205 }, () => ({ route: 'search', ids: [n] }));
  const files = Array.from({ length: 2005 }, (_, i) => `gen/f${i}.js`).concat(['src/cap.cjs']);
  const out = await call(RUN, 'memory.recordChances', { task_id: t.task_id, worker_id: 'w1', shown, changed_files: files });
  assert.deepStrictEqual(out.dropped, { shown: 5, changed_files: 6 });
  assert.ok(out.chances.length === 1 && out.chances[0].truncated === true);
});
