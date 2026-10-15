'use strict';
// memory-chances.test.cjs — the notes sink record: `memory_ids` on a hand-back, the `note_chance` facts derived at task
// end (route, slot, set size, opened, area, used), the changed-file fact, the lever, and the delivery read. Real Engine
// over a stamped store; notes are stored the way a hand-back stores them, so no model and no embedder is involved.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const L = core('memory-levers.cjs');

let dir, store, E;
const RUN = 'rc-rec', OFF = 'rc-off', PEN = 'rc-pen';
const orch = (run) => callerFor('orchestrator', { run_id: run });
const worker = (id, run) => callerFor('worker', { run_id: run, worker_id: id });
const call = (run, method, args = {}) => E.handle(method, { caller: orch(run), ...args });
const base = { project: 'acme', notes: true, first_message_index: true };

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const levers = { [RUN]: { ...base, notes_sink: 'record' }, [OFF]: base, [PEN]: { ...base, notes_sink: 'penalty' } };
  for (const run of Object.keys(levers)) await call(run, 'run.attach', { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify(levers[run]) });
  for (const [id, run] of [['w1', RUN], ['w2', RUN], ['woff', OFF], ['wpen', PEN]]) {
    await call(run, 'worker.write', { id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), model: 'claude-test-1' });
  }
});
after(() => { store.close(); cleanup(dir); });

function note(title, over = {}) {
  const { applies_to = [], subjects = [] } = over;
  return store.storeIn({
    namespace: 'project/acme', worker_id: 'w0', type: 'note', text: `${title}\n${applies_to.join(' ')}`, title,
    body: { kind: 'lesson', basis: 'observed', evidence: [{ where: 'src/x.js', saw: 'saw it' }], applies_to, subjects, model: 'm', state: 'live', seen_in: [], seen_total: 0, reported_wrong: [] },
    embedding: [1, 0, 0], embedding_model: 'm', embedding_revision: 'r', dim: 3, run_id: 'old-run', task_id: null, source: 'model', written_by: 'worker:w0',
  }).id;
}

// A task assigned to a worker with the index recorded as the manager records it; returns { task_id, lease_id, index }.
async function task(run, w, { spec, owned = [], index = true } = {}) {
  const t = await call(run, 'task.create', { spec, files_owned: owned });
  const a = await call(run, 'task.assign', { task_id: t.id, worker_id: w });
  let idx = null;
  if (index) {
    idx = await call(run, 'memory.index', { task_id: t.id, worker_id: w });
    await call(run, 'memory.recordEvent', { kind: 'index_injected', worker_id: w, task_id: t.id, row_ids: idx.row_ids, bytes: idx.bytes, sha256: idx.sha256 });
  }
  return { task_id: t.id, lease_id: a.new_lease.id, index: idx };
}
const release = (run, w, lease_id, extra = {}) => E.handle('lease.release', { caller: worker(w, run), lease_id, notes: [], ...extra });
const events = (kind, task_id) => store.p('SELECT * FROM memory_event WHERE kind = ? AND task_id = ? ORDER BY seq').all(kind, task_id);

test('notes_sink: a lever of three values, off by default, and it needs notes', () => {
  assert.strictEqual(L.DEFAULTS.notes_sink, 'off');
  assert.deepStrictEqual(L.TYPES.notes_sink, { type: 'enum', values: ['off', 'record', 'penalty'] });
  assert.strictEqual(L.parseMemoryBlock({ project: 'p', notes: true, notes_sink: 'record' }).value.notes_sink, 'record');
  assert.match(L.parseMemoryBlock({ project: 'p', notes: true, notes_sink: 'loud' }).error, /notes_sink must be one of off, record, penalty/);
  assert.match(L.parseMemoryBlock({ notes_sink: 'record' }).error, /notes_sink needs memory.notes/);
  assert.strictEqual(L.parseMemoryBlock({}).value.notes_sink, 'off');
});

