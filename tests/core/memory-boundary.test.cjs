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

const ODD = ['Notes/X', 'notes/x/', 'Team/Alpha', 'mixed\path', 'Team//Beta', ' padded '];

test('BD6: a namespace that is not one of belay\'s routes is left byte for byte: rows under odd spellings are listed, exported, searched and written by the same spelling', async () => {
  const ids = ODD.map((ns, i) => X.store.storeIn({ namespace: ns, worker_id: 'old', type: 'fact', text: `oddspelling row ${i} zebra${i}`, run_id: 'r-old', source: 'model', written_by: 'harness' }).id);
  for (const [i, ns] of ODD.entries()) {
    const listed = await X.call('memory.list', X.operator, { namespaces: [ns] });
    assert.deepStrictEqual(listed.rows.map((r) => r.id), [ids[i]], JSON.stringify(ns));
    assert.deepStrictEqual(listed.searched.namespaces, [ns]);
    const found = await X.call('memory.search', X.operator, { namespace: ns, query: `zebra${i}`, mode: 'keyword' });
    assert.deepStrictEqual(found.results.map((r) => r.id), [ids[i]], `search ${JSON.stringify(ns)}`);
    const exported = await X.call('memory.get', X.operator, { ids: listed.rows.map((r) => r.id) }); // what export reads after list
    assert.strictEqual(exported.rows[0].namespace, ns);
    const more = await X.call('memory.store', X.operator, { namespace: ns, type: 'fact', text: `second oddspelling row ${i}`, embed: false });
    assert.strictEqual(X.rowOf(more.id).namespace, ns, 'a new write lands in the same namespace, not a second one');
  }
  assert.strictEqual(X.store.p("SELECT COUNT(DISTINCT namespace) AS n FROM memory_entries WHERE namespace LIKE '%otes%x%'").get().n, 2, 'Notes/X and notes/x/ stay two namespaces, as stored');
});

test('BD7: a look-alike of a routed prefix in another script is refused, not stored as a second namespace', async () => {
  for (const ns of ['\u0440roject/acme', 'pr\u043eject', 'summ\u0430ry/acme', '\u0455ummary', '\u0420ROJECT/acme']) {
    const before = count();
    await assert.rejects(X.call('memory.store', X.orch, { namespace: ns, type: 'fact', text: 'x', embed: false }), (e) => e.code === 'E_ARGS' && /look-alike/.test(e.message), JSON.stringify(ns));
    assert.strictEqual(count(), before);
  }
});

test('BD8: a notes run reaches exactly the resolved levers\' project, whatever its project column holds; writes and reads of another project are E_ROLE', async () => {
  const run = 'r-bd-nullproj';
  const o = callerFor('orchestrator', { run_id: run });
  await X.call('run.attach', o, { adapter_pid: process.pid, project: null, memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  assert.strictEqual(X.store.p('SELECT project FROM run WHERE id = ?').get(run).project, null, 'the column is never derived from the levers');
  const w = callerFor('worker', { run_id: run, worker_id: 'w-bd8' });
  await X.call('worker.write', X.orch, { id: 'w-bd8', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const before = count();
  for (const ns of ['project/zzz', 'Project/ZZZ', 'summary/zzz']) {
    await assert.rejects(X.call('memory.store', o, { namespace: ns, title: 't', text: 'x', kind: 'lesson', when: 'w', basis: 'inferred' }), (e) => e.code === 'E_ROLE', `write ${ns}`);
    for (const [m, args] of [['memory.list', { namespaces: [ns] }], ['memory.search', { namespace: ns, query: 'x', mode: 'keyword' }], ['memory.timeline', { anchor_id: 'x' }]]) {
      if (m === 'memory.timeline') continue;
      await assert.rejects(X.call(m, o, args), (e) => e.code === 'E_ROLE', `${m} ${ns}`);
    }
    await assert.rejects(X.call('memory.list', w, { namespaces: [ns] }), (e) => e.code === 'E_ROLE', `worker read ${ns}`);
    await assert.rejects(X.call('memory.store', w, { namespace: ns, title: 't', text: 'x', kind: 'lesson', when: 'w', basis: 'inferred' }), (e) => e.code === 'E_ROLE', `worker write ${ns}`);
  }
  await assert.rejects(X.call('memory.corpus', o, { project: 'zzz' }), (e) => e.code === 'E_ROLE');
  assert.strictEqual(count(), before, 'nothing was written');
  const mine = await X.call('memory.store', o, { namespace: 'project', ...X.note('K31') });
  assert.strictEqual(mine.namespace, 'project/acme', 'the alias resolves to the levers\' project');
  const sum = await X.call('memory.store', o, { namespace: 'summary', title: 't', text: 'outcome' });
  assert.strictEqual(X.rowOf(sum.id).namespace, 'summary/acme');
  assert.ok((await X.call('memory.list', o, { namespaces: ['project/acme'] })).rows.length >= 0);
});
