'use strict';
// memory-held-withhold-reads.test.cjs — the rest of the withholding (ADR 0047 amendment, 2026-10-22): a read by explicit id answers honestly
// that a held note exists and is withheld (a task reviewer whose brief lists its report still gets it); a hand-back that restates a held
// claim waits in pending with the hold named, so it never re-adds the claim beside the hold; and the filter costs a bounded multiple of a
// read with no holds. Same fake embedder as memory-k2-writes.test.cjs.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { withTeardown } = require('../helpers/teardown.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const rows = core('rows.cjs');
const G = core('memory-note-gate.cjs');

let dir, store, E;
const RUN = 'r-hw';
const WARN = 'r-hw-warn';
const orch = callerFor('orchestrator', { run_id: RUN });
const worker = (id, run = RUN) => callerFor('worker', { run_id: run, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
let seq = 0;

const DIM = 16;
const embed = async (text) => {
  const m = /\bK(\d+)(x?)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  if (!m) v[DIM - 1] = 1; else if (m[2]) { v[Number(m[1])] = 0.99; v[0] = 0.141; } else v[Number(m[1])] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};
const note = (marker, over = {}) => ({
  kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `add a ${marker} test fixture`, basis: 'observed',
  evidence: [{ where: `src/${marker}.js`, saw: 'the unlisted file was never read' }], applies_to: [`src/${marker}.js`], subjects: [marker], ...over,
});
async function lease(w) {
  const t = await call('task.create', orch, { spec: `job ${++seq}` });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: w.worker_id });
  return { lease_id: a.new_lease.id, task_id: t.id };
}
const hand = async (w, extra) => { const l = await lease(w); return { l, out: await call('lease.release', w, { lease_id: l.lease_id, ...extra }) }; };
const holdOn = (noteId, project = 'acme', over = {}) => store.storeIn({ namespace: `held/${project}`, worker_id: 'harness', type: 'held', text: `held ${noteId}`, title: 'h', body: { state: 'held', note_id: noteId, kind: 'wrong', ground: 'reported', reports: [{ key: `k${++seq}`, by: 'orchestrator', why: 'x', at: 1 }], rev: 1, ...over }, run_id: 'gone', source: 'harness', written_by: 'harness' }).id;

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  await call('run.attach', callerFor('orchestrator', { run_id: WARN }), { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, held_visibility: 'warn' }) });
  for (const id of ['w1', 'w2', 'w3', 'rev1']) await call('worker.write', orch, { id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), model: 'claude-test-1' });
});
after(() => withTeardown(() => {}, [() => store.close(), () => cleanup(dir)]));

// ---- explicit-id reads ----------------------------------------------------------------------------------------------------

test('get and get_many answer that a held note exists and is withheld; the orchestrator, warn mode and the operator get it', async () => {
  const kept = (await hand(worker('w1'), { notes: [note('K1')] })).out.notes[0];
  const held = (await hand(worker('w1'), { notes: [note('K2')] })).out.notes[0];
  holdOn(held.id);
  const one = await call('memory.get', worker('w2'), { id: held.id });
  assert.deepStrictEqual([one.found, one.withheld], [false, true]);
  assert.match(one.note, /held for review/);
  assert.strictEqual(one.text, undefined, 'none of the note leaks');
  const many = await call('memory.get', worker('w2'), { ids: [kept.id, held.id, 'no-such-id'] });
  assert.deepStrictEqual(many.rows.map((r) => [r.id === held.id ? 'held' : r.id === kept.id ? 'kept' : 'none', r.found, r.withheld === true]), [['kept', true, false], ['held', false, true], ['none', false, false]]);
  assert.deepStrictEqual(many.withheld, [held.id]);
  assert.strictEqual((await call('memory.get', orch, { id: held.id })).found, true);
  assert.strictEqual((await call('memory.get', callerFor('operator'), { id: held.id })).found, true);
  assert.strictEqual((await call('memory.get', worker('w2', WARN), { id: held.id })).found, true);
  assert.strictEqual((await call('memory.get', worker('knowledge-1'), { id: held.id })).found, true, 'the knowledge agent answers the orchestrator');
});

