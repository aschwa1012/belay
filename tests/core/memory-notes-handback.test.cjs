'use strict';
// memory-notes-handback.test.cjs — ADR 0047 decisions 2 to 5 at the core: notes handed back on lease.release, the
// two-step write against near-duplicates, reported_wrong, and memory.noteResolve. A fake embedder gives the notes
// vectors we choose, so "close" and "distinct" are facts of the test, not of a model.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const RUN = 'r-notes', OFF = 'r-notes-off', HI = 'r-notes-hi';
const orch = callerFor('orchestrator', { run_id: RUN });
const orchOff = callerFor('orchestrator', { run_id: OFF });
const orchHi = callerFor('orchestrator', { run_id: HI });
const orchOf = run => (run === RUN ? orch : run === OFF ? orchOff : orchHi);
const worker = (id, run = RUN) => callerFor('worker', { run_id: run, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const bodyOf = id => JSON.parse(rowOf(id).body);
let seq = 0;

// Direction vectors by marker word in the text: the same marker is the same direction.
// K<n> is the n-th axis; K<n>x is the same axis tilted by 8 degrees (cosine 0.99), a near-duplicate of K<n>.
const DIM = 16;
const embed = async text => {
  const m = /\bK(\d+)(x?)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  if (!m) v[DIM - 1] = 1; else if (m[2]) { v[Number(m[1])] = 0.99; v[0] = 0.141; } else v[Number(m[1])] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};

const note = (marker, over = {}) => ({
  kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, basis: 'observed',
  evidence: [{ where: `src/${marker}.js`, saw: 'the unlisted file was never read' }], applies_to: [`src/${marker}.js`], subjects: [marker], ...over,
});

// A fresh task assigned to the worker; returns the lease id. The worker row carries the model the substrate reported.
async function lease(w, run = RUN) {
  const t = await call('task.create', orchOf(run), { spec: `job ${++seq}` });
  const a = await call('task.assign', orchOf(run), { task_id: t.id, worker_id: w.worker_id });
  return { lease_id: a.new_lease.id, task_id: t.id };
}
const hand = async (w, extra, run = RUN) => { const l = await lease(w, run); return { l, out: await call('lease.release', w, { lease_id: l.lease_id, ...extra }) }; };
const search = (q, ns = 'project/acme') => call('memory.search', orch, { query: q, namespace: ns, mode: 'keyword', view: 'index' });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, notes_reflection: true }) });
  await call('run.attach', orchOff, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme' }) });
  await call('run.attach', orchHi, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, notes_match_threshold: 0.999 }) });
  for (const [id, run] of [['w1', RUN], ['w2', RUN], ['w3', RUN], ['woff', OFF], ['wstrict', HI]]) {
    await call('worker.write', orchOf(run), { id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), model: 'claude-test-1' });
  }
});
after(() => { store.close(); cleanup(dir); });

test('lever off: a release is what it was, and a release that passes notes is refused by name', async () => {
  const w = worker('woff', OFF);
  const before = store.count();
  const { out } = await hand(w, { result: { summary: 'x' } }, OFF);
  assert.strictEqual(out.state, 'released');
  assert.ok(!('notes' in out) && !('reported_wrong' in out), 'no notes fields on the result');
  await assert.rejects(hand(w, { notes: [] }, OFF), e => e.code === 'E_LEVER_OFF');
  await assert.rejects(hand(w, { reported_wrong: [] }, OFF), e => e.code === 'E_LEVER_OFF');
  await assert.rejects(call('memory.noteResolve', worker('woff', OFF), { resolutions: [{ id: 'x', resolve: 'new' }] }), e => e.code === 'E_LEVER_OFF');
  assert.strictEqual(store.count(), before, 'no row was written');
});

test('lever on: notes is required, [] is valid and writes nothing', async () => {
  const w = worker('w1');
  const l = await lease(w);
  const before = store.count();
  await assert.rejects(call('lease.release', w, { lease_id: l.lease_id }), e => e.code === 'E_ARGS' && /notes is required/.test(e.message));
  assert.strictEqual((await call('task.get', orch, { task_id: l.task_id })).state, 'assigned', 'a refused release leaves the lease held');
  const out = await call('lease.release', w, { lease_id: l.lease_id, notes: [] });
  assert.strictEqual(out.state, 'released');
  assert.deepStrictEqual([out.notes, out.reported_wrong, out.pending], [[], [], 0]);
  assert.strictEqual(store.count(), before);
});

