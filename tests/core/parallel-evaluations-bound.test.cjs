'use strict';
// parallel-evaluations-bound.test.cjs — the queue wait of max_parallel_evaluations has its own bound: a call that reaches it is refused
// E_BUSY { queued: true } with nothing run and nothing written, and wait plus run fits the command budget. An integration takes its slot
// before it merges, so a refusal leaves the branch where it was; amend names a queued evaluation as waiting; a re-run is a span.
// The bound is shortened through EC.WAIT and met by the queue's own rejection, never a sleep.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, commit, write, git, rejectsCode } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const EC = require('../../src/core/evaluate-cancel.cjs');
const { ACCEPTANCE_BUDGET_MS } = require('../../src/core/evaluate.cjs');
const fwd = (p) => p.split(path.sep).join('/');
const tick = () => new Promise((r) => setImmediate(r));
const until = async (fn) => { while (!fn()) await tick(); };

let dir, orch, op, n = 0;
const keep = EC.WAIT.maxMs;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  op = await openCore({ dataDir: `${dir}/data`, caller: { role: 'operator', run_id: 'cli', pid: process.pid }, embed: false });
  await orch.run.attach({ adapter_pid: process.pid, max_parallel_evaluations: 1 });
});

after(async () => {
  EC.WAIT.maxMs = keep;
  await op.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function gatedTask() {
  const name = `b${++n}`;
  const started = fwd(path.join(dir, `${name}-started`)), gate = fwd(path.join(dir, `${name}-gate`));
  const argv = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(started)}, ''); const t = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) clearInterval(t); }, 20);`];
  const t = await orch.task.create({ spec: name, acceptance: { commands: [{ argv, timeout_ms: 60000 }] } });
  return { id: t.id, evaluate: (extra = {}) => orch.task.evaluate({ task_id: t.id, worktree: dir, ...extra }), started: () => fs.existsSync(started), open: () => fs.writeFileSync(gate, '') };
}

test('a release evaluation has no wait bound and keeps its whole budget; the client call carries its own long bound', () => {
  assert.strictEqual(EC.budgetAfter(EC.WAIT.maxMs * 10, ACCEPTANCE_BUDGET_MS, 'release'), ACCEPTANCE_BUDGET_MS);
  assert.ok(EC.budgetAfter(EC.WAIT.maxMs, ACCEPTANCE_BUDGET_MS, null) < ACCEPTANCE_BUDGET_MS, 'a called evaluation still spends its wait');
  const L = require('../../src/core/call-limits.cjs');
  assert.strictEqual(L.writeTimeoutFor('task.evaluate', { trigger: 'release' }), L.RELEASE_EVALUATE_TIMEOUT_MS);
  assert.strictEqual(L.writeTimeoutFor('task.evaluate', {}), L.EVALUATE_TIMEOUT_MS);
  assert.ok(L.RELEASE_EVALUATE_TIMEOUT_MS > L.EVALUATE_TIMEOUT_MS && L.RELEASE_EVALUATE_TIMEOUT_MS < 2 ** 31);
});

test('a queued release evaluation past the bound is not refused: it takes its slot, runs, and records the wait', async () => {
  const a = await gatedTask(), b = await gatedTask();
  const ra = a.evaluate();
  await until(() => a.started());
  EC.WAIT.maxMs = 1; // the bound that refuses a called evaluation
  let rb;
  try {
    rb = b.evaluate({ trigger: 'release' });
    await until(() => EC.GATE.waiting.length === 1);
    const w = EC.GATE.waiting[0];
    assert.strictEqual(w.timer, undefined, 'no refusal timer was armed for it');
    await tick(); await tick();
    assert.strictEqual(EC.GATE.waiting.length, 1, 'still waiting past the bound');
  } finally { EC.WAIT.maxMs = keep; }
  assert.ok(!b.started());
  a.open();
  assert.strictEqual((await ra).state, 'done');
  await until(() => b.started());
  b.open();
  const row = await rb;
  assert.strictEqual(row.state, 'done');
  assert.deepStrictEqual([row.results.queued.ahead, Number.isFinite(row.results.queued.waited_ms)], [1, true]);
  assert.strictEqual(EC.GATE.active, 0);
});

test('wait plus run stays inside the command budget, whatever the wait', () => {
  assert.ok(EC.WAIT.maxMs + EC.budgetAfter(EC.WAIT.maxMs, ACCEPTANCE_BUDGET_MS) <= ACCEPTANCE_BUDGET_MS);
  assert.ok(EC.budgetAfter(EC.WAIT.maxMs, ACCEPTANCE_BUDGET_MS) > 0, 'a call that waited the whole bound still has time to run');
  assert.strictEqual(EC.budgetAfter(null, ACCEPTANCE_BUDGET_MS), ACCEPTANCE_BUDGET_MS);
  assert.strictEqual(EC.budgetAfter(ACCEPTANCE_BUDGET_MS + 5, ACCEPTANCE_BUDGET_MS), 0);
});

test('a queued evaluation that reaches the bound is refused E_BUSY queued, ran nothing and wrote nothing', async () => {
  const a = await gatedTask(), b = await gatedTask();
  const ra = a.evaluate();
  await until(() => a.started());
  EC.WAIT.maxMs = 1;
  try {
    const e = await rejectsCode(b.evaluate(), 'E_BUSY');
    assert.deepStrictEqual([e.detail.op, e.detail.queued, e.detail.ahead, e.detail.task_id], ['evaluate', true, 1, b.id]);
    assert.ok(Number.isFinite(e.detail.waited_ms));
    assert.match(e.message, /Call it again once the running evaluations have finished/);
  } finally { EC.WAIT.maxMs = keep; }
  assert.strictEqual(EC.GATE.waiting.length, 0, 'it left the queue');
  assert.ok(!b.started(), 'its command never ran');
  assert.strictEqual((await orch.task.get({ task_id: b.id })).results, null, 'and nothing was written');
  a.open();
  assert.strictEqual((await ra).state, 'done');
  assert.strictEqual(EC.GATE.active, 0);
});

test('amend names an evaluation waiting for a slot, and refuses it', async () => {
  const a = await gatedTask(), b = await gatedTask();
  const ra = a.evaluate();
  await until(() => a.started());
  const rb = b.evaluate();
  await until(() => EC.GATE.waiting.length === 1);
  const e = await rejectsCode(orch.task.create({ id: b.id, amend: true, acceptance: { commands: [{ argv: [process.execPath, '-e', '0'] }] } }), 'E_BUSY');
  assert.deepStrictEqual([e.detail.queued, e.detail.ahead], [true, 1]);
  assert.match(e.message, /waiting for a slot behind 1 other/);
  assert.doesNotMatch(e.message, /amend it again/);
  a.open();
  await ra;
  await until(() => b.started());
  b.open();
  assert.strictEqual((await rb).state, 'done');
});

test('an integration refused at the bound leaves the branch head unchanged and holds no lock', async () => {
  const repo = makeRepo(dir);
  const t = await orch.task.create({ spec: 'int', acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const w = (await op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
  write(w.path, 'i.txt', 'i\n');
  commit(w.path, 'task int');
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
  const into = 'belay/integrate/bound-test';
  const hold = await gatedTask();
  const rh = hold.evaluate();
  await until(() => hold.started());
  EC.WAIT.maxMs = 1;
  let e;
  try { e = await rejectsCode(orch.integration.merge({ task_ids: [t.id], into }), 'E_BUSY'); } finally { EC.WAIT.maxMs = keep; }
  assert.strictEqual(e.detail.queued, true);
  assert.strictEqual(git(repo, 'branch', '--list', into).trim(), '', 'no branch was made, so nothing merged');
  assert.deepStrictEqual((await orch.integration.list({})).integrations.filter((r) => r.into_branch === into), [], 'and no row was written');
  hold.open();
  await rh;
  const row = await orch.integration.merge({ task_ids: [t.id], into }); // the lock was never taken: the next call goes through
  assert.strictEqual(row.passed, true);
  assert.ok(git(repo, 'rev-parse', into).trim());
  assert.strictEqual(EC.GATE.active, 0);
});

test('a span begun for an integration re-run is named by an evaluation that overlapped it', () => {
  const end = EC.beginSpan('integration x');
  const seen = EC.during('someone-else', Date.now() - 1, Date.now() + 5);
  end();
  assert.ok(seen.some((s) => s.task_id === 'integration x'));
});