test('memory_ids on a hand-back: recorded as notes_applied with the sink on, checked and not stored with it off', async () => {
  const a = note('applied claim');
  const t = await task(RUN, 'w1', { spec: 'job a', index: false });
  const out = await release(RUN, 'w1', t.lease_id, { memory_ids: [a, a] });
  assert.deepStrictEqual(out.memory_ids.ids, [a], 'duplicates collapse');
  assert.strictEqual(out.memory_ids.recorded, true);
  const ev = events('notes_applied', t.task_id);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].id, out.memory_ids.event_id);
  assert.deepStrictEqual(JSON.parse(ev[0].row_ids), [a]);

  const empty = await task(RUN, 'w2', { spec: 'job b', index: false });
  const none = await release(RUN, 'w2', empty.lease_id, { memory_ids: [] });
  assert.strictEqual(none.memory_ids.recorded, true, 'an empty array is a statement: none applied');
  assert.deepStrictEqual(JSON.parse(events('notes_applied', empty.task_id)[0].row_ids), []);

  const off = await task(OFF, 'woff', { spec: 'job c', index: false });
  const quiet = await release(OFF, 'woff', off.lease_id, { memory_ids: [a] });
  assert.strictEqual(quiet.memory_ids.recorded, false);
  assert.match(quiet.memory_ids.reason, /notes_sink is off/);
  assert.strictEqual(events('notes_applied', off.task_id).length, 0);
});

test('memory_ids: a malformed list is refused by name and the lease stays held', async () => {
  const t = await task(RUN, 'w1', { spec: 'job d', index: false });
  for (const bad of ['x', [1], ['not an id'], Array.from({ length: 51 }, (_, i) => `m-${i}`)]) {
    await assert.rejects(release(RUN, 'w1', t.lease_id, { memory_ids: bad }), (e) => e.code === 'E_ARGS' && /memory_ids/.test(e.message));
  }
  const ok = await release(RUN, 'w1', t.lease_id, { memory_ids: [] });
  assert.ok(ok.released_at !== undefined || ok.state === 'released', 'a retry after a refusal still releases');
});

test('recordChances: one note_chance per delivered note and route, with slot, size, opened, area and used', async () => {
  const hubA = note('alpha claim', { applies_to: ['src/alpha.cjs'], subjects: ['zebra'] });
  const hubB = note('beta claim', { applies_to: ['src/beta.cjs'] });
  const cold = note('cold claim', { applies_to: ['assets/cold.md'] });
  const t = await task(RUN, 'w1', { spec: 'fix the loader', owned: ['src/alpha.cjs'] });
  assert.ok(t.index.row_ids.length >= 3, 'the index lists the live notes');
  const slotOf = (id) => t.index.row_ids.indexOf(id) + 1;
  await release(RUN, 'w1', t.lease_id, { memory_ids: [hubA] });
  const out = await call(RUN, 'memory.recordChances', {
    task_id: t.task_id, worker_id: 'w1', changed_files: ['src\\beta.cjs'],
    shown: [{ route: 'search', ids: [cold, hubB, 'm-not-a-note'], at: 1000 }, { route: 'retrieve', ids: [hubB] }],
  });
  assert.strictEqual(out.already, false);
  const by = (id, route) => out.chances.find((c) => c.note_id === id && c.route === route);
  const a = by(hubA, 'index');
  assert.deepStrictEqual([a.slot, a.set_size, a.opened, a.area, a.area_by, a.used, a.applied_reported], [slotOf(hubA), t.index.row_ids.length, false, true, ['owned'], true, true]);
  const b = by(hubB, 'index');
  assert.deepStrictEqual([b.opened, b.area_by, b.used], [true, ['diff'], false], 'retrieved elsewhere in the task is opened; changed in the diff is area');
  const s = by(hubB, 'search');
  assert.deepStrictEqual([s.slot, s.set_size, s.delivered_at, s.opened], [2, 3, 1000, true]);
  const r = by(hubB, 'retrieve');
  assert.deepStrictEqual([r.slot, r.set_size, r.opened], [1, 1, true]);
  const c = by(cold, 'search');
  assert.deepStrictEqual([c.slot, c.area, c.used, c.opened], [1, false, false, false]);
  assert.ok(!out.chances.some((x) => x.note_id === 'm-not-a-note'), 'an id that is not a live note is not a chance');
  assert.strictEqual(out.chances.every((x) => x.task_id === t.task_id && x.run_id === RUN), true);
  assert.strictEqual(events('note_chance', t.task_id).length, out.chances.length, 'every returned fact is a stored row');
});

test('recordChances: a subject term in the task text is area, and an unreported hand-back is not "unused"', async () => {
  const z = note('zebra claim', { subjects: ['quokka'] });
  const t = await task(RUN, 'w2', { spec: 'the quokka cache is wrong' });
  const out = await call(RUN, 'memory.recordChances', { task_id: t.task_id });
  const c = out.chances.find((x) => x.note_id === z);
  assert.deepStrictEqual([c.area_by, c.used, c.applied_reported], [['term'], false, false]);
});

