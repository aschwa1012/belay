'use strict';
// handoff-verdict.test.cjs — build step W2-1, ADR 0025. A worker hands a structured result back on
// lease.release (the task row's `handoff`), and a review task is judged from it by task.evaluate's
// `verdict` check. Everything runs through the real core against a sandbox store, as methods.test.cjs does.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, operator;
const workers = new Map();
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const FAIL = { commands: [{ argv: [process.execPath, '-e', 'process.exit(3)'], timeout_ms: 20000 }] };

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

// A live worker row and a core that speaks as that worker (identity from the caller, as from argv).
async function worker(id) {
  if (workers.has(id)) return workers.get(id);
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now() });
  const c = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.set(id, c);
  return c;
}

const rejects = async (p, code, re) => {
  await assert.rejects(p, (e) => {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (re) assert.match(e.message, re);
    return true;
  });
};

// assign -> worker releases (with result when given). Returns the released task row and the lease id.
async function handBack(taskId, workerId, result) {
  const w = await worker(workerId);
  const a = await orch.task.assign({ task_id: taskId, worker_id: workerId });
  const args = { lease_id: a.new_lease.id, reason: 'done' };
  if (result !== undefined) args.result = result;
  return { row: await w.lease.release(args), lease_id: a.new_lease.id };
}

// A coder task T that reached done, and a review task R over it, ready to be assigned.
async function doneTaskAndReview(label, reviewAcceptance = { verdict: true }) {
  const t = await orch.task.create({ spec: `${label} work`, acceptance: PASS });
  await handBack(t.id, `coder-${label}`);
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id, worktree: dir })).state, 'done');
  const r = await orch.task.create({ spec: `${label} review`, depends_on: [t.id], acceptance: reviewAcceptance });
  return { t, r };
}

const byKind = (row, kind) => row.results.checks.find((c) => c.kind === kind);

test('release: a worker\'s result is written to the task row as handoff with by, lease_id and at', async () => {
  const t = await orch.task.create({ spec: 'v1 work' });
  const result = { branch: 'step/v1', head: 'abc123', tests: { pass: 3, fail: 0 } };
  const before = Date.now();
  const { row, lease_id } = await handBack(t.id, 'coder-v1', result);
  assert.strictEqual(row.state, 'released');
  assert.deepStrictEqual(row.handoff.result, result);
  assert.strictEqual(row.handoff.by, 'coder-v1');
  assert.strictEqual(row.handoff.lease_id, lease_id);
  assert.ok(row.handoff.at >= before && row.handoff.at <= Date.now());
  assert.deepStrictEqual((await orch.task.get({ task_id: t.id })).handoff, row.handoff, 'the stored row says the same');
});

test('release: a result over 4096 bytes, an array, or from the operator is refused E_ARGS and nothing is written', async () => {
  const t = await orch.task.create({ spec: 'v2 work' });
  const w = await worker('coder-v2');
  const a = await orch.task.assign({ task_id: t.id, worker_id: 'coder-v2' });
  const seqBefore = (await orch.task.get({ task_id: t.id })).seq;

  const big = { blob: 'x'.repeat(5000) };
  await rejects(w.lease.release({ lease_id: a.new_lease.id, result: big }), 'E_ARGS', /\d+ bytes.*4096/);
  const edge = { blob: 'x'.repeat(4096 - JSON.stringify({ blob: '' }).length) };
  assert.strictEqual(Buffer.byteLength(JSON.stringify(edge)), 4096);
  await rejects(w.lease.release({ lease_id: a.new_lease.id, result: { ...edge, more: 1 } }), 'E_ARGS', /4096/);
  await rejects(w.lease.release({ lease_id: a.new_lease.id, result: ['verdict'] }), 'E_ARGS', /plain JSON object/);
  await rejects(w.lease.release({ lease_id: a.new_lease.id, result: 'holds' }), 'E_ARGS', /plain JSON object/);
  await rejects(w.lease.release({ lease_id: a.new_lease.id, result: null }), 'E_ARGS', /plain JSON object/);
  await rejects(operator.lease.release({ lease_id: a.new_lease.id, result: { verdict: 'holds', summary: 'x' } }), 'E_ARGS', /operator/);

  const now = await orch.task.get({ task_id: t.id });
  assert.strictEqual(now.seq, seqBefore, 'no task row was appended');
  assert.strictEqual(now.state, 'assigned');
  assert.strictEqual(now.handoff, null);
  assert.strictEqual(now.lease.id, a.new_lease.id, 'the lease is still held');
  assert.strictEqual(now.lease.holder, 'coder-v2');

  // exactly at the limit is accepted
  const ok = await w.lease.release({ lease_id: a.new_lease.id, result: edge });
  assert.strictEqual(ok.handoff.result.blob.length, edge.blob.length);
});

