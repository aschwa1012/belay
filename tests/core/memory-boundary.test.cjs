'use strict';
// memory-boundary.test.cjs — what the Core boundary does before routing (ADR 0047 amendment of 2026-10-22): a row the caller cannot read is not found for
// a delete either; every spelling of a namespace is one namespace; and a run's project is named once.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');
const { callerFor } = require('./helpers.cjs');

let X;
before(async () => { X = await setup('r-bd'); });
after(() => X.cleanup());

const count = () => X.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
const legacyRow = (text) => X.store.storeIn({ namespace: 'project/acme', worker_id: 'old', type: 'fact', text, run_id: 'r-old', source: 'model', written_by: 'harness' }).id;

test('BD1: a delete of a row the caller cannot read answers as a missing id does, and deletes nothing', async () => {
  const id = legacyRow('a legacy fact that predates notes');
  const missing = await X.call('memory.delete', X.orch, { id: 'no-such-row-id' });
  const hidden = await X.call('memory.delete', X.orch, { id });
  assert.deepStrictEqual(hidden, { id, deleted: false });
  assert.deepStrictEqual(Object.keys(hidden), Object.keys(missing));
  assert.ok(!JSON.stringify(hidden).includes('project/'), 'no namespace in the reply');
  assert.ok(X.rowOf(id), 'the row is still there');
  await X.startTask('w-bd1', 's\n');
  assert.deepStrictEqual(await X.call('memory.delete', X.worker('w-bd1'), { id }), { id, deleted: false });
  const op = await X.call('memory.delete', X.operator, { id });
  assert.strictEqual(op.deleted, true, 'the operator reads it and may delete it');
});

const SPELLINGS = ['Project/acme', ' project', 'PROJECT', 'project//acme', '/project/acme/', 'PROJECT/ACME', 'project\\acme', 'Ｐroject/acme', 'project/acme ', '\tProject', 'project/​acme'];

test('BD2: every spelling of the project namespace is the project: a plain row is refused as a note shape, a note is a note', async () => {
  await X.startTask('w-bd2', 's\n');
  for (const [who, caller] of [['orchestrator', X.orch], ['worker', X.worker('w-bd2')]]) {
    for (const ns of SPELLINGS) {
      const before = count();
      await assert.rejects(X.call('memory.store', caller, { namespace: ns, type: 'fact', text: `plain ${who} ${ns.length}` }), (e) => e.code === 'E_NOTE_SHAPE', `${who} ${JSON.stringify(ns)}`);
      assert.strictEqual(count(), before, `${who} ${JSON.stringify(ns)} wrote nothing`);
    }
  }
  const out = await X.call('memory.store', X.orch, { namespace: 'PROJECT/Acme', ...X.note('K21') });
  assert.deepStrictEqual([out.namespace, X.rowOf(out.id).type], ['project/acme', 'note']);
});

test('BD3: the summary alias and the closed spellings are normalised too', async () => {
  const s = await X.call('memory.store', X.orch, { namespace: ' Summary ', title: 't', text: 'an outcome' });
  assert.strictEqual(X.rowOf(s.id).namespace, 'summary/acme');
  for (const ns of ['SUMMARY/acme', 'Summary//acme', 'Project/other', 'PROJECT/OTHER']) {
    await assert.rejects(X.call('memory.store', X.orch, { namespace: ns, title: 't', text: 'x', kind: 'lesson' }), (e) => e.code === 'E_ROLE', ns);
  }
  await X.startTask('w-bd3', 's\n');
  await assert.rejects(X.call('memory.store', X.worker('w-bd3'), { namespace: 'SUMMARY', title: 't', text: 'x' }), (e) => e.code === 'E_ROLE');
  for (const ns of ['Archive/acme', 'HELD/acme', ' pending/acme']) {
    await assert.rejects(X.call('memory.list', X.orch, { namespaces: [ns] }), (e) => e.code === 'E_ROLE', `read ${ns}`);
  }
});

test('BD4: reads take any spelling and still hide the legacy rows; run namespaces keep their capitals', async () => {
  const id = legacyRow('legacy spelled-read row');
  const note = (await X.call('memory.store', X.orch, { namespace: 'project', ...X.note('K22') })).id;
  for (const ns of ['Project/acme', 'PROJECT', ' project/acme']) {
    const rows = (await X.call('memory.list', X.orch, { namespaces: [ns] })).rows.map((r) => r.id);
    assert.ok(rows.includes(note) && !rows.includes(id), JSON.stringify(ns));
    const got = await X.call('memory.search', X.orch, { namespace: ns, query: 'legacy spelled-read', mode: 'keyword' });
    assert.ok(!got.results.some((r) => r.id === id), `search ${JSON.stringify(ns)}`);
  }
  const caps = callerFor('orchestrator', { run_id: 'Mixed-CASE-run' });
  await X.call('run.attach', caps, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  const r = await X.call('memory.store', caps, { text: 'a run row', type: 'fact', embed: false });
  assert.strictEqual(X.rowOf(r.id).namespace, 'run/Mixed-CASE-run');
  const again = await X.call('memory.store', caps, { namespace: 'Run/Mixed-CASE-run', text: 'a second run row', type: 'fact', embed: false });
  assert.strictEqual(X.rowOf(again.id).namespace, 'run/Mixed-CASE-run');
});

test('BD5: run.attach refuses a project that differs from the levers\' project, and writes nothing', async () => {
  const c = callerFor('orchestrator', { run_id: 'r-bd-mismatch' });
  await assert.rejects(X.call('run.attach', c, { adapter_pid: process.pid, project: 'zzz', memory_levers: JSON.stringify({ project: 'acme', notes: true }) }), (e) => e.code === 'E_ARGS' && /agree/.test(e.message) && e.detail.project === 'zzz' && e.detail.memory_project === 'acme');
  assert.strictEqual(X.store.p("SELECT COUNT(*) AS n FROM run WHERE id = 'r-bd-mismatch'").get().n, 0);
  await assert.rejects(X.call('run.attach', c, { adapter_pid: process.pid, project: 'zzz', memory_levers: JSON.stringify({ notes: false }) }), (e) => e.code === 'E_ARGS');
  const ok = await X.call('run.attach', c, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  assert.ok(ok.run);
});
