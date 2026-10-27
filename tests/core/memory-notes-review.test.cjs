'use strict';
// memory-notes-review.test.cjs — the review findings on the notes core (ADR 0047): resolution is bounded to the
// matches belay returned, a note cannot be forged or overwritten, a rollback leaves no phantom, a duplicate is
// never reported as written, and the second call after a release is bounded. Same fake embedder as the hand-back test.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const NT = core('memory-notes.cjs');

let dir, store, E;
const RUN = 'r-rev', HI = 'r-rev-hi';
const orch = callerFor('orchestrator', { run_id: RUN });
const orchHi = callerFor('orchestrator', { run_id: HI });
const worker = (id, run = RUN) => callerFor('worker', { run_id: run, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const bodyOf = id => JSON.parse(rowOf(id).body);
let seq = 0;

// K<n> is the n-th axis; K<n>x is the same axis tilted (cosine 0.99), a near-duplicate of K<n>.
const DIM = 64;
const embed = async text => {
  const m = /\bK(\d+)(x?)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  if (!m) v[DIM - 1] = 1; else if (m[2]) { v[Number(m[1])] = 0.99; v[0] = 0.141; } else v[Number(m[1])] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};
const note = (marker, over = {}) => ({
  kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `add a ${marker} test fixture`, basis: 'observed',
  evidence: [{ where: `src/${marker}.js`, saw: 'the unlisted file was never read' }], applies_to: [`src/${marker}.js`], subjects: [marker], ...over,
});
const textOf = n => NT.noteText(NT.checkNote(n));
const orchOf = run => (run === RUN ? orch : orchHi);
async function lease(w, run = RUN) {
  const t = await call('task.create', orchOf(run), { spec: `job ${++seq}` });
  const a = await call('task.assign', orchOf(run), { task_id: t.id, worker_id: w.worker_id });
  return { lease_id: a.new_lease.id, task_id: t.id };
}
const hand = async (w, extra, run = RUN) => { const l = await lease(w, run); return { l, out: await call('lease.release', w, { lease_id: l.lease_id, ...extra }) }; };
const resolve = (caller, resolutions) => call('memory.noteResolve', caller, { resolutions });
const pause = ms => new Promise(r => setTimeout(r, ms));
const EV = [{ where: 'x.js', saw: 'y' }];

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, notes_reflection: true }) });
  await call('run.attach', orchHi, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  for (const [id, run] of [['w1', RUN], ['w2', RUN], ['w3', RUN], ['whi', HI]]) {
    await call('worker.write', orchOf(run), { id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), model: 'claude-test-1' });
  }
});
after(() => { store.close(); cleanup(dir); });

test('B1: a note is resolved only against the notes it was matched with', async () => {
  const w1 = worker('w1'), w2 = worker('w2');
  const live = (await hand(w1, { notes: [note('K30')] })).out.notes[0];
  const other = (await hand(w1, { notes: [note('K31')] })).out.notes[0];
  const p = (await hand(w2, { notes: [note('K30x', { title: 'K30x variant of the loader claim' })] })).out.notes[0];
  assert.deepStrictEqual(p.matches.map(m => m.id), [live.id]);
  await assert.rejects(resolve(w2, [{ id: p.id, resolve: 'supersedes', of: other.id, evidence: EV }]), e => e.code === 'E_ARGS' && /not one of the matches/.test(e.message));
  await assert.rejects(resolve(w2, [{ id: p.id, resolve: 'repeats', of: other.id }]), e => e.code === 'E_ARGS' && /not one of the matches/.test(e.message));
  assert.strictEqual(rowOf(other.id).namespace, 'project/acme');
  assert.strictEqual(bodyOf(other.id).superseded_by, undefined, 'the unrelated note is untouched');
  assert.strictEqual(rowOf(p.id).namespace, 'pending/acme', 'a refusal changes nothing');
});

test('B1: a target already superseded is refused naming its replacement, and superseded_by is not overwritten', async () => {
  const w1 = worker('w1'), w2 = worker('w2');
  const a = (await hand(w1, { notes: [note('K32')] })).out.notes[0];
  const p1 = (await hand(w2, { notes: [note('K32x', { title: 'K32x first correction' })] })).out.notes[0];
  const p2 = (await hand(w2, { notes: [note('K32x', { title: 'K32x second correction' })] })).out.notes[0];
  assert.deepStrictEqual([p1.matches[0].id, p2.matches[0].id], [a.id, a.id]);
  await resolve(w2, [{ id: p1.id, resolve: 'supersedes', of: a.id, evidence: EV }]);
  await assert.rejects(resolve(w2, [{ id: p2.id, resolve: 'supersedes', of: a.id, evidence: EV }]), e => e.code === 'E_ARGS' && e.message.includes(p1.id));
  await assert.rejects(resolve(w2, [{ id: p2.id, resolve: 'repeats', of: a.id }]), e => e.code === 'E_ARGS' && e.message.includes(`superseded by ${p1.id}`));
  assert.strictEqual(bodyOf(a.id).superseded_by, p1.id);
  const b = (await hand(w1, { notes: [note('K38')] })).out.notes[0];
  const q1 = (await hand(w2, { notes: [note('K38x', { title: 'K38x one' })] })).out.notes[0];
  const q2 = (await hand(w2, { notes: [note('K38x', { title: 'K38x two' })] })).out.notes[0];
  await assert.rejects(resolve(w2, [{ id: q1.id, resolve: 'supersedes', of: b.id, evidence: EV }, { id: q2.id, resolve: 'supersedes', of: b.id, evidence: EV }]), e => e.code === 'E_ARGS');
  assert.strictEqual(rowOf(q1.id).namespace, 'pending/acme', 'all or none, even inside one call');
  assert.strictEqual(bodyOf(b.id).superseded_by, undefined);
});