test('release: a release without result keeps an earlier handoff', async () => {
  const t = await orch.task.create({ spec: 'v3 work' });
  const first = await handBack(t.id, 'coder-v3', { head: 'first' });
  const second = await handBack(t.id, 'coder-v3b', undefined);
  assert.deepStrictEqual(second.row.handoff, first.row.handoff, 'the later release without a result left the handoff alone');
  const op = await orch.task.assign({ task_id: t.id, worker_id: 'coder-v3' });
  const released = await operator.lease.release({ lease_id: op.new_lease.id });
  assert.deepStrictEqual(released.handoff, first.row.handoff, 'an operator release without a result leaves it too');
  const replaced = await handBack(t.id, 'coder-v3', { head: 'second' });
  assert.deepStrictEqual(replaced.row.handoff.result, { head: 'second' }, 'only a later release that carries a result replaces it');
  assert.strictEqual(replaced.row.handoff.lease_id, replaced.lease_id);
});

test('handoff: an assign, then evaluate, then take-control carry handoff forward unchanged', async () => {
  const t = await orch.task.create({ spec: 'v4 work', acceptance: PASS });
  const { row } = await handBack(t.id, 'coder-v4', { head: 'keep' });
  assert.ok(row.handoff, 'the precondition: the release wrote a handoff');
  assert.deepStrictEqual(row.handoff.result, { head: 'keep' });
  // F1: a done task is not reassigned (E_TASK_DONE), so the assign is checked before the evaluate.
  const as = await orch.task.assign({ task_id: t.id, worker_id: 'coder-v4' });
  assert.deepStrictEqual(as.task.handoff, row.handoff);
  const ev = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  assert.strictEqual(ev.state, 'done');
  assert.deepStrictEqual(ev.handoff, row.handoff);
  const tc = await operator.lease.takeControl({ task_id: t.id });
  assert.ok(tc.new_lease);
  assert.deepStrictEqual((await orch.task.get({ task_id: t.id })).handoff, row.handoff);
});

test('verdict: a holds verdict from a worker who never held the dependency passes, and done clears the dependent\'s assign', async () => {
  const { t, r } = await doneTaskAndReview('v5');
  const next = await orch.task.create({ spec: 'v5 next', depends_on: [r.id] });
  await worker('judge-v5');
  const { row, lease_id } = await handBack(r.id, 'judge-v5', { verdict: 'holds', summary: 'read every touched file; the change does what the brief says', findings: [] });
  assert.strictEqual(row.state, 'released');

  await rejects(orch.task.assign({ task_id: next.id, worker_id: 'judge-v5' }), 'E_DEPENDENCY_OPEN');
  const ev = await orch.task.evaluate({ task_id: r.id, worktree: dir });
  assert.strictEqual(ev.state, 'done');
  assert.strictEqual(ev.results.passed, true);
  const v = byKind(ev, 'verdict');
  assert.strictEqual(v.executable, true);
  assert.strictEqual(v.passed, true);
  assert.strictEqual(v.detail.verdict, 'holds');
  assert.strictEqual(v.detail.judged_by, 'judge-v5');
  assert.strictEqual(v.detail.lease_id, lease_id);
  assert.deepStrictEqual(v.detail.depends_on, [t.id]);
  assert.strictEqual(v.detail.handoff_at, row.handoff.at);
  assert.strictEqual(ev.written_by, 'orchestrator');
  const a = await orch.task.assign({ task_id: next.id, worker_id: 'judge-v5' });
  assert.strictEqual(a.task.state, 'assigned');
});

test('verdict: refuted is executable and failed, with summary and findings in detail', async () => {
  const { r } = await doneTaskAndReview('v6');
  const findings = Array.from({ length: 60 }, (_, i) => ({ n: i, note: 'f' }));
  await handBack(r.id, 'judge-v6', { verdict: 'refuted', summary: 'the retry never fires', findings });
  const ev = await orch.task.evaluate({ task_id: r.id, worktree: dir });
  assert.notStrictEqual(ev.state, 'done');
  assert.strictEqual(ev.results.passed, false);
  assert.strictEqual(ev.results.executable, true);
  const v = byKind(ev, 'verdict');
  assert.strictEqual(v.executable, true);
  assert.strictEqual(v.passed, false);
  assert.strictEqual(v.detail.summary, 'the retry never fires');
  assert.strictEqual(v.detail.findings.length, 50, 'findings are cut to 50 entries');
  assert.deepStrictEqual(v.detail.findings[0], { n: 0, note: 'f' });
});

