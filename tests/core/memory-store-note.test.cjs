'use strict';
// memory-store-note.test.cjs — a project memory.store by a worker or the orchestrator in a notes run is a note write, through the hand-back's own
// functions and per-project order (ADR 0047 amendment of 2026-10-22). Real core against a sandbox store with a fake embedder; the interleaving is forced
// by a stall on the embedder, never by a sleep.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');
const { callerFor } = require('./helpers.cjs');

let X, Y;
before(async () => {
  X = await setup('r-sn');
  Y = await setup('r-sn-off', { notes: false });
});
after(async () => { await X.cleanup(); await Y.cleanup(); });

const store = (caller, args) => X.call('memory.store', caller, args);
const noteArgs = (marker, over = {}) => ({ namespace: 'project', ...X.note(marker), ...over });
const count = () => X.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
const OTHER = 'r-sn-other';

test('S1: a worker store-note is a note row with the writer, task and model from belay, and no field of the note names them', async () => {
  await X.call('worker.write', X.orch, { id: 'w-s1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-w-s1', last_event_at: Date.now(), model: 'claude-sonnet-5-5' });
  const s = await X.startTask('w-s1', 'a stream\n');
  await X.call('worker.write', X.orch, { id: 'w-s1', model: 'claude-sonnet-5-5' });
  const out = await store(X.worker('w-s1'), noteArgs('K1'));
  assert.deepStrictEqual([out.state, out.action, out.namespace, out.project], ['stored', 'inserted', 'project/acme', 'acme']);
  const row = X.rowOf(out.id);
  assert.deepStrictEqual([row.type, row.task_id, row.run_id, row.written_by, row.worker_id], ['note', s.task, 'r-sn', 'worker:w-s1', 'w-s1']);
  const b = X.bodyOf(out.id);
  assert.deepStrictEqual([b.kind, b.basis, b.state, b.model], ['lesson', 'observed', 'live', 'claude-sonnet-5-5']);
  assert.strictEqual(row.text_template, 'v2');
  assert.ok(row.embedding, 'embedded');
});

