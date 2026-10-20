'use strict';
// memory-k2-writes.test.cjs — the hand-back write against what the project already knows: a claim already judged wrong is not stored
// live again without a step, the same words from another writer are a sighting, and two hand-backs of one project check one after
// the other. Same fake embedder as memory-notes-handback.test.cjs: K<n> is an axis and K<n>x is its near-duplicate.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const RUN = 'r-k2w';
const orch = callerFor('orchestrator', { run_id: RUN });
const worker = id => callerFor('worker', { run_id: RUN, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const bodyOf = id => JSON.parse(rowOf(id).body);
let seq = 0;
let hook = null; // awaited by the embedder before it answers, so a test can hold a hand-back where it is

const DIM = 16;
const embed = async text => {
  if (hook) await hook(text);
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

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  for (const id of ['w1', 'w2', 'w3']) await call('worker.write', orch, { id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), model: 'claude-test-1' });
});
after(() => { store.close(); cleanup(dir); });

// ---- D31: a claim the project already judged wrong ---------------------------------------------------------------------

test('D31: a note close to a refuted one waits in pending with the earlier verdict shown, and resolving it as new puts it live', async () => {
  const first = (await hand(worker('w1'), { notes: [note('K2')] })).out.notes[0];
  assert.strictEqual(first.state, 'stored');
  store.p("UPDATE memory_entries SET status = 'refuted', status_receipt = 'review:abc' WHERE id = ?").run(first.id);
  const { out } = await hand(worker('w2'), { notes: [note('K2x', { title: 'the K2x loader ignores unlisted fixtures' })] });
  const p = out.notes[0];
  assert.deepStrictEqual([p.state, p.namespace, out.pending], ['pending', 'pending/acme', 1]);
  assert.strictEqual(out.state, 'released', 'the release goes on');
  assert.deepStrictEqual(p.matches, [], 'no live match: the refuted note is not one');
  assert.deepStrictEqual(p.prior_verdicts.map(v => [v.id, v.verdict, v.receipt]), [[first.id, 'refuted', 'review:abc']]);
  assert.ok(p.prior_verdicts[0].similarity >= 0.8);
  assert.match(p.held_back, /judged wrong/);
  assert.deepStrictEqual(bodyOf(p.id).prior_verdicts, p.prior_verdicts);
  assert.strictEqual(bodyOf(p.id).matches, undefined);
  const r = await call('memory.noteResolve', worker('w2'), { resolutions: [{ id: p.id, resolve: 'new' }] });
  assert.deepStrictEqual([r.resolved[0].state, rowOf(p.id).namespace], ['live', 'project/acme']);
  assert.strictEqual(bodyOf(p.id).prior_verdicts.length, 1, 'the earlier verdict stays on the note');
});

test('D31: a note close to one archived as wrong is held back with its reason; one archived as a duplicate is not a verdict', async () => {
  const wrongOne = (await hand(worker('w1'), { notes: [note('K3')] })).out.notes[0];
  const dupOne = (await hand(worker('w1'), { notes: [note('K4')] })).out.notes[0];
  for (const [id, kind] of [[wrongOne.id, 'wrong'], [dupOne.id, 'duplicate']]) {
    store.moveRow(id, 'project/acme', 'archive/acme');
    store.patchBody(id, b => { b.state = 'archived'; b.archived = { at: 5, from: 'project/acme', kind, ground: kind === 'wrong' ? 'refuted_review' : 'same_claim', reason: `archived as ${kind}` }; return b; });
  }
  const w = (await hand(worker('w2'), { notes: [note('K3x', { title: 'the K3x loader ignores unlisted fixtures' })] })).out.notes[0];
  assert.strictEqual(w.state, 'pending');
  assert.deepStrictEqual(w.prior_verdicts.map(v => [v.id, v.verdict, v.ground, v.reason]), [[wrongOne.id, 'archived_wrong', 'refuted_review', 'archived as wrong']]);
  const d = (await hand(worker('w2'), { notes: [note('K4x', { title: 'the K4x loader ignores unlisted fixtures' })] })).out.notes[0];
  assert.deepStrictEqual([d.state, d.prior_verdicts], ['stored', undefined]);
});