test('a note is stored as a typed row in the project, with the writer and model from belay, not from the note', async () => {
  const w = worker('w1');
  const { l, out } = await hand(w, { notes: [note('K1')] });
  assert.strictEqual(out.state, 'released');
  assert.strictEqual(out.notes.length, 1);
  const n = out.notes[0];
  assert.deepStrictEqual([n.state, n.namespace, n.action], ['stored', 'project/acme', 'inserted']);
  const r = rowOf(n.id);
  assert.deepStrictEqual([r.type, r.namespace, r.written_by, r.worker_id, r.run_id, r.task_id, r.source], ['note', 'project/acme', 'worker:w1', 'w1', RUN, l.task_id, 'model']);
  assert.strictEqual(r.title, 'the K1 loader skips unlisted fixtures');
  const b = bodyOf(n.id);
  assert.deepStrictEqual([b.kind, b.basis, b.model, b.state, b.seen_total], ['lesson', 'observed', 'claude-test-1', 'live', 0]);
  assert.deepStrictEqual(b.evidence, [{ where: 'src/K1.js', saw: 'the unlisted file was never read' }]);
  assert.ok(r.embedding, 'the note is embedded');
  assert.ok((await search('K1 loader')).results.some(x => x.id === n.id), 'a live note is found in the project');
  await assert.rejects(hand(w, { notes: [note('K2', { model: 'opus' })] }), e => e.code === 'E_NOTE_SHAPE', 'a note cannot state its own model');
});

test('a refused note writes nothing and leaves the lease held, so a corrected call succeeds', async () => {
  const w = worker('w2');
  const l = await lease(w);
  const before = store.count();
  for (const bad of [note('K4', { title: 'x'.repeat(161) }), note('K4', { basis: undefined }), note('K4', { evidence: [] })]) {
    await assert.rejects(call('lease.release', w, { lease_id: l.lease_id, notes: [note('K4'), bad] }), e => e.code === 'E_NOTE_SHAPE');
  }
  assert.strictEqual(store.count(), before, 'not even the good note of the same call was written');
  assert.strictEqual((await call('task.get', orch, { task_id: l.task_id })).state, 'assigned');
  const ok = await call('lease.release', w, { lease_id: l.lease_id, notes: [note('K4')] });
  assert.strictEqual(ok.notes[0].state, 'stored', JSON.stringify(ok.notes[0]));
});

test('a close match makes the note pending: the lease is released, the matches come back with ids, and the index and search do not see it', async () => {
  const w = worker('w1');
  const first = (await hand(w, { notes: [note('K5')] })).out.notes[0];
  assert.strictEqual(first.state, 'stored');
  const { l, out } = await hand(w, { notes: [note('K5x', { title: 'the K5x loader ignores unlisted fixtures' })] });
  assert.strictEqual(out.state, 'released', 'a match never refuses the release');
  assert.strictEqual(out.pending, 1);
  const p = out.notes[0];
  assert.deepStrictEqual([p.state, p.namespace], ['pending', 'pending/acme']);
  assert.strictEqual(p.matches.length, 1);
  assert.deepStrictEqual([p.matches[0].id, p.matches[0].kind, p.matches[0].basis], [first.id, 'lesson', 'observed']);
  assert.ok(p.matches[0].similarity >= 0.8 && p.matches[0].similarity <= 1);
  assert.match(out.next, /memory_note_resolve/);
  assert.strictEqual(rowOf(p.id).namespace, 'pending/acme');
  assert.strictEqual(bodyOf(p.id).state, 'pending');
  assert.ok(!(await search('K5x loader ignores')).results.some(x => x.id === p.id), 'not in search');
  const idx = await call('memory.index', orch, { task_id: l.task_id, max_bytes: 4000 });
  assert.ok(!idx.row_ids.includes(p.id), 'not in the index');
});

