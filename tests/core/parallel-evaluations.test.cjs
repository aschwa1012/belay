'use strict';
// parallel-evaluations.test.cjs — the run lever max_parallel_evaluations: at most N task evaluations (release-time, called, and an
// integration re-run) run at once in the owner; the rest wait in arrival order, are answered when they run, can be cancelled while
// they wait, and join or are refused exactly as a running one would. Unset runs everything at once. Real core, a sandbox store;
// every command waits on a file the test writes, and the test waits on the gate's own queue, never on a clock.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, commit, write, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const EC = require('../../src/core/evaluate-cancel.cjs');
const fwd = (p) => p.split(path.sep).join('/');
const tick = () => new Promise((r) => setImmediate(r));
const until = async (fn) => { while (!fn()) await tick(); };

let dir, orch, op, n = 0;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  await attach(null);
});

after(async () => {
  await op.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

const attach = (limit) => orch.run.attach({ adapter_pid: process.pid, max_parallel_evaluations: limit });

// A task whose one command writes `<name>-started`, then waits until the test writes `<name>-gate`.
async function gatedTask() {
  const name = `g${++n}`;
  const started = fwd(path.join(dir, `${name}-started`)), gate = fwd(path.join(dir, `${name}-gate`));
  const argv = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(started)}, ''); const t = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) clearInterval(t); }, 20);`];
  const t = await orch.task.create({ spec: name, acceptance: { commands: [{ argv, timeout_ms: 60000 }] } });
  return {
    id: t.id,
    evaluate: (extra = {}) => orch.task.evaluate({ task_id: t.id, worktree: dir, ...extra }),
    started: () => fs.existsSync(started),
    open: () => fs.writeFileSync(gate, ''),
  };
}

test('unset: every evaluation runs at once, and none is marked queued', async () => {
  const a = await gatedTask(), b = await gatedTask();
  const ra = a.evaluate(), rb = b.evaluate();
  await until(() => a.started() && b.started()); // both run before either gate opens
  a.open(); b.open();
  const rows = await Promise.all([ra, rb]);
  assert.ok(rows.every((r) => r.results.queued === undefined));
  assert.strictEqual(EC.GATE.active, 0);
});

test('N=1: evaluations run one at a time in arrival order, and a queued one is answered when it runs', async () => {
  await attach(1);
  const a = await gatedTask(), b = await gatedTask(), c = await gatedTask();
  const ra = a.evaluate();
  await until(() => a.started());
  const rb = b.evaluate(), rc = c.evaluate();
  await until(() => EC.GATE.waiting.length === 2);
  assert.ok(!b.started() && !c.started(), 'both wait while the first runs');
  a.open();
  const rowA = await ra;
  await until(() => b.started());
  assert.ok(!c.started(), 'the second runs before the third: first in, first out');
  b.open();
  const rowB = await rb;
  await until(() => c.started());
  c.open();
  const rowC = await rc;
  assert.strictEqual(rowA.results.queued, undefined);
  assert.deepStrictEqual([rowB.results.queued.ahead, rowC.results.queued.ahead], [1, 2], 'each says how many were ahead of it');
  assert.ok(rowB.results.queued.waited_ms >= 0);
  assert.deepStrictEqual([rowA.state, rowB.state, rowC.state], ['done', 'done', 'done']);
  assert.strictEqual(EC.GATE.active, 0);
});

test('N=2: two run together and the third waits for one of them', async () => {
  await attach(2);
  const a = await gatedTask(), b = await gatedTask(), c = await gatedTask();
  const ra = a.evaluate(), rb = b.evaluate();
  await until(() => a.started() && b.started());
  const rc = c.evaluate();
  await until(() => EC.GATE.waiting.length === 1);
  assert.ok(!c.started());
  b.open();
  await rb;
  await until(() => c.started());
  a.open(); c.open();
  const [rowA, rowC] = await Promise.all([ra, rc]);
  assert.deepStrictEqual([rowA.results.queued, rowC.results.queued.ahead], [undefined, 2]);
});

test('a second call for a queued task and tree joins it; another tree is refused E_BUSY naming it', async () => {
  await attach(1);
  const a = await gatedTask(), b = await gatedTask();
  const ra = a.evaluate();
  await until(() => a.started());
  const rb = b.evaluate();
  await until(() => EC.GATE.waiting.length === 1);
  const joined = b.evaluate(); // same task, same tree: joins the queued evaluation, queues nothing of its own
  const refused = await rejectsCode(orch.task.evaluate({ task_id: b.id, worktree: path.join(dir, 'elsewhere') }), 'E_BUSY');
  assert.strictEqual(refused.detail.op, 'evaluate');
  assert.strictEqual(EC.GATE.waiting.length, 1);
  a.open();
  await ra;
  await until(() => b.started());
  b.open();
  const [first, second] = [await rb, await joined];
  assert.strictEqual(second.joined_evaluation, true);
  assert.strictEqual(second.id, first.id);
});

test('a cancel of a queued evaluation takes it out of the queue: it runs nothing and ends cancelled', async () => {
  await attach(1);
  const a = await gatedTask(), b = await gatedTask(), c = await gatedTask();
  const ra = a.evaluate();
  await until(() => a.started());
  const rb = b.evaluate({ cancel_key: 'queued-cancel-b' });
  const rc = c.evaluate();
  await until(() => EC.GATE.waiting.length === 2);
  const out = await orch.task.evaluateCancel({ cancel_key: 'queued-cancel-b', by: 'test' });
  assert.deepStrictEqual([out.cancelled, out.queued], [true, true]);
  const e = await rejectsCode(rb, 'E_BUSY');
  assert.strictEqual(e.detail.cancelled, true);
  assert.strictEqual(EC.GATE.waiting.length, 1, 'only the third still waits');
  a.open();
  await ra;
  await until(() => c.started());
  c.open();
  assert.strictEqual((await rc).state, 'done');
  assert.ok(!b.started(), 'the cancelled evaluation never ran its command');
  assert.strictEqual((await orch.task.get({ task_id: b.id })).results, null, 'and wrote nothing');
});

test('an integration re-run counts toward N: it waits for a free slot', async () => {
  await attach(1);
  const repo = makeRepo(dir);
  const t = await orch.task.create({ spec: 'int', acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, 'i.txt', 'i\n');
  commit(w.path, 'task int');
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  const hold = await gatedTask();
  const rh = hold.evaluate();
  await until(() => hold.started());
  const merging = orch.integration.merge({ task_ids: [t.id] });
  await until(() => EC.GATE.waiting.length === 1); // the integration waits for its slot before it merges anything, behind the evaluation
  hold.open();
  await rh;
  const row = await merging;
  assert.strictEqual(row.passed, true);
  assert.strictEqual(EC.GATE.active, 0);
});

test('run.attach refuses a limit that is not a positive integer', async () => {
  for (const bad of [0, -1, 1.5, '2', NaN]) await rejectsCode(attach(bad), 'E_ARGS');
  await attach(null);
});