test('S2: the note is hidden from another run until its writer hands the task back (the gate), then visible', async () => {
  const o2 = callerFor('orchestrator', { run_id: OTHER });
  await X.call('run.attach', o2, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  const s = await X.startTask('w-s2', 'a stream\n');
  const out = await store(X.worker('w-s2'), noteArgs('K2'));
  const seenBy = async () => (await X.call('memory.list', o2, { namespaces: ['project/acme'] })).rows.some((r) => r.id === out.id);
  assert.strictEqual(await seenBy(), false, 'hidden while the writer still holds the lease');
  assert.strictEqual((await X.call('memory.list', X.orch, { namespaces: ['project/acme'] })).rows.some((r) => r.id === out.id), true, 'the writer\'s own run sees it');
  await X.call('lease.release', X.worker('w-s2'), { lease_id: s.lease, notes: [] });
  assert.strictEqual(await seenBy(), true, 'visible once the lease is handed back');
});

test('S3: no note fields at all is E_NOTE_SHAPE and writes nothing; so is each field that is not a note field', async () => {
  await X.startTask('w-s3', 'a stream\n');
  const before = count();
  await assert.rejects(store(X.worker('w-s3'), { namespace: 'project' }), (e) => e.code === 'E_NOTE_SHAPE');
  for (const [k, v] of [['text', 'a plain fact'], ['type', 'fact'], ['tags', ['x']], ['ttl_seconds', 60], ['supersedes', 'abc'], ['provenance', 'p'], ['body', {}]]) {
    await assert.rejects(store(X.worker('w-s3'), { ...noteArgs('K3'), [k]: v }), (e) => e.code === 'E_NOTE_SHAPE' || (k === 'supersedes' && e.code === 'E_NOTE_SHAPE'), k);
  }
  await assert.rejects(store(X.worker('w-s3'), { namespace: 'project', text: 'a plain fact', type: 'fact' }), (e) => e.code === 'E_NOTE_SHAPE' && /not a field of a note/.test(e.message));
  assert.strictEqual(count(), before, 'nothing was written');
});

test('S4: a worker holding no lease cannot write a note, and is told the hand-back route', async () => {
  await X.call('worker.write', X.orch, { id: 'w-s4', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-w-s4', last_event_at: Date.now() });
  const before = count();
  await assert.rejects(store(X.worker('w-s4'), noteArgs('K4')), (e) => e.code === 'E_ARGS' && /lease_release notes/.test(e.message));
  assert.strictEqual(count(), before);
});

test('S5: a close match makes the note pending with its matches; the same words written twice are one row', async () => {
  await X.startTask('w-s5', 'a stream\n');
  const first = await store(X.worker('w-s5'), noteArgs('K5 first'));
  assert.strictEqual(first.state, 'stored');
  const close = await store(X.worker('w-s5'), noteArgs('K5 second'));
  assert.strictEqual(close.state, 'pending');
  assert.strictEqual(close.namespace, 'pending/acme');
  assert.deepStrictEqual(close.matches.map((m) => m.id), [first.id]);
  assert.match(close.next, /memory_note_resolve/);
  const again = await store(X.worker('w-s5'), noteArgs('K5 second'));
  assert.deepStrictEqual([again.action, again.id], ['duplicate', close.id]);
  assert.strictEqual(X.store.p('SELECT COUNT(*) AS n FROM memory_entries WHERE text = ?').get(X.rowOf(close.id).text).n, 1, 'one row');
});

test('S6: an orchestrator note has no task, is hidden from another run until run.end, and sits in the run\'s own scope for the scrubber', async () => {
  const out = await store(X.orch, noteArgs('K6'));
  const row = X.rowOf(out.id);
  assert.deepStrictEqual([row.type, row.task_id, row.written_by, row.run_id], ['note', null, X.E.memoryWriter(X.orch), 'r-sn']);
  assert.strictEqual(X.bodyOf(out.id).model, null, 'no model on the run row, none invented');
  const o2 = callerFor('orchestrator', { run_id: OTHER });
  assert.strictEqual((await X.call('memory.list', o2, { namespaces: ['project/acme'] })).rows.some((r) => r.id === out.id), false, 'hidden while its run is open');
  assert.strictEqual(X.store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'note' AND run_id = ? AND task_id IS NULL AND namespace = 'project/acme'").get('r-sn').n >= 1, true, 'found by run for the scrubber');
  assert.strictEqual(X.bodyOf(out.id).task_files.length, 0, 'no worktree diff is recorded for the orchestrator');
  assert.ok(!('diff_error' in out.applies_to), 'no false diff_error');
});

test('S7: a store-note and a hand-back of one project run in order: the second sees the first as a match', async () => {
  const s = await X.startTask('w-s7', 'a stream\n');
  const stall = X.stall();
  const first = store(X.orch, noteArgs('K7 alpha'));
  await stall.reached; // the first is inside its embedding
  const second = X.call('lease.release', X.worker('w-s7'), { lease_id: s.lease, notes: [X.note('K7 beta')] });
  let settled = false;
  second.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.strictEqual(settled, false, 'the second waits for the first');
  stall.release();
  const a = await first, b = await second;
  assert.strictEqual(a.state, 'stored');
  assert.strictEqual(b.notes[0].state, 'pending', 'the hand-back found the store-note');
  assert.deepStrictEqual(b.notes[0].matches.map((m) => m.id), [a.id]);
});

test('S8: with notes off a project store is the ordinary row, and a note field is refused by name', async () => {
  const row = await Y.call('memory.store', Y.orch, { namespace: 'project', type: 'fact', text: 'an ordinary fact' });
  assert.strictEqual(Y.rowOf(row.id).type, 'fact');
  await assert.rejects(Y.call('memory.store', Y.orch, { namespace: 'project', text: 'x', kind: 'lesson' }), (e) => e.code === 'E_LEVER_OFF' && /kind/.test(e.message));
  await assert.rejects(Y.call('memory.store', Y.orch, { namespace: 'run/r-sn-off', text: 'x', kind: 'lesson' }), (e) => e.code === 'E_ARGS');
});

test('S9: the harness channel and the operator keep the ordinary store in a notes run', async () => {
  const h = await X.call('memory.store', X.harness, { namespace: 'project', type: 'fact', text: 'harness project copy' });
  assert.strictEqual(X.rowOf(h.id).type, 'fact');
  const o = await X.call('memory.store', X.operator, { namespace: 'project/acme', type: 'fact', text: 'operator fact' });
  assert.strictEqual(X.rowOf(o.id).type, 'fact');
});

test('S10: a worker\'s own run namespace is unchanged in a notes run', async () => {
  await X.startTask('w-s10', 'a stream\n');
  const r = await store(X.worker('w-s10'), { text: 'a scratch finding' });
  assert.strictEqual(X.rowOf(r.id).namespace, 'run/r-sn');
  assert.notStrictEqual(X.rowOf(r.id).type, 'note');
});