test('a distinct note is stored; a close one is not matched under a stricter threshold lever', async () => {
  const w = worker('w3');
  const far = (await hand(w, { notes: [note('K14', { title: 'the K14 service retries twice' })] })).out;
  assert.strictEqual(far.notes[0].state, 'stored', 'orthogonal to everything stored');
  const strict = worker('wstrict', 'r-notes-hi');
  const first = (await hand(strict, { notes: [note('K15')] }, 'r-notes-hi')).out;
  const near = (await hand(strict, { notes: [note('K15x', { title: 'the K15x loader ignores unlisted fixtures' })] }, 'r-notes-hi')).out;
  assert.deepStrictEqual([first.notes[0].state, near.notes[0].state], ['stored', 'stored'], 'cosine 0.99 is under a 0.999 threshold');
});

test('resolve new moves the pending note into the project; it cannot be resolved twice', async () => {
  const w = worker('w1');
  const m = (await hand(w, { notes: [note('K5x', { title: 'the K5x cache is cold after a restart' })] })).out.notes[0];
  assert.strictEqual(m.state, 'pending');
  const r = await call('memory.noteResolve', w, { resolutions: [{ id: m.id, resolve: 'new' }] });
  assert.deepStrictEqual([r.resolved[0].resolved, r.resolved[0].state, r.resolved[0].namespace], ['new', 'live', 'project/acme']);
  assert.strictEqual(rowOf(m.id).namespace, 'project/acme');
  assert.strictEqual(bodyOf(m.id).state, 'live');
  assert.ok((await search('cache is cold after')).results.some(x => x.id === m.id));
  await assert.rejects(call('memory.noteResolve', w, { resolutions: [{ id: m.id, resolve: 'new' }] }), e => e.code === 'E_NOT_FOUND' && /not pending/.test(e.message));
});

test('resolve repeats records a sighting on the live note, adds no row, and counts never change the ranking', async () => {
  const w = worker('w2');
  const live = (await hand(w, { notes: [note('K7', { title: 'the K7 queue drops jobs past 100 entries' })] })).out.notes[0];
  const before = await call('memory.search', orch, { query: 'K7 queue drops jobs', namespace: 'project/acme', mode: 'hybrid', view: 'index' });
  const dup = (await hand(w, { notes: [note('K7', { title: 'K7 queue silently drops jobs over 100' })] })).out.notes[0];
  assert.strictEqual(dup.state, 'pending');
  const rowsBefore = store.count();
  const r = await call('memory.noteResolve', w, { resolutions: [{ id: dup.id, resolve: 'repeats', of: live.id }] });
  assert.deepStrictEqual([r.resolved[0].resolved, r.resolved[0].of, r.resolved[0].pending_row_archived], ['repeats', live.id, true]);
  assert.strictEqual(store.count(), rowsBefore, 'nothing is deleted: the pending row moves to the archive; no new row');
  assert.strictEqual(rowOf(dup.id).namespace, 'archive/acme');
  assert.strictEqual(bodyOf(dup.id).archived.of, live.id);
  const b = bodyOf(live.id);
  assert.strictEqual(b.seen_total, 1);
  assert.deepStrictEqual([b.seen_in[0].written_by, b.seen_in[0].run_id, b.seen_in[0].in_index_beforehand], ['worker:w2', RUN, null], 'no index receipts for this worker, so nothing says');
  const after = await call('memory.search', orch, { query: 'K7 queue drops jobs', namespace: 'project/acme', mode: 'hybrid', view: 'index' });
  assert.deepStrictEqual(after.results.map(x => [x.id, x.score]), before.results.map(x => [x.id, x.score]), 'a sighting changes no rank and no score');
});

test('a sighting says whether belay had delivered the note to the writer, from its own index receipts', async () => {
  const w = worker('w3');
  const live = (await hand(w, { notes: [note('K8', { title: 'the K8 gateway rejects bodies over 1 MB' })] })).out.notes[0];
  // belay put this note in front of w3 (an index receipt), then w3 wrote a close note
  await call('memory.recordEvent', orch, { kind: 'index_injected', worker_id: 'w3', row_ids: [live.id], bytes: 10, sha256: 'x' });
  const dup = (await hand(w, { notes: [note('K8', { title: 'K8 gateway 1 MB body limit' })] })).out.notes[0];
  await call('memory.noteResolve', w, { resolutions: [{ id: dup.id, resolve: 'repeats', of: live.id }] });
  assert.strictEqual(bodyOf(live.id).seen_in[0].in_index_beforehand, true);
  // a receipt that names other rows only: delivered nothing relevant
  await call('memory.recordEvent', orch, { kind: 'index_injected', worker_id: 'w2', row_ids: ['someone-else'], bytes: 10, sha256: 'x' });
  const w2 = worker('w2');
  const dup2 = (await hand(w2, { notes: [note('K8', { title: 'K8 gateway limit is 1 MB per body' })] })).out.notes[0];
  await call('memory.noteResolve', w2, { resolutions: [{ id: dup2.id, resolve: 'repeats', of: live.id }] });
  assert.strictEqual(bodyOf(live.id).seen_in[1].in_index_beforehand, false);
  assert.strictEqual(bodyOf(live.id).seen_total, 2);
});

