'use strict';
// evaluate-gates.test.cjs — task.evaluate honours the same two gates task.assign does: a task whose
// dependency is not done is refused E_DEPENDENCY_OPEN, and a task that is already done is refused
// E_TASK_DONE. Both refuse before any command runs and write nothing. Real core, sandbox store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, judge;
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const FAIL = { commands: [{ argv: [process.execPath, '-e', 'process.exit(1)'], timeout_ms: 20000 }] };
// A command that leaves a marker file, so a test can prove no command ran.
const marker = (name) => ({ commands: [{ argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(path.join(dir, name).split(path.sep).join('/'))},'ran')`], timeout_ms: 20000 }] });

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: 'judge-g', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-judge-g', last_event_at: Date.now() });
  judge = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'judge-g' }), embed: false });
});

after(async () => {
  await judge.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

const rejects = async (p, code, re) => {
  let got;
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    got = e;
    return true;
  });
  return got;
};

test('A2: a task with an open dependency is refused, the dependency named, nothing run and nothing written', async () => {
  const dep = await orch.task.create({ spec: 'g1 dep' });
  const t = await orch.task.create({ spec: 'g1 dependent', depends_on: [dep.id], acceptance: marker('g1.txt') });
  const before = await orch.task.get({ task_id: t.id });
  const e = await rejects(orch.task.evaluate({ task_id: t.id, worktree: dir }), 'E_DEPENDENCY_OPEN', new RegExp(dep.id));
  assert.strictEqual(e.detail.blocked_by, dep.id);
  assert.strictEqual(e.detail.dependency_state, 'open');
  assert.strictEqual(fs.existsSync(path.join(dir, 'g1.txt')), false, 'the acceptance command must not run');
  assert.deepStrictEqual(await orch.task.get({ task_id: t.id }), before);
});

test('A2: once the dependency is done the same task evaluates to done', async () => {
  const dep = await orch.task.create({ spec: 'g2 dep', acceptance: PASS });
  const t = await orch.task.create({ spec: 'g2 dependent', depends_on: [dep.id], acceptance: PASS });
  await rejects(orch.task.evaluate({ task_id: t.id, worktree: dir }), 'E_DEPENDENCY_OPEN');
  assert.strictEqual((await orch.task.evaluate({ task_id: dep.id, worktree: dir })).state, 'done');
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id, worktree: dir })).state, 'done');
});

test('A2: a refuted-review dependency is refused as a refuted review', async () => {
  const work = await orch.task.create({ spec: 'g3 work', acceptance: PASS });
  await orch.task.evaluate({ task_id: work.id, worktree: dir });
  const review = await orch.task.create({ spec: 'g3 review', depends_on: [work.id], acceptance: { verdict: true } });
  const fixBad = await orch.task.create({ spec: 'g3 fix on the review', depends_on: [review.id], acceptance: PASS });
  const a = await orch.task.assign({ task_id: review.id, worker_id: 'judge-g' });
  await judge.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict: 'refuted', summary: 'wrong', findings: ['f'] } });
  assert.notStrictEqual((await orch.task.evaluate({ task_id: review.id, worktree: dir })).state, 'done');
  const before = await orch.task.get({ task_id: fixBad.id });
  const e = await rejects(orch.task.evaluate({ task_id: fixBad.id, worktree: dir }), 'E_DEPENDENCY_OPEN', /a review whose last evaluation returned refuted/);
  assert.strictEqual(e.detail.dependency_verdict, 'refuted');
  assert.strictEqual(e.detail.blocked_by, review.id);
  assert.deepStrictEqual(await orch.task.get({ task_id: fixBad.id }), before);
});

test('A4: evaluating a done task is refused E_TASK_DONE and its results stay byte-identical', async () => {
  const t = await orch.task.create({ spec: 'g5', acceptance: PASS });
  const done = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  assert.strictEqual(done.state, 'done');
  const before = JSON.stringify(await orch.task.get({ task_id: t.id }));
  const e = await rejects(orch.task.evaluate({ task_id: t.id, worktree: dir }), 'E_TASK_DONE', /done is final; create a new task to redo the work/);
  assert.strictEqual(e.detail.task_id, t.id);
  assert.strictEqual(JSON.stringify(await orch.task.get({ task_id: t.id })), before);
});

test('A4: a done task is refused before its commands run', async () => {
  const t = await orch.task.create({ spec: 'g6', acceptance: marker('g6.txt') });
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id, worktree: dir })).state, 'done');
  fs.unlinkSync(path.join(dir, 'g6.txt'));
  await rejects(orch.task.evaluate({ task_id: t.id, worktree: dir }), 'E_TASK_DONE');
  assert.strictEqual(fs.existsSync(path.join(dir, 'g6.txt')), false);
});

test('a not-done task still records a failing result and stays open (re-evaluation before done is unchanged)', async () => {
  const t = await orch.task.create({ spec: 'g7', acceptance: FAIL });
  const r1 = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  assert.strictEqual(r1.state, 'open');
  assert.strictEqual(r1.results.passed, false);
  const r2 = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  assert.strictEqual(r2.state, 'open');
});

test('A4: two concurrent evaluates of one task: one done, one E_TASK_DONE, exactly one done row (the in-transaction gate)', async () => {
  const go = path.join(dir, 'g8.go').split(path.sep).join('/');
  const started = (n) => path.join(dir, `g8.${n}.started`).split(path.sep).join('/');
  // Each run writes its own started marker (the first free name), then waits for the go-file.
  const script = `const fs=require('fs');const d=${JSON.stringify(dir.split(path.sep).join('/'))};`
    + `const n=fs.existsSync(d+'/g8.1.started')?2:1;fs.writeFileSync(d+'/g8.'+n+'.started','x');`
    + `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})){clearInterval(t);process.exit(0);}},20);`;
  const t = await orch.task.create({ spec: 'g8', acceptance: { commands: [{ argv: [process.execPath, '-e', script], timeout_ms: 60000 }] } });
  const a = orch.task.evaluate({ task_id: t.id, worktree: dir }).then((v) => ({ v }), (e) => ({ e }));
  const b = orch.task.evaluate({ task_id: t.id, worktree: dir }).then((v) => ({ v }), (e) => ({ e }));
  const deadline = Date.now() + 30000;
  while (!(fs.existsSync(started(1)) && fs.existsSync(started(2)))) {
    assert.ok(Date.now() < deadline, 'both commands must start');
    await new Promise((r) => setTimeout(r, 20));
  }
  fs.writeFileSync(go, 'go');
  const out = await Promise.all([a, b]);
  const ok = out.filter((o) => o.v), bad = out.filter((o) => o.e);
  assert.strictEqual(ok.length, 1, JSON.stringify(out.map((o) => o.e && o.e.code)));
  assert.strictEqual(ok[0].v.state, 'done');
  assert.strictEqual(bad.length, 1);
  assert.strictEqual(bad[0].e.code, 'E_TASK_DONE');
  const final = await orch.task.get({ task_id: t.id });
  assert.strictEqual(final.state, 'done');
  assert.strictEqual(final.seq, ok[0].v.seq, 'no later row was written over the done row');
});