test('verdict: a judge who held a lease on the dependency is refused at assign (ADR 0058), named, and nothing is written', async () => {
  const { t, r } = await doneTaskAndReview('v7');
  // coder-v7 (the worker who did the work under review) would judge its own work: refused before a lease is written
  await worker('coder-v7');
  await rejects(orch.task.assign({ task_id: r.id, worker_id: 'coder-v7' }), 'E_SELF_REVIEW', new RegExp(`${t.id}[^]*coder-v7[^]*own work`));
  await rejects(orch.task.assign({ task_id: r.id, worker_id: 'coder-v7', check_only: true }), 'E_SELF_REVIEW');
  const row = await orch.task.get({ task_id: r.id });
  assert.deepStrictEqual([row.state, row.lease], ['open', null], 'no lease and no state change');
  // A different worker may take it.
  await worker('judge-v7');
  assert.strictEqual((await orch.task.assign({ task_id: r.id, worker_id: 'judge-v7' })).task.state, 'assigned');
});

test('verdict: no depends_on, no handoff, a missing summary, or an unknown verdict is not executable, each named', async () => {
  const check = async (id, re) => {
    const ev = await orch.task.evaluate({ task_id: id, worktree: dir });
    assert.notStrictEqual(ev.state, 'done');
    const v = byKind(ev, 'verdict');
    assert.strictEqual(v.executable, false, 'not executable');
    assert.match(v.detail.reason, re);
    return ev;
  };
  // no depends_on: even a good verdict is not a review of anything
  const solo = await orch.task.create({ spec: 'v8 solo', acceptance: { verdict: true } });
  await handBack(solo.id, 'judge-v8', { verdict: 'holds', summary: 'fine' });
  await check(solo.id, /depends_on/);

  const { r: none } = await doneTaskAndReview('v8a');
  await check(none.id, /no handoff/);

  const { r: nosum } = await doneTaskAndReview('v8b');
  await handBack(nosum.id, 'judge-v8', { verdict: 'holds', summary: '   ' });
  await check(nosum.id, /summary/);

  const { r: unknown } = await doneTaskAndReview('v8c');
  await handBack(unknown.id, 'judge-v8', { verdict: 'probably', summary: 'unsure' });
  await check(unknown.id, /verdict must be/);

  // control: a well-formed verdict from an unrelated worker does pass, so the refusals above are the shape
  const { r: good } = await doneTaskAndReview('v8d');
  await handBack(good.id, 'judge-v8', { verdict: 'holds', summary: 'fine' });
  assert.strictEqual((await orch.task.evaluate({ task_id: good.id, worktree: dir })).state, 'done');
});

test('create: acceptance.verdict other than true is refused E_ARGS', async () => {
  for (const verdict of [false, 'holds', 1, null, {}, []]) {
    await rejects(orch.task.create({ spec: 'v9', acceptance: { verdict } }), 'E_ARGS', /verdict/);
  }
  const before = (await orch.task.list({})).tasks.length;
  const ok = await orch.task.create({ spec: 'v9 ok', acceptance: { verdict: true } });
  assert.deepStrictEqual(ok.acceptance, { verdict: true });
  const plain = await orch.task.create({ spec: 'v9 plain', acceptance: PASS });
  assert.strictEqual(plain.state, 'open');
  assert.strictEqual((await orch.task.list({})).tasks.length, before + 2, 'the refusals wrote no rows');
});

test('verdict: a verdict beside a failing command check does not reach done', async () => {
  const { r } = await doneTaskAndReview('v10', { commands: FAIL.commands, verdict: true });
  await handBack(r.id, 'judge-v10', { verdict: 'holds', summary: 'holds' });
  const ev = await orch.task.evaluate({ task_id: r.id, worktree: dir });
  assert.notStrictEqual(ev.state, 'done');
  assert.strictEqual(ev.results.passed, false);
  assert.strictEqual(ev.results.executable, true);
  assert.strictEqual(ev.results.checks.length, 2);
  assert.strictEqual(byKind(ev, 'verdict').passed, true, 'the verdict itself held');
  assert.strictEqual(ev.results.checks.find((c) => c.kind !== 'verdict').passed, false);
});