test('resolve supersedes needs evidence, stores the note, and hides the one it replaces', async () => {
  const w = worker('w1');
  const old = (await hand(w, { notes: [note('K9', { title: 'the K9 importer reads only csv files' })] })).out.notes[0];
  const nw = (await hand(w, { notes: [note('K9', { title: 'the K9 importer reads csv and tsv files' })] })).out.notes[0];
  assert.strictEqual(nw.state, 'pending');
  await assert.rejects(call('memory.noteResolve', w, { resolutions: [{ id: nw.id, resolve: 'supersedes', of: old.id }] }), e => e.code === 'E_ARGS' && /evidence/.test(e.message));
  assert.strictEqual(rowOf(nw.id).namespace, 'pending/acme', 'a refused resolution changes nothing');
  const ev = [{ where: 'src/import.js:40', saw: 'a .tsv fixture was imported' }];
  const r = await call('memory.noteResolve', w, { resolutions: [{ id: nw.id, resolve: 'supersedes', of: old.id, evidence: ev }] });
  assert.strictEqual(r.resolved[0].resolved, 'supersedes');
  assert.strictEqual(rowOf(nw.id).supersedes, old.id);
  assert.strictEqual(bodyOf(old.id).superseded_by, nw.id);
  const ids = (await search('K9 importer reads')).results.map(x => x.id);
  assert.ok(ids.includes(nw.id) && !ids.includes(old.id), 'the old note leaves the search; the new one is in it');
  assert.ok(rowOf(old.id), 'the old note is kept');
});

test('a worker resolves only its own pending notes; a repeat of a note that is not live is refused', async () => {
  const w1 = worker('w1');
  const live = (await hand(w1, { notes: [note('K10', { title: 'K10 exports are sorted by id' })] })).out.notes[0];
  const dup = (await hand(w1, { notes: [note('K10', { title: 'exports of K10 come out sorted by id' })] })).out.notes[0];
  assert.strictEqual(dup.state, 'pending');
  await assert.rejects(call('memory.noteResolve', worker('w2'), { resolutions: [{ id: dup.id, resolve: 'new' }] }), e => e.code === 'E_ROLE');
  await assert.rejects(call('memory.noteResolve', w1, { resolutions: [{ id: dup.id, resolve: 'repeats', of: 'no-such-note' }] }), e => e.code === 'E_ARGS' && /not one of the matches/.test(e.message));
  await assert.rejects(call('memory.noteResolve', w1, { resolutions: [{ id: dup.id, resolve: 'repeats', of: dup.id }] }), e => e.code === 'E_ARGS');
  // the orchestrator may settle it
  const r = await call('memory.noteResolve', orch, { resolutions: [{ id: dup.id, resolve: 'repeats', of: live.id }] });
  assert.strictEqual(r.resolved[0].resolved, 'repeats');
  const open = store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'note' AND namespace = 'pending/acme'").get().n;
  assert.ok(open > 0, 'other writers still have pending notes');
  assert.strictEqual(r.still_pending, open, 'the orchestrator sees every pending note of the project');
});