test('recordChances: the changed-file fact lists notes whose applies_to changed, once, and writes nothing without a match', async () => {
  const f = note('gamma claim', { applies_to: ['lib/gamma'] });
  const t = await task(RUN, 'w1', { spec: 'edit gamma', index: false });
  const out = await call(RUN, 'memory.recordChances', { task_id: t.task_id, changed_files: ['lib/gamma/x.cjs'] });
  assert.ok(out.changed.note_ids.includes(f));
  const ev = events('note_changed', t.task_id);
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual(JSON.parse(ev[0].row_ids), out.changed.note_ids);
  const none = await task(RUN, 'w2', { spec: 'nothing', index: false });
  const quiet = await call(RUN, 'memory.recordChances', { task_id: none.task_id, changed_files: ['unrelated/file.txt'] });
  assert.strictEqual(quiet.written, 0);
  assert.strictEqual(quiet.changed, null);
});

test('recordChances: once per task (a second call writes nothing), and refused with the sink off or for another run', async () => {
  const t = await task(RUN, 'w1', { spec: 'once' });
  const first = await call(RUN, 'memory.recordChances', { task_id: t.task_id });
  assert.ok(first.written > 0);
  const before = store.p('SELECT COUNT(*) AS n FROM memory_event').get().n;
  const again = await call(RUN, 'memory.recordChances', { task_id: t.task_id, shown: [{ route: 'search', ids: ['m-x'] }] });
  assert.strictEqual(again.already, true);
  assert.strictEqual(again.written, 0);
  assert.deepStrictEqual(again.chances.map((c) => c.id).sort(), first.chances.map((c) => c.id).sort());
  assert.strictEqual(store.p('SELECT COUNT(*) AS n FROM memory_event').get().n, before);

  const off = await task(OFF, 'woff', { spec: 'off task' });
  await assert.rejects(call(OFF, 'memory.recordChances', { task_id: off.task_id }), (e) => e.code === 'E_LEVER_OFF');
  assert.strictEqual(events('note_chance', off.task_id).length, 0, 'off writes nothing');
  await assert.rejects(call(OFF, 'memory.recordChances', { task_id: t.task_id }), (e) => e.code === 'E_ROLE');
  await assert.rejects(call(RUN, 'memory.recordChances', { task_id: 'nope' }), (e) => e.code === 'E_NOT_FOUND');
  await assert.rejects(call(RUN, 'memory.recordChances', { task_id: t.task_id, shown: [{ route: 'index', ids: [] }] }), (e) => e.code === 'E_ARGS');
});

test('penalty records exactly what record records', async () => {
  const t = await task(PEN, 'wpen', { spec: 'penalty task' });
  const out = await call(PEN, 'memory.recordChances', { task_id: t.task_id });
  assert.ok(out.written > 0);
  assert.strictEqual(out.chances[0].sink, 'penalty');
});

test('noteDeliveries: which tasks were shown a note, by route, before a time; a worker cannot ask', async () => {
  const n = note('delivered claim', { applies_to: ['src/delivered.cjs'] });
  const t1 = await task(RUN, 'w1', { spec: 'first' });
  await call(RUN, 'memory.recordChances', { task_id: t1.task_id, shown: [{ route: 'search', ids: [n], at: 5000 }] });
  const t2 = await task(RUN, 'w2', { spec: 'second', index: false });
  await call(RUN, 'memory.recordChances', { task_id: t2.task_id, shown: [{ route: 'retrieve', ids: [n], at: 9000 }] });
  const all = await call(RUN, 'memory.noteDeliveries', { note_id: n });
  const routes = all.deliveries.map((d) => `${d.task_id}:${d.route}`);
  assert.ok(routes.includes(`${t1.task_id}:index`) && routes.includes(`${t1.task_id}:search`) && routes.includes(`${t2.task_id}:retrieve`), routes.join(' '));
  const early = await call(RUN, 'memory.noteDeliveries', { note_id: n, before: 6000 });
  assert.deepStrictEqual(early.deliveries.filter((d) => d.route === 'search').map((d) => d.task_id), [t1.task_id]);
  assert.ok(!early.deliveries.some((d) => d.task_id === t2.task_id));
  assert.deepStrictEqual((await call(RUN, 'memory.noteDeliveries', { note_id: 'm-none' })).deliveries, []);
  await assert.rejects(E.handle('memory.noteDeliveries', { caller: worker('w1', RUN), note_id: n }), (e) => e.code === 'E_ROLE');
  await assert.rejects(call(RUN, 'memory.noteDeliveries', {}), (e) => e.code === 'E_ARGS');
});