test('D31: a refuted note of another project, a distant one, and a note with a live match each behave as before', async () => {
  const other = store.storeIn({ namespace: 'project/elsewhere', worker_id: 'w1', type: 'note', text: 'K5 elsewhere\n#1', title: 'K5 elsewhere', body: { kind: 'lesson', state: 'live' }, embedding: (await embed('K5')).embedding, embedding_model: 'fake', embedding_revision: 'r', dim: DIM, text_template: 'v2', run_id: 'x', source: 'model', written_by: 'worker:w1' });
  store.p("UPDATE memory_entries SET status = 'refuted' WHERE id = ?").run(other.id);
  const a = (await hand(worker('w2'), { notes: [note('K5x', { title: 'the K5x loader ignores unlisted fixtures' })] })).out.notes[0];
  assert.strictEqual(a.state, 'stored', 'another project\'s refuted note is no verdict here');
  const far = (await hand(worker('w2'), { notes: [note('K6', { title: 'the K6 service retries twice' })] })).out.notes[0];
  assert.strictEqual(far.state, 'stored');
  // a live match and a prior verdict together: both are shown
  const live = (await hand(worker('w1'), { notes: [note('K7')] })).out.notes[0];
  const gone = store.storeIn({ namespace: 'project/acme', worker_id: 'w1', type: 'note', text: 'K7 the old one\n#1', title: 'K7 the old one', body: { kind: 'lesson', state: 'live' }, embedding: (await embed('K7x')).embedding, embedding_model: 'fake', embedding_revision: 'r', dim: DIM, text_template: 'v2', run_id: 'x', source: 'model', written_by: 'worker:w1' });
  store.p("UPDATE memory_entries SET status = 'refuted' WHERE id = ?").run(gone.id);
  const both = (await hand(worker('w2'), { notes: [note('K7x', { title: 'the K7x loader ignores unlisted fixtures' })] })).out.notes[0];
  assert.deepStrictEqual([both.state, both.matches.map(m => m.id), both.prior_verdicts.map(v => v.id)], ['pending', [live.id], [gone.id]]);
});

// ---- L01: the same words from another writer ---------------------------------------------------------------------------

test('L01: an exact-text duplicate from another writer in another task is a sighting of the live note; the author\'s own task is not', async () => {
  const w1 = worker('w1');
  const first = await hand(w1, { notes: [note('K8')] });
  const live = first.out.notes[0];
  assert.strictEqual(live.state, 'stored');
  // an older note made from the v1 template is never compared with a v2 one, so the same words find no match and meet the text clash
  store.p("UPDATE memory_entries SET text_template = 'v1' WHERE id = ?").run(live.id);
  const again = (await hand(worker('w2'), { notes: [note('K8')] })).out.notes[0];
  assert.deepStrictEqual([again.state, again.id, again.same_writer], ['duplicate', live.id, false]);
  assert.deepStrictEqual(again.sighting, { recorded: true, seen_total: 1 });
  const b = bodyOf(live.id);
  assert.deepStrictEqual([b.seen_total, b.seen_in.length, b.seen_in[0].written_by, b.seen_in[0].via], [1, 1, 'worker:w2', 'same_text']);
  // the same writer in a later task is another sighting; the same pair is recorded once
  const later = (await hand(worker('w2'), { notes: [note('K8')] })).out.notes[0];
  assert.deepStrictEqual(later.sighting, { recorded: true, seen_total: 2 });
  // two copies in one later hand-back are one sighting of it, not two
  const twice = (await hand(worker('w3'), { notes: [note('K8'), note('K8')] })).out.notes;
  assert.deepStrictEqual(twice.map(n => n.sighting && n.sighting.seen_total), [3, undefined]);
  // the same words twice in one hand-back: the second meets the first, which is the writer's own task, so it is no sighting
  const twin = (await hand(worker('w3'), { notes: [note('K9'), note('K9')] })).out.notes;
  assert.deepStrictEqual(twin.map(n => n.state), ['stored', 'duplicate']);
  assert.strictEqual(twin[1].sighting, undefined);
  assert.strictEqual(bodyOf(twin[0].id).seen_total, 0);
});

// ---- D43: concurrent hand-backs --------------------------------------------------------------------------------------

test('D43: two hand-backs of one project that are near-duplicates are checked one after the other, so the second goes pending', async () => {
  let entered = 0;
  let open;
  const both = new Promise(r => { open = r; });
  // Hold each embedding until the other hand-back has also started embedding (or a short bound has passed): side by side, neither would see the other.
  hook = async text => {
    if (!/\bK10x?\b/.test(text)) return;
    entered += 1;
    if (entered >= 2) open();
    await Promise.race([both, new Promise(r => setTimeout(r, 400))]);
  };
  try {
    const [a, b] = await Promise.all([
      hand(worker('w1'), { notes: [note('K10')] }),
      hand(worker('w2'), { notes: [note('K10x', { title: 'the K10x loader ignores unlisted fixtures' })] }),
    ]);
    const states = [a.out.notes[0].state, b.out.notes[0].state].sort();
    assert.deepStrictEqual(states, ['pending', 'stored'], 'one stored, and the other saw it');
    const pending = [a, b].map(x => x.out.notes[0]).find(n => n.state === 'pending');
    const stored = [a, b].map(x => x.out.notes[0]).find(n => n.state === 'stored');
    assert.deepStrictEqual(pending.matches.map(m => m.id), [stored.id]);
  } finally { hook = null; }
});