test('B1: a refuted target is refused; a worker may repeat a verified note but not supersede it', async () => {
  const w1 = worker('w1'), w2 = worker('w2');
  const bad = (await hand(w1, { notes: [note('K39')] })).out.notes[0];
  const pr = (await hand(w2, { notes: [note('K39x', { title: 'K39x claim' })] })).out.notes[0];
  store.setStatus(bad.id, { status: 'refuted', receipt: 'commit:abcdef1', by: 'orchestrator', at: Date.now() });
  await assert.rejects(resolve(w2, [{ id: pr.id, resolve: 'repeats', of: bad.id }]), e => e.code === 'E_ARGS' && /refuted/.test(e.message));
  const v = (await hand(w1, { notes: [note('K33')] })).out.notes[0];
  const pv = (await hand(w2, { notes: [note('K33x', { title: 'K33x claim' })] })).out.notes[0];
  store.setStatus(v.id, { status: 'verified', receipt: 'commit:abcdef1', by: 'orchestrator', at: Date.now() });
  await assert.rejects(resolve(w2, [{ id: pv.id, resolve: 'supersedes', of: v.id, evidence: EV }]), e => e.code === 'E_ROLE' && /verified/.test(e.message));
  assert.strictEqual((await resolve(w2, [{ id: pv.id, resolve: 'repeats', of: v.id }])).resolved[0].resolved, 'repeats');
  const pv2 = (await hand(w2, { notes: [note('K33x', { title: 'K33x claim again' })] })).out.notes[0];
  assert.strictEqual((await resolve(orch, [{ id: pv2.id, resolve: 'supersedes', of: v.id, evidence: EV }])).resolved[0].resolved, 'supersedes', 'the orchestrator may replace a verified note');
});

test('B2: memory.store cannot write a note or a note\'s fields, for any caller', async () => {
  for (const caller of [orch, worker('w1'), callerFor('operator', { run_id: RUN })]) {
    await assert.rejects(call('memory.store', caller, { namespace: caller.role === 'worker' ? `run/${RUN}` : 'project/acme', type: 'note', text: 'a forged note K20' }), e => e.code === 'E_ARGS' && /reserved/.test(e.message), caller.role);
  }
  for (const k of ['model', 'state', 'seen_in', 'seen_total', 'matches', 'reported_wrong']) {
    await assert.rejects(call('memory.store', orch, { namespace: `run/${RUN}`, type: 'fact', text: `a fact with a forged ${k} K21`, body: { [k]: 'x' } }), e => e.code === 'E_ARGS' && new RegExp(k).test(e.message), k);
  }
  assert.ok((await call('memory.store', orch, { namespace: `run/${RUN}`, type: 'fact', text: 'an ordinary fact with a body K22', body: { v: 1 }, embed: false })).id);
});

test('S1: a rolled-back write leaves no phantom row in the vector cache', () => {
  const ns = 'project/cache-test';
  store.storeIn({ namespace: ns, worker_id: 'w', text: 'seed row', embedding: [1, 0, 0], embedding_model: 'fake3', dim: 3 });
  store._loadNs(ns); // the cache is warm
  let id;
  assert.throws(() => store.tx(() => { id = store.storeIn({ namespace: ns, worker_id: 'w', text: 'rolled back row', embedding: [0, 1, 0], embedding_model: 'fake3', dim: 3 }).id; throw new Error('boom'); }), /boom/);
  assert.strictEqual(store.p('SELECT 1 AS x FROM memory_entries WHERE id = ?').get(id), undefined, 'the row is not in the table');
  assert.ok(!store._loadNs(ns).rows.some(r => r.id === id), 'and not in the cache');
});

test('S2: a note whose text is already a row is reported as a duplicate, never as written, and the row is untouched', async () => {
  const w = worker('w1');
  const n = note('K40');
  const fact = store.store({ namespace: 'project/acme', worker_id: 'w1', written_by: 'worker:w1', type: 'fact', text: textOf(n), title: 'a fact', body: JSON.stringify({ v: 1 }), source: 'model' });
  const before = rowOf(fact.id);
  const out = (await hand(w, { notes: [n] })).out;
  assert.deepStrictEqual([out.notes[0].state, out.notes[0].id, out.notes[0].existing_type], ['duplicate', fact.id, 'fact']);
  assert.strictEqual(out.pending, 0);
  assert.deepStrictEqual(rowOf(fact.id), before, 'the fact is exactly as it was');
  await hand(w, { notes: [note('K41')] });
  const n2 = note('K41x', { title: 'K41x claim' });
  const other = store.store({ namespace: 'pending/acme', worker_id: 'w3', written_by: 'worker:w3', type: 'note', text: textOf(n2), title: 'x', source: 'model' });
  const out2 = (await hand(w, { notes: [n2] })).out;
  assert.deepStrictEqual([out2.notes[0].state, out2.notes[0].id, out2.pending], ['duplicate', other.id, 0]);
});