test('a task reviewer whose brief lists the note\'s report still gets it; another worker does not', async () => {
  const writer = (await hand(worker('w1'), { notes: [note('K3')] })).out.notes[0];
  const repTask = (await call('task.create', orch, { spec: 'the reporting task' })).id;
  const id = writer.id;
  store.patchBody(id, (b) => { b.reported_wrong = [{ task_id: repTask, by: 'worker:w3', worker_id: 'w3', why: 'wrong', at: 5, seq: 1 }]; return b; });
  holdOn(id, 'acme', { reports: [{ key: 'kr', seq: 1, by: 'worker:w3', worker_id: 'w3', task_id: repTask, why: 'wrong', at: 5 }] });
  const rt = (await call('task.create', orch, { spec: 'review', depends_on: [repTask], acceptance: { verdict: true } })).id;
  rows.append(store, 'lease', { id: `l-${rt}`, task_id: rt, run_id: RUN, holder: 'rev1', holder_role: 'worker', granted_at: Date.now(), expires_at: Date.now() + 1e6, released_at: null }, 'rev1'); // the reviewer holds the review task
  const reviewer = await call('memory.get', worker('rev1'), { id });
  assert.strictEqual(reviewer.found, true, 'the reviewer must judge it');
  assert.strictEqual((await call('memory.get', worker('w2'), { id })).withheld, true);
  assert.strictEqual((await call('memory.get', worker('w3'), { id })).withheld, true, 'the reporter is not the reviewer');
});