test('reported_wrong marks the note reported_wrong at once, resolves notes[i] to the new note, and skips an id that is not live', async () => {
  const w = worker('w2');
  const target = (await hand(w, { notes: [note('K11', { title: 'the K11 scheduler runs hourly' })] })).out.notes[0];
  const w3 = worker('w3');
  const { out } = await hand(w3, {
    notes: [note('K12', { title: 'the K12 scheduler runs every five minutes' })],
    reported_wrong: [{ id: target.id, why: 'saw it fire every five minutes', replaced_by: 'notes[0]' }],
  });
  assert.strictEqual(out.reported_wrong[0].marked, 'reported_wrong');
  assert.strictEqual(out.reported_wrong[0].replaced_by, out.notes[0].id);
  const b = bodyOf(target.id);
  assert.strictEqual(b.reported_wrong.length, 1);
  assert.deepStrictEqual([b.reported_wrong[0].why, b.reported_wrong[0].by, b.reported_wrong[0].run_id, b.reported_wrong[0].replaced_by], ['saw it fire every five minutes', 'worker:w3', RUN, out.notes[0].id]);
  assert.strictEqual(rowOf(target.id).namespace, 'project/acme', 'a report is not a retirement: the note stays');
  const skip = await lease(w3);
  const skipped = await call('lease.release', w3, { lease_id: skip.lease_id, notes: [], reported_wrong: [{ id: 'nope', why: 'x' }] });
  assert.deepStrictEqual(skipped.reported_wrong, [{ id: 'nope', skipped: 'not_live', state: 'missing' }], 'an id that is not live is skipped and returned, and the release goes on');
  const l = await lease(w3);
  await assert.rejects(call('lease.release', w3, { lease_id: l.lease_id, notes: [], reported_wrong: [{ id: target.id, why: 'x', replaced_by: 'notes[3]' }] }), e => e.code === 'E_ARGS');
  assert.strictEqual(bodyOf(target.id).reported_wrong.length, 1, 'a refused call marks nothing');
});

test('a second call on a released lease adds notes and leaves the release as it was written (the reflection turn)', async () => {
  const w = worker('w1');
  const { l, out } = await hand(w, { result: { summary: 'first' }, notes: [] });
  const rows = () => store.p('SELECT COUNT(*) AS n FROM lease WHERE id = ?').get(l.lease_id).n;
  const taskRows = () => store.p('SELECT COUNT(*) AS n FROM task WHERE id = ?').get(l.task_id).n;
  const [a, b] = [rows(), taskRows()];
  const again = await call('lease.release', w, { lease_id: l.lease_id, notes: [note('K13', { title: 'the K13 bus drops the first message after a reconnect' })] });
  assert.strictEqual(again.notes[0].state, 'stored');
  assert.deepStrictEqual([rows(), taskRows()], [a, b], 'no new lease or task row');
  assert.deepStrictEqual(again.handoff, out.handoff);
  await assert.rejects(call('lease.release', w, { lease_id: l.lease_id, result: { summary: 'second' }, notes: [] }), e => e.code === 'E_ARGS');
});

test('an operator release cannot carry notes', async () => {
  await assert.rejects(call('lease.release', callerFor('operator', { run_id: RUN }), { lease_id: 'x', notes: [] }), e => e.code === 'E_ARGS');
});

test('the ledger accepts the reflection receipt kind', async () => {
  const ev = await call('memory.recordEvent', orch, { kind: 'reflection', worker_id: 'w1', task_id: 't', key: 'task:t', ok: true, message: 'asked again' });
  assert.strictEqual(ev.kind, 'reflection');
});

// ---- review fixes ---------------------------------------------------------------------------------------------

test('B2: memory.store cannot write a note or a note\'s fields, for any caller', async () => {
  for (const caller of [orch, worker('w1'), callerFor('operator', { run_id: RUN })]) {
    await assert.rejects(call('memory.store', caller, { namespace: caller.role === 'worker' ? `run/${RUN}` : 'project/acme', type: 'note', text: 'a forged note K20' }), e => e.code === 'E_ARGS' && /reserved/.test(e.message), caller.role);
  }
  for (const k of ['model', 'state', 'seen_in', 'seen_total', 'matches', 'reported_wrong']) {
    await assert.rejects(call('memory.store', orch, { namespace: 'project/acme', type: 'fact', text: `a fact with a forged ${k} K21`, body: { [k]: 'x' } }), e => e.code === 'E_ARGS' && new RegExp(k).test(e.message), k);
  }
  const ok = await call('memory.store', orch, { namespace: 'project/acme', type: 'fact', text: 'an ordinary fact with a body K22', body: { v: 1 }, embed: false });
  assert.ok(ok.id);
});
