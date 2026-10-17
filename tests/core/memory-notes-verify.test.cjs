'use strict';
// memory-notes-verify.test.cjs — the verification review of the notes core (ADR 0047): a dedup hit never rewrites a note,
// a worker launched without the notes contract can still release, a replaced_by names only a row the call wrote, and a
// retitle that collides is refused by name.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const NT = core('memory-notes.cjs');

let dir, store, E;
const RUN = 'r-ver';
const orch = callerFor('orchestrator', { run_id: RUN });
const worker = id => callerFor('worker', { run_id: RUN, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const bodyOf = id => JSON.parse(rowOf(id).body);
let seq = 0;

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
async function hand(w, extra) {
  const t = await call('task.create', orch, { spec: `job ${++seq}` });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: w.worker_id });
  return call('lease.release', w, { lease_id: a.new_lease.id, ...extra });
}
const resolve = (caller, resolutions) => call('memory.noteResolve', caller, { resolutions });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  for (const id of ['w1', 'w2', 'wun']) await call('worker.write', orch, { id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), model: 'claude-test-1' });
});
after(() => { store.close(); cleanup(dir); });

test('N1: a dedup hit on a note never rewrites its body, even from the same writer', async () => {
  const live = (await hand(worker('w1'), { notes: [note('K50')] })).notes[0];
  const target = (await hand(worker('w2'), { notes: [], reported_wrong: [{ id: live.id, why: 'someone else reported this' }] })).reported_wrong[0];
  assert.strictEqual(target.reports, 1);
  const before = rowOf(live.id);
  // the same writer re-stores the note's exact text with a body of its own, at the store layer that memory.store ends in
  const again = store.store({ namespace: 'project/acme', worker_id: 'w1', written_by: 'worker:w1', type: 'fact', source: 'model', text: before.text, title: 'mine', body: { x: 1 } });
  assert.strictEqual(again.action, 'unchanged');
  assert.strictEqual(again.id, live.id);
  assert.deepStrictEqual(rowOf(live.id), before, 'the note row is exactly as it was');
  const b = bodyOf(live.id);
  assert.deepStrictEqual([b.kind, b.basis, b.model, b.state, b.reported_wrong.length], ['lesson', 'observed', 'claude-test-1', 'live', 1]);
});

test('N2: a worker launched without the notes contract (levers unread) may release without notes; others may not', async () => {
  const w = worker('wun');
  const t = await call('task.create', orch, { spec: 'no contract' });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: 'wun' });
  await assert.rejects(call('lease.release', w, { lease_id: a.new_lease.id }), e => e.code === 'E_ARGS' && /notes is required/.test(e.message));
  await call('memory.recordEvent', orch, { kind: 'levers_unread', worker_id: 'wun', ok: false, code: 'E_OWNER_LOST', message: 'the run row could not be read at spawn' });
  const out = await call('lease.release', w, { lease_id: a.new_lease.id });
  assert.strictEqual(out.state, 'released');
  assert.ok(!('notes' in out));
  // another worker, no receipt: still required
  const t2 = await call('task.create', orch, { spec: 'with contract' });
  const a2 = await call('task.assign', orch, { task_id: t2.id, worker_id: 'w1' });
  await assert.rejects(call('lease.release', worker('w1'), { lease_id: a2.new_lease.id }), e => e.code === 'E_ARGS');
  // a worker that does pass notes is still held to their shape
  const t3 = await call('task.create', orch, { spec: 'passes notes' });
  const a3 = await call('task.assign', orch, { task_id: t3.id, worker_id: 'wun' });
  await assert.rejects(call('lease.release', w, { lease_id: a3.new_lease.id, notes: [{ kind: 'lesson' }] }), e => e.code === 'E_NOTE_SHAPE');
});

test('N3: replaced_by notes[i] is only ever a row this call wrote; a duplicate of someone else\'s pending note is explicit', async () => {
  const target = (await hand(worker('w1'), { notes: [note('K51')] })).notes[0];
  const n = note('K52x', { title: 'K52x claim' });
  await hand(worker('w1'), { notes: [note('K52')] });
  const text = NT.noteText(NT.checkNote(n));
  const foreign = store.store({ namespace: 'pending/acme', worker_id: 'w1', written_by: 'worker:w1', type: 'note', text, title: 'x', source: 'model' });
  const out = await hand(worker('w2'), { notes: [n], reported_wrong: [{ id: target.id, why: 'wrong now', replaced_by: 'notes[0]' }] });
  assert.deepStrictEqual([out.notes[0].state, out.notes[0].id], ['duplicate', foreign.id]);
  assert.match(out.notes[0].note, /nothing for you to resolve/);
  assert.strictEqual(out.reported_wrong[0].replaced_by, null, 'not the foreign pending row');
  assert.strictEqual(bodyOf(target.id).reported_wrong[0].replaced_by, null);
  const mine = await hand(worker('w2'), { notes: [note('K53')], reported_wrong: [{ id: target.id, why: 'again', replaced_by: 'notes[0]' }] });
  assert.strictEqual(mine.reported_wrong[0].replaced_by, mine.notes[0].id, 'a row this call wrote is named');
});

test('N4: a retitle that makes a note the same text as another pending row is E_EXISTS naming it', async () => {
  const w = worker('w1');
  await hand(w, { notes: [note('K54')] });
  const p1 = (await hand(w, { notes: [note('K54x', { title: 'K54x first title' })] })).notes[0];
  const p2 = (await hand(w, { notes: [note('K54x', { title: 'K54x second title' })] })).notes[0];
  assert.deepStrictEqual([p1.state, p2.state], ['pending', 'pending']);
  await assert.rejects(resolve(w, [{ id: p2.id, resolve: 'new', title: 'K54x first title' }]), e => e.code === 'E_EXISTS' && e.message.includes(p1.id) && e.detail.existing_id === p1.id);
  assert.strictEqual(rowOf(p2.id).title, 'K54x second title', 'nothing changed');
});

test('N7: the unknown-field message lists every field, title included', () => {
  assert.throws(() => NT.checkResolutions([{ id: 'p', resolve: 'new', bogus: 1 }]), e => /use id, resolve, of, evidence, title/.test(e.message));
});