test('S3: notes after a release need notes_reflection, are once per lease, and one writer cannot evict another\'s report', async () => {
  const wh = worker('whi', HI);
  const { l } = await hand(wh, { result: { summary: 's' }, notes: [] }, HI);
  await assert.rejects(call('lease.release', wh, { lease_id: l.lease_id, notes: [note('K42')] }), e => e.code === 'E_ARGS' && /notes_reflection/.test(e.message));
  const w = worker('w1');
  const first = await hand(w, { result: { summary: 's' }, notes: [] });
  await call('lease.release', w, { lease_id: first.l.lease_id, notes: [note('K43')] });
  await assert.rejects(call('lease.release', w, { lease_id: first.l.lease_id, notes: [] }), e => e.code === 'E_EXISTS');
  const t = (await hand(w, { notes: [note('K44')] })).out.notes[0];
  for (const [who, n] of [['w1', 1], ['w2', 1], ['w1', 2]]) await hand(worker(who), { notes: [], reported_wrong: [{ id: t.id, why: `report ${n} by ${who}` }] });
  assert.deepStrictEqual(bodyOf(t.id).reported_wrong.map(r => [r.by, r.why]).sort(), [['worker:w1', 'report 2 by w1'], ['worker:w2', 'report 1 by w2']]);
});

test('S4: a note is not a second sighting of a note the same writer wrote in the same task', async () => {
  const w = worker('w1');
  const { l, out } = await hand(w, { result: { summary: 's' }, notes: [note('K45')] });
  const p = (await call('lease.release', w, { lease_id: l.lease_id, notes: [note('K45x', { title: 'K45x the same claim again' })] })).notes[0];
  assert.strictEqual(p.state, 'pending');
  await assert.rejects(resolve(w, [{ id: p.id, resolve: 'repeats', of: out.notes[0].id }]), e => e.code === 'E_ARGS' && /not a second sighting/.test(e.message));
  assert.strictEqual(bodyOf(out.notes[0].id).seen_total, 0);
});

test('S5: only receipts at or before the pending note count, and the field says index', async () => {
  const live = (await hand(worker('w3'), { notes: [note('K46')] })).out.notes[0];
  const w = worker('w2');
  await call('memory.recordEvent', orch, { kind: 'index_injected', worker_id: 'w2', row_ids: ['unrelated'], bytes: 1, sha256: 'x' });
  await pause(5);
  const p = (await hand(w, { notes: [note('K46x', { title: 'K46x claim' })] })).out.notes[0];
  await pause(5);
  await call('memory.recordEvent', orch, { kind: 'index_injected', worker_id: 'w2', row_ids: [live.id], bytes: 1, sha256: 'x' }); // after the write
  await resolve(w, [{ id: p.id, resolve: 'repeats', of: live.id }]);
  const s = bodyOf(live.id).seen_in[0];
  assert.strictEqual(s.in_index_beforehand, false, 'delivered after the write is not beforehand');
  assert.ok(!('shown_beforehand' in s));
});

test('nits: an oversized note is refused, a resolved note drops its matches, a clash with a non-note is resolved with a changed title', async () => {
  const w = worker('w1');
  const big = note('K47', { evidence: Array.from({ length: 8 }, (_, i) => ({ where: 'w'.repeat(290) + i, saw: 's'.repeat(490) })) });
  await assert.rejects(hand(w, { notes: [big] }), e => e.code === 'E_NOTE_SHAPE' && /limit is 4096/.test(e.message));
  await hand(w, { notes: [note('K48')] });
  const p = (await hand(w, { notes: [note('K48x', { title: 'K48x claim' })] })).out.notes[0];
  assert.ok(bodyOf(p.id).matches, 'pending carries its matches');
  const fact = store.store({ namespace: 'project/acme', worker_id: 'x', written_by: 'orchestrator', type: 'fact', text: rowOf(p.id).text, source: 'model' });
  await assert.rejects(resolve(w, [{ id: p.id, resolve: 'new' }]), e => e.code === 'E_EXISTS' && e.message.includes(fact.id) && /changed title/.test(e.message));
  assert.strictEqual((await resolve(w, [{ id: p.id, resolve: 'new', title: 'K48x the changed claim' }])).resolved[0].state, 'live');
  assert.strictEqual(rowOf(p.id).title, 'K48x the changed claim');
  assert.strictEqual(rowOf(p.id).text.split('\n')[0], 'K48x the changed claim');
  assert.strictEqual(bodyOf(p.id).matches, undefined, 'matches are dropped once resolved');
});