test('a reviewer of another run (the same worker id) does not get the note', async () => {
  const writer = (await hand(worker('w1'), { notes: [note('K7')] })).out.notes[0];
  const repTask = (await call('task.create', orch, { spec: 'the reporting task' })).id;
  store.patchBody(writer.id, (b) => { b.reported_wrong = [{ task_id: repTask, by: 'worker:w3', worker_id: 'w3', why: 'wrong', at: 5, seq: 1 }]; return b; });
  holdOn(writer.id, 'acme', { reports: [{ key: 'kx', seq: 1, by: 'worker:w3', worker_id: 'w3', task_id: repTask, why: 'wrong', at: 5 }] });
  const rt = (await call('task.create', orch, { spec: 'review', depends_on: [repTask], acceptance: { verdict: true } })).id;
  rows.append(store, 'lease', { id: `l2-${rt}`, task_id: rt, run_id: RUN, holder: 'rev1', holder_role: 'worker', granted_at: Date.now(), expires_at: Date.now() + 1e6, released_at: null }, 'rev1');
  await call('run.attach', callerFor('orchestrator', { run_id: 'r-other' }), { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  assert.strictEqual((await call('memory.get', worker('rev1'), { id: writer.id })).found, true, 'its own run: the reviewer');
  assert.strictEqual((await call('memory.get', worker('rev1', 'r-other'), { id: writer.id })).withheld, true, 'the same worker id in another run is nobody');
});

// ---- a restated claim ----------------------------------------------------------------------------------------------------

test('a hand-back that restates a held note waits in pending with the hold named; a different note is stored; warn matches it as before', async () => {
  const first = (await hand(worker('w1'), { notes: [note('K4')] })).out.notes[0];
  const hold = holdOn(first.id);
  const again = (await hand(worker('w2'), { notes: [note('K4x', { title: 'the K4x loader ignores unlisted fixtures' })] })).out.notes[0];
  assert.deepStrictEqual([again.state, again.namespace], ['pending', 'pending/acme'], 'the claim is not re-added live beside its hold');
  assert.deepStrictEqual(again.matches.map((m) => m.id), [first.id], 'matching sees the held note: it decides duplicates and delivers nothing');
  assert.deepStrictEqual(again.prior_verdicts.map((v) => [v.id, v.verdict]), [[first.id, 'held_for_review']]);
  assert.match(again.held_back, /held for review/);
  const other = (await hand(worker('w2'), { notes: [note('K5', { title: 'the K5 service retries twice' })] })).out.notes[0];
  assert.strictEqual(other.state, 'stored', 'a genuinely different note is untouched');
  assert.strictEqual(other.prior_verdicts, undefined);
  for (const resolve of ['repeats', 'supersedes']) {
    await assert.rejects(() => call('memory.noteResolve', worker('w2'), { resolutions: [{ id: again.id, resolve, of: first.id, ...(resolve === 'supersedes' ? { evidence: [{ where: 'src/K4.js', saw: 'x' }] } : {}) }] }), /held for review|held for the archive review/); // a supersedes meets the hold guard (E_HELD) first
  }
  assert.strictEqual(rowOf(again.id).namespace, 'pending/acme', 'a refused resolution leaves the note pending');
  assert.deepStrictEqual(again.prior_verdicts.map((v) => v.id), [first.id], 'the hold stays named');
  const r = await call('memory.noteResolve', worker('w2'), { resolutions: [{ id: again.id, resolve: 'new' }] });
  assert.strictEqual(r.resolved[0].state, 'live', 'the writer resolves it knowing the hold');
  // warn: the held note is visible, so matching finds it as any live note
  store.patchBody(hold, (b) => { b.state = 'released'; return b; });
  const held2 = (await hand(worker('w1'), { notes: [note('K6')] })).out.notes[0];
  holdOn(held2.id);
  const l = await lease(worker('w2'));
  const w = (await call('lease.release', worker('w2', WARN), { lease_id: l.lease_id, notes: [note('K6x', { title: 'the K6x loader ignores unlisted fixtures' })] })).notes[0];
  assert.deepStrictEqual([w.state, (w.matches || []).map((m) => m.id)], ['pending', [held2.id]]);
});

// ---- cost -----------------------------------------------------------------------------------------------------------------

test('the filter costs a bounded ratio of a read with no holds on a seeded 10k-note store', async () => {
  const project = 'big';
  const ins = store.db.prepare("INSERT INTO memory_entries (id, namespace, worker_id, type, text, text_hash, title, body, embedding_model, embedding_revision, dim, run_id, source, written_by, created_at, updated_at, status) VALUES (?, ?, 'w1', 'note', ?, ?, ?, ?, 'm', 'r', 3, 'gone-run', 'model', 'worker:w1', ?, ?, 'unverified')");
  const ids = [];
  store.db.exec('BEGIN');
  try {
    for (let i = 0; i < 10000; i++) {
      const id = `bigfx-${String(i).padStart(5, '0')}`;
      ids.push(id);
      ins.run(id, `project/${project}`, `note ${i} costcase`, `hash${i}`, `note ${i}`, JSON.stringify({ kind: 'lesson', state: 'live', evidence: [], applies_to: [], subjects: [], reported_wrong: [] }), 1000 + i, 1000 + i);
    }
    store.db.exec('COMMIT');
  } catch (e) { store.db.exec('ROLLBACK'); throw e; }
  await call('run.attach', callerFor('orchestrator', { run_id: 'r-big' }), { adapter_pid: process.pid, project, memory_levers: JSON.stringify({ project, notes: true }) });
  const w = worker('w-big', 'r-big');
  const median = (f) => { const t = []; for (let i = 0; i < 9; i++) { const s = process.hrtime.bigint(); f(); t.push(Number(process.hrtime.bigint() - s) / 1e6); } return t.sort((a, b) => a - b)[4]; };
  const gate = () => G.hiddenIds(E, w, { namespaces: [`project/${project}`] });
  const base = median(gate);
  for (let i = 0; i < 50; i++) holdOn(ids[i * 7], project);
  assert.strictEqual(gate().length, 50, 'the 50 holds withhold their notes');
  const withHolds = median(gate);
  assert.ok(withHolds <= Math.max(base * 4, base + 15), `the gate with 50 holds took ${withHolds.toFixed(1)} ms against ${base.toFixed(1)} ms with none`);
  // the plan starts from the held rows: no per-note correlated lookup
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT json_extract(h.body, '$.note_id') AS nid FROM memory_entries h WHERE h.type = 'held' AND h.namespace >= 'held/' AND h.namespace < 'held0' AND h.written_by = 'harness'").all().map((r) => r.detail).join(' | ');
  assert.doesNotMatch(plan, /CORRELATED/);
  const rowsBefore = store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  gate();
  assert.strictEqual(store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n, rowsBefore, 'a read writes nothing');
});
