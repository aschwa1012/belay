'use strict';
// handoff-required.test.cjs — lease.release refuses a result that lacks a field the task's acceptance.handoff.required declares,
// writes nothing, and names the fields; the evaluation's handoff check judges "carries" by the same function. Real core, sandbox store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, operator;
const workers = new Map();
const REQ = { handoff: { required: ['head', 'tests', 'summary'] } };

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
});
after(async () => {
  for (const c of workers.values()) await c.close();
  await operator.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function worker(id) {
  if (workers.has(id)) return workers.get(id);
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now() });
  const c = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.set(id, c);
  return c;
}
async function start(label, acceptance = REQ, extra = {}) {
  const t = await orch.task.create({ spec: label, acceptance, ...extra });
  const w = await worker(`w-${label}`);
  const a = await orch.task.assign({ task_id: t.id, worker_id: `w-${label}` });
  return { t, w, lease: a.new_lease.id };
}
const refused = (p, missing) => assert.rejects(p, (e) => {
  assert.strictEqual(e.code, 'E_ARGS');
  assert.deepStrictEqual(e.detail.missing, missing);
  for (const k of e.detail.required) assert.ok(e.message.includes(k));
  for (const k of missing) assert.ok(e.message.includes(k));
  return true;
});

test('a release lacking required fields is refused naming them, nothing is written, and the same lease then releases', async () => {
  const { t, w, lease } = await start('a');
  const before = await orch.task.get({ task_id: t.id });
  await refused(w.lease.release({ lease_id: lease, result: { head: 'abc', tests: '' } }), ['tests', 'summary']);
  await refused(w.lease.release({ lease_id: lease, result: { head: 'abc', tests: [], summary: '  ' } }), ['tests', 'summary']);
  await refused(w.lease.release({ lease_id: lease }), ['head', 'tests', 'summary']);
  const after = await orch.task.get({ task_id: t.id });
  assert.strictEqual(after.state, 'assigned');
  assert.strictEqual(after.handoff ?? null, before.handoff ?? null);
  const row = await w.lease.release({ lease_id: lease, result: { head: 'abc', tests: { pass: 1 }, summary: 's', extra: 1 } });
  assert.strictEqual(row.state, 'released');
});

test('a stand-down (no result, a reason) releases; an empty reason does not', async () => {
  const { w, lease } = await start('b');
  await refused(w.lease.release({ lease_id: lease, reason: ' ' }), ['head', 'tests', 'summary']);
  assert.strictEqual((await w.lease.release({ lease_id: lease, reason: 'blocked on the build' })).state, 'released');
});

test('a task with no required fields, and a verdict task without them, release as before; with them a review is held to them too', async () => {
  const { w, lease } = await start('c', { verdict: true });
  assert.strictEqual((await w.lease.release({ lease_id: lease, result: { verdict: 'holds', summary: 's' } })).state, 'released');
  const r = await start('d', { verdict: true, handoff: { required: ['verdict', 'summary'] } });
  await refused(r.w.lease.release({ lease_id: r.lease, result: { verdict: 'holds' } }), ['summary']);
  assert.strictEqual((await r.w.lease.release({ lease_id: r.lease, result: { verdict: 'holds', summary: 's' } })).state, 'released');
});

test("the operator's release hands nothing back and is not held to the fields", async () => {
  const { t } = await start('e');
  const taken = await operator.lease.takeControl({ task_id: t.id });
  assert.strictEqual((await operator.lease.release({ lease_id: taken.new_lease.id })).state, 'released');
});

test('the evaluation and the release agree: a result the release accepts passes the handoff check', async () => {
  const { t, w, lease } = await start('f');
  await w.lease.release({ lease_id: lease, result: { head: 'abc', tests: ['t'], summary: 's' } });
  const ev = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  const c = ev.results.checks.find((x) => x.kind === 'handoff');
  assert.strictEqual(c.passed, true);
  assert.deepStrictEqual(c.detail.missing, []);
});

test('a stand-down is recorded: the reason on the lease and the task, replacing an earlier hand-back', async () => {
  const { t, w, lease } = await start('g');
  await w.lease.release({ lease_id: lease, result: { head: 'abc', tests: ['t'], summary: 's' } });
  const a2 = await orch.task.assign({ task_id: t.id, worker_id: 'w-g' });
  const row = await w.lease.release({ lease_id: a2.new_lease.id, reason: 'cannot build on this host' });
  assert.deepStrictEqual([row.state, row.handoff.result, row.handoff.stood_down, row.handoff.lease_id], ['released', null, 'cannot build on this host', a2.new_lease.id]);
  assert.strictEqual(row.released_reason, 'cannot build on this host');
  const V = require('../../src/mcp/views.cjs');
  const view = V.compactTask ? V.compactTask(await orch.task.get({ task_id: t.id })) : null;
  if (view) assert.strictEqual(view.handoff.stood_down, 'cannot build on this host');
});

test('a refused late hand-back leaves the task open', async () => {
  const { t, w, lease } = await start('h');
  await orch.worker.write({ id: 'w-h', substrate: 'claude-code', pid: process.pid, state: 'dead', session_id: 's-w-h', last_event_at: Date.now() });
  const before = (await orch.task.get({ task_id: t.id })).state;
  await refused(w.lease.release({ lease_id: lease, result: { head: 'abc' } }), ['tests', 'summary']);
  assert.strictEqual((await orch.task.get({ task_id: t.id })).state, before);
});