test('verdict: a hand-back from a superseded lease is not judged after the task is reassigned', async () => {
  const { r } = await doneTaskAndReview('v12');
  const { lease_id: oldLease } = await handBack(r.id, 'judge-v12', { verdict: 'holds', summary: 'holds' });
  // the orchestrator reassigns the review to another judge
  await worker('judge-v12b');
  const again = await orch.task.assign({ task_id: r.id, worker_id: 'judge-v12b' });
  const ev = await orch.task.evaluate({ task_id: r.id, worktree: dir });
  assert.notStrictEqual(ev.state, 'done');
  const v = byKind(ev, 'verdict');
  assert.strictEqual(v.executable, false);
  assert.match(v.detail.reason, /superseded/);
  assert.match(v.detail.reason, new RegExp(oldLease));
  assert.match(v.detail.reason, new RegExp(again.new_lease.id));
  // and a live (unreleased) current lease is not judged either
  const { r: r2 } = await doneTaskAndReview('v12b');
  await handBack(r2.id, 'judge-v12', { verdict: 'holds', summary: 'holds' });
  await operator.lease.takeControl({ task_id: r2.id });
  const ev2 = await orch.task.evaluate({ task_id: r2.id, worktree: dir });
  assert.notStrictEqual(ev2.state, 'done');
  assert.strictEqual(byKind(ev2, 'verdict').executable, false);
});

test('release: a release on a done task leaves it done, and a result on it is refused E_ARGS with nothing written', async () => {
  // a task that is done while its worker still holds the lease (evaluated by the orchestrator meanwhile)
  const r = await orch.task.create({ spec: 'v13 work', acceptance: PASS });
  const first = await handBack(r.id, 'coder-v13', { head: 'the verdict done rests on' });
  const w = await worker('coder-v13');
  const a = await orch.task.assign({ task_id: r.id, worker_id: 'coder-v13' });
  assert.strictEqual((await orch.task.evaluate({ task_id: r.id, worktree: dir })).state, 'done');
  const seq = (await orch.task.get({ task_id: r.id })).seq;
  await rejects(w.lease.release({ lease_id: a.new_lease.id, result: { head: 'replacement' } }), 'E_ARGS', /done/);
  const held = await orch.task.get({ task_id: r.id });
  assert.strictEqual(held.seq, seq, 'nothing was written');
  assert.strictEqual(held.lease.id, a.new_lease.id, 'the lease is still held');
  const rel = await w.lease.release({ lease_id: a.new_lease.id });
  assert.strictEqual(rel.state, 'done', 'a release never un-earns done');
  assert.deepStrictEqual(rel.handoff, first.row.handoff, 'the verdict done rests on is untouched');
});

test('lease: ttl_ms is written at assign and renew and shown in task_list', async () => {
  const t = await orch.task.create({ spec: 'v14 work' });
  const w = await worker('coder-v14');
  const a = await orch.task.assign({ task_id: t.id, worker_id: 'coder-v14', ttl_ms: 12345 });
  assert.strictEqual(a.new_lease.ttl_ms, 12345);
  let view = (await orch.task.list({})).tasks.find((x) => x.id === t.id);
  assert.strictEqual(view.lease.ttl_ms, 12345);
  assert.strictEqual(view.lease.granted_at, a.new_lease.granted_at);
  const renewed = await w.lease.renew({ lease_id: a.new_lease.id, ttl_ms: 54321 });
  assert.strictEqual(renewed.ttl_ms, 54321);
  assert.strictEqual(renewed.granted_at, a.new_lease.granted_at, 'renew leaves granted_at, which is why ttl_ms is recorded');
  view = await orch.task.get({ task_id: t.id });
  assert.strictEqual(view.lease.ttl_ms, 54321);
  const dflt = await orch.task.create({ spec: 'v14 default' });
  assert.strictEqual((await orch.task.assign({ task_id: dflt.id, worker_id: 'coder-v14' })).new_lease.ttl_ms, 600000);
  const rel = await w.lease.release({ lease_id: a.new_lease.id });
  assert.strictEqual(rel.state, 'released');
  const tc = await operator.lease.takeControl({ task_id: t.id, ttl_ms: 777 });
  assert.strictEqual(tc.new_lease.ttl_ms, 777);
  assert.strictEqual((await orch.task.get({ task_id: t.id })).lease.ttl_ms, 777);
});
