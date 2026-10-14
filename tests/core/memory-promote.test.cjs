'use strict';
// memory-promote.test.cjs — memory.promote: a worker's own run rows move into the project when its task ends. The
// row keeps its id and changes its namespace; only unverified, unsuperseded, unexpired rows the worker wrote for
// that task qualify; at most 50 move; a dedup collision and a model mismatch leave the row where it is.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const RUN = 'r-pr';
const orch = callerFor('orchestrator', { run_id: RUN });
const harness = Object.freeze({ ...orch, channel: 'harness' });
const off = callerFor('orchestrator', { run_id: 'r-pr-off' });  // project "acme", project_writes off
const none = callerFor('orchestrator', { run_id: 'r-pr-none' }); // no project
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const dbRow = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const pwEvents = () => store.p("SELECT * FROM memory_event WHERE kind = 'project_write' ORDER BY seq").all();
const unit = (x, y) => ({ embedding: [x, y], embedding_model: 'fake', embedding_revision: 'r', dim: 2 });
let n = 0;

// A row as the run manager would find it: written by a worker, for a task, in the run's namespace.
function seed(over = {}) {
  const w = over.worker || 'w1';
  return store.store({
    namespace: `run/${RUN}`, worker_id: w, written_by: `worker:${w}`, task_id: 't1', run_id: RUN, source: 'model',
    type: 'fact', text: `worker fact ${++n} unique-${Math.random().toString(36).slice(2)}`, ...over.row,
  });
}
const promote = (ids, extra = {}) => call('memory.promote', harness, { ids, to: 'project', task_id: 't1', worker_id: 'w1', ...extra });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  const getEmbedder = async () => ({ embed: async () => unit(1, 0) });
  E = new Engine({ dataDir: dir, store, getEmbedder, owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', project_writes: true }) });
  await call('run.attach', off, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme' }) });
  await call('run.attach', none, { adapter_pid: process.pid });
});
after(() => { store.close(); cleanup(dir); });

test('a move keeps the id, changes only the namespace, and records a project_write event with key promote:<id>', async () => {
  const r = seed();
  const before = dbRow(r.id);
  const out = await promote([r.id]);
  assert.deepStrictEqual(out.moved, [{ id: r.id, from: `run/${RUN}`, to: 'project/acme' }]);
  assert.strictEqual(out.namespace, 'project/acme');
  assert.deepStrictEqual([out.existing, out.refused, out.skipped, out.capped], [[], [], [], 0]);
  const after = dbRow(r.id);
  assert.strictEqual(after.namespace, 'project/acme');
  for (const k of Object.keys(before)) if (k !== 'namespace') assert.deepStrictEqual(after[k], before[k], `${k} is unchanged`);
  const ev = pwEvents().find((e) => e.key === `promote:${r.id}`);
  assert.ok(ev && ev.ok === 1 && ev.worker_id === 'w1' && ev.task_id === 't1' && ev.written_by === 'harness' && JSON.parse(ev.row_ids)[0] === r.id, JSON.stringify(ev));
});

test('the moved row is found by keyword in the project and no longer in the run', async () => {
  const r = seed({ row: { text: 'the ferry timetable is kept in the harbour notes' } });
  const find = async (ns) => (await call('memory.search', orch, { query: 'ferry timetable', mode: 'keyword', namespaces: [ns] })).results.map((x) => x.id);
  assert.deepStrictEqual(await find(`run/${RUN}`), [r.id]);
  await promote([r.id]);
  assert.deepStrictEqual(await find('project/acme'), [r.id]);
  assert.deepStrictEqual(await find(`run/${RUN}`), [], 'the old namespace no longer holds it');
});

test('the moved row is found by vector in the project (both namespace caches reload) and the project is bound to its model', async () => {
  const a = seed({ row: { text: 'vector row one', ...unit(1, 0) } });
  const sem = async (ns) => (await call('memory.search', orch, { query: 'anything', mode: 'semantic', namespaces: [ns] })).results.map((x) => x.id);
  assert.ok((await sem(`run/${RUN}`)).includes(a.id), 'loads the run cache first');
  await promote([a.id]);
  assert.deepStrictEqual({ ...store.p('SELECT embedding_model, dim FROM namespace_models WHERE namespace = ?').get('project/acme') }, { embedding_model: 'fake', dim: 2 });
  assert.ok((await sem('project/acme')).includes(a.id));
  assert.ok(!(await sem(`run/${RUN}`)).includes(a.id));
});

test('a row whose text already exists in the project stays, and the answer names the existing row', async () => {
  const text = 'duplicate text for the dedup collision';
  const there = await call('memory.store', orch, { namespace: 'project', text, embed: false });
  const r = seed({ row: { text } });
  const out = await promote([r.id]);
  assert.deepStrictEqual(out.moved, []);
  assert.deepStrictEqual(out.existing, [{ id: r.id, existing_id: there.id }]);
  assert.strictEqual(dbRow(r.id).namespace, `run/${RUN}`);
  assert.ok(!pwEvents().some((e) => e.key === `promote:${r.id}`), 'nothing moved, so no move event');
});

test('a project bound to another model refuses E_MODEL with an ok 0 event and the row stays', async () => {
  const other = 'r-pr-other';
  const oc = callerFor('orchestrator', { run_id: other });
  await call('run.attach', oc, { adapter_pid: process.pid, project: 'bound', memory_levers: JSON.stringify({ project: 'bound', project_writes: true }) });
  await call('memory.store', oc, { namespace: 'project', text: 'bound to another model', embedding: [0, 1, 0], embedding_model: 'elsewhere', embedding_revision: 'r', dim: 3 });
  const r = store.store({ namespace: `run/${other}`, worker_id: 'w1', written_by: 'worker:w1', task_id: 't1', run_id: other, source: 'model', text: 'worker fact for the bound project', ...unit(0, 1) });
  const out = await call('memory.promote', Object.freeze({ ...oc, channel: 'harness' }), { ids: [r.id], to: 'project', task_id: 't1', worker_id: 'w1' });
  assert.deepStrictEqual(out.moved, []);
  assert.strictEqual(out.refused.length, 1);
  assert.strictEqual(out.refused[0].code, 'E_MODEL');
  assert.strictEqual(dbRow(r.id).namespace, `run/${other}`);
  const ev = pwEvents().find((e) => e.key === `promote:${r.id}`);
  assert.ok(ev && ev.ok === 0 && ev.code === 'E_MODEL', JSON.stringify(ev));
});

test('at most 50 rows move per task, newest first, and the rest are counted in the answer and the events', async () => {
  const ids = [];
  for (let i = 0; i < 52; i += 1) ids.push(seed({ worker: 'w2', row: { task_id: 't2', created_at: 1000 + i, text: `capped row ${i} ${Math.random()}` } }).id);
  const out = await promote(ids, { task_id: 't2', worker_id: 'w2' });
  assert.strictEqual(out.moved.length, 50);
  assert.strictEqual(out.capped, 2);
  assert.deepStrictEqual(ids.slice(0, 2).map((id) => dbRow(id).namespace), [`run/${RUN}`, `run/${RUN}`], 'the two oldest stay');
  assert.ok(ids.slice(2).every((id) => dbRow(id).namespace === 'project/acme'));
  const ev = pwEvents().find((e) => e.key === `promote:${ids[51]}`);
  assert.match(ev.message, /2 more qualifying rows not moved \(cap 50\)/);
});

test('rows that do not qualify do not move, and each is named with its reason', async () => {
  const other = seed({ worker: 'w3' });
  const harnessRow = seed({ row: { written_by: 'harness', source: 'harness' } });
  const verified = seed(); store.setStatus(verified.id, { status: 'verified', receipt: 'test:x', by: 'orchestrator', at: Date.now() });
  const refuted = seed(); store.setStatus(refuted.id, { status: 'refuted', receipt: 'test:x', by: 'orchestrator', at: Date.now() });
  const old = seed({ worker: 'w3' }); store.store({ namespace: `run/${RUN}`, worker_id: 'w3', written_by: 'worker:w3', task_id: 't1', run_id: RUN, text: 'the replacement by another worker', supersedes: old.id });
  const expired = seed({ row: { ttl_seconds: -5 } });
  const wrongTask = seed({ row: { task_id: 't9' } });
  const elsewhere = seed({ row: { namespace: 'run/some-other-run' } });
  const legacy = seed({ row: { written_by: null } });
  const all = [other, harnessRow, verified, refuted, old, expired, wrongTask, elsewhere, legacy];
  const out = await promote([...all.map((r) => r.id), 'no-such-row']);
  assert.deepStrictEqual(out.moved, []);
  const reasons = Object.fromEntries(out.skipped.map((s) => [s.id, s.reason]));
  assert.match(reasons[other.id], /not written by this worker/);
  assert.match(reasons[harnessRow.id], /not written by this worker/);
  assert.match(reasons[verified.id], /verified/);
  assert.match(reasons[refuted.id], /refuted/);
  assert.match(reasons[old.id], /not written by this worker/);
  assert.match(reasons[expired.id], /expired/);
  assert.match(reasons[wrongTask.id], /not carrying this task/);
  assert.match(reasons[elsewhere.id], /namespace/);
  assert.match(reasons[legacy.id], /not written by this worker/);
  assert.match(reasons['no-such-row'], /no such row/);
  for (const r of all.filter((x) => x !== elsewhere)) assert.strictEqual(dbRow(r.id).namespace, `run/${RUN}`);
  assert.strictEqual(dbRow(elsewhere.id).namespace, 'run/some-other-run');
});

test('a supersede chain moves whole: the stale row does not come back in the run', async () => {
  const a = seed({ row: { text: 'chain A the ferry leaves at nine' } });
  const b = seed({ row: { text: 'chain B the ferry leaves at ten', supersedes: a.id } });
  const find = async (ns, q) => (await call('memory.search', orch, { query: q, mode: 'keyword', namespaces: [ns], include_superseded: true })).results.map((x) => x.id);
  const out = await promote([b.id]); // only the newest is named
  assert.deepStrictEqual(out.moved.map((m) => m.id).sort(), [a.id, b.id].sort());
  assert.deepStrictEqual(await find(`run/${RUN}`, 'the ferry leaves'), [], 'neither is left behind in the run');
  assert.deepStrictEqual((await find('project/acme', 'the ferry leaves')).sort(), [a.id, b.id].sort());
  const plain = (await call('memory.search', orch, { query: 'the ferry leaves', mode: 'keyword', namespaces: ['project/acme'] })).results.map((x) => x.id);
  assert.deepStrictEqual(plain, [b.id], 'A is still superseded by B in the project');
});

test('a chain with a member that cannot move moves none of it, and says why', async () => {
  const a = seed({ row: { text: 'chain2 A first claim' } });
  store.setStatus(a.id, { status: 'verified', receipt: 'test:x', by: 'orchestrator', at: Date.now() });
  const b = seed({ row: { text: 'chain2 B second claim', supersedes: a.id } });
  const out = await promote([b.id]);
  assert.deepStrictEqual(out.moved, []);
  assert.match(out.skipped.find((s) => s.id === b.id).reason, /supersede chain stays whole: .* cannot move .the row is verified./);
  assert.strictEqual(dbRow(b.id).namespace, `run/${RUN}`);
  // a dedup collision on one member keeps the chain whole too
  const c = seed({ row: { text: 'chain3 A shared text with the project' } });
  const d = seed({ row: { text: 'chain3 B newer', supersedes: c.id } });
  await call('memory.store', orch, { namespace: 'project', text: 'chain3 A shared text with the project', embed: false });
  const out2 = await promote([d.id]);
  assert.deepStrictEqual(out2.moved, []);
  assert.strictEqual(out2.existing.length, 1);
  assert.strictEqual(dbRow(d.id).namespace, `run/${RUN}`);
});

test('the move and its event are one transaction: a failing event rolls the move back', async () => {
  const r = seed();
  store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON memory_event WHEN NEW.key = 'promote:" + r.id + "' BEGIN SELECT RAISE(ABORT, 'event refused'); END");
  try {
    await assert.rejects(() => promote([r.id]), /event refused/);
    assert.strictEqual(dbRow(r.id).namespace, `run/${RUN}`, 'no move without its receipt');
  } finally { store.db.exec('DROP TRIGGER fail_event'); }
});

test('a caller with no run is refused', async () => {
  await assert.rejects(() => call('memory.promote', callerFor('operator'), { ids: ['x'], to: 'project', task_id: 't1', worker_id: 'w1' }), { code: 'E_ARGS' });
});

test('a worker cannot call it', async () => {
  const r = seed();
  const w = callerFor('worker', { run_id: RUN, worker_id: 'w1' });
  await assert.rejects(() => call('memory.promote', w, { ids: [r.id], to: 'project', task_id: 't1', worker_id: 'w1' }), { code: 'E_ROLE' });
  assert.strictEqual(dbRow(r.id).namespace, `run/${RUN}`);
});

test('the operator may call it; a run with no project, or with project_writes off, may not', async () => {
  const r = seed();
  const op = callerFor('operator', { run_id: RUN });
  assert.strictEqual((await call('memory.promote', op, { ids: [r.id], to: 'project', task_id: 't1', worker_id: 'w1' })).moved.length, 1);
  const args = { ids: ['x'], to: 'project', task_id: 't1', worker_id: 'w1' };
  await assert.rejects(() => call('memory.promote', none, args), { code: 'E_ARGS' });
  await assert.rejects(() => call('memory.promote', off, args), { code: 'E_LEVER_OFF' });
});

test('its arguments are checked', async () => {
  const base = { ids: ['x'], to: 'project', task_id: 't1', worker_id: 'w1' };
  for (const bad of [{ to: 'run' }, { ids: [] }, { ids: 'x' }, { ids: [1] }, { task_id: undefined }, { worker_id: '' }]) {
    await assert.rejects(() => call('memory.promote', harness, { ...base, ...bad }), { code: 'E_ARGS' }, JSON.stringify(bad));
  }
});
