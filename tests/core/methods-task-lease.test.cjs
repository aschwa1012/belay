'use strict';
// methods-task-lease.test.cjs — task, lease, dependency gating, checkpoints, authority and evaluate (api.md §3, §6).
// These tests share `taskId` and `leaseId` and the one store they write; split from methods.test.cjs under the 500-line rule.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor, deadPid, sleep } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch, worker, operator, wid = 'w1';

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: wid, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-1', last_event_at: Date.now() });
  worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: wid }), embed: false });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
});

after(async () => {
  // Each step is tried on its own and each client is guarded: a before hook that failed part-way leaves some unset,
  // and one failing close must not skip the owner's shutdown.
  if (worker) await worker.close().catch(() => {});
  if (operator) await operator.close().catch(() => {});
  if (orch) { await orch.shutdownOwner().catch(() => {}); await orch.close().catch(() => {}); } // the only way to stop an owner; never a signal
  cleanup(dir);
});

const rejects = async (p, code) => {
  await assert.rejects(p, e => {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    assert.ok(e.message.length > 10, 'the message must name the reason, not be a status word');
    return true;
  });
};


// ---- task and lease --------------------------------------------------------
let taskId, leaseId;

test('task.create returns an open row and refuses overlapping ownership', async () => {
  const t = await orch.task.create({ spec: 'build the core', files_owned: ['src/core'], acceptance: { files_within_owned: true } });
  taskId = t.id;
  assert.strictEqual(t.state, 'open');
  assert.deepStrictEqual(t.files_owned, ['src/core']);
  assert.deepStrictEqual(t.acceptance, { files_within_owned: true });
  assert.strictEqual(t.results, null);
  assert.strictEqual(t.written_by, 'orchestrator');
  await assert.rejects(orch.task.create({ spec: 'clash', files_owned: ['src/core/index.cjs'] }), e => {
    assert.strictEqual(e.code, 'E_FILES_OVERLAP');
    assert.strictEqual(e.detail.other_task_id, taskId);
    assert.deepStrictEqual(e.detail.files, ['src/core/index.cjs']);
    return true;
  });
});

test('task.assign returns both leases and moves the task to assigned', async () => {
  const r = await orch.task.assign({ task_id: taskId, worker_id: wid });
  leaseId = r.new_lease.id;
  assert.strictEqual(r.task.state, 'assigned');
  assert.strictEqual(r.old_lease, null);
  assert.strictEqual(r.new_lease.holder, wid);
  assert.strictEqual(r.new_lease.holder_role, 'worker');
  assert.ok(r.new_lease.expires_at > Date.now());
  assert.strictEqual(r.new_lease.supersedes, null);
  assert.strictEqual(r.paused_worker, null);
});

test('task.assign refuses a worker that is not live', async () => {
  await orch.worker.write({ id: 'w-stopped', substrate: 'codex', pid: deadPid(), state: 'stopped' });
  await rejects(orch.task.assign({ task_id: taskId, worker_id: 'w-stopped' }), 'E_WORKER_NOT_LIVE');
  await rejects(orch.task.assign({ task_id: taskId, worker_id: 'never-existed' }), 'E_WORKER_NOT_LIVE');
});

// ---- dependency gating (ADR 0013 §1) ---------------------------------------
test('task.create records its dependencies and refuses one that has no row', async () => {
  const dep = await orch.task.create({ spec: 'the dependency' });
  const t = await orch.task.create({ spec: 'the dependent', depends_on: [dep.id, dep.id] });
  assert.deepStrictEqual(t.depends_on, [dep.id], 'a repeated edge is one edge');
  const back = await orch.task.get({ task_id: t.id });
  assert.deepStrictEqual(back.depends_on, [dep.id], 'the edges survive the round trip through the text column');
  await assert.rejects(orch.task.create({ spec: 'depends on a ghost', depends_on: ['no-such-task'] }), e => {
    assert.strictEqual(e.code, 'E_NOT_FOUND');
    assert.strictEqual(e.detail.missing_dependency, 'no-such-task');
    return true;
  });
  await rejects(orch.task.create({ spec: 'bad shape', depends_on: 'not-an-array' }), 'E_ARGS');
  assert.strictEqual((await orch.task.create({ spec: 'no edges' })).depends_on, null);
});

test('task.assign refuses while a dependency is open, and names it and its holder', async () => {
  const dep = await orch.task.create({ spec: 'must finish first', acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] } });
  const t = await orch.task.create({ spec: 'waits for it', depends_on: [dep.id] });
  await assert.rejects(orch.task.assign({ task_id: t.id, worker_id: wid }), e => {
    assert.strictEqual(e.code, 'E_DEPENDENCY_OPEN');
    assert.strictEqual(e.detail.blocked_by, dep.id);
    assert.strictEqual(e.detail.dependency_state, 'open');
    assert.strictEqual(e.detail.holder, null, 'nobody holds it yet, and the refusal says so rather than inventing a holder');
    assert.ok(e.message.includes(dep.id), 'the refusal names the task that would unblock it');
    return true;
  });

  // Once the dependency is held, the refusal carries the holder: that is the question a blocked worker
  // would otherwise aim at a person, answered by the store at the moment it would have been asked.
  await orch.task.assign({ task_id: dep.id, worker_id: wid });
  await assert.rejects(orch.task.assign({ task_id: t.id, worker_id: wid }), e => {
    assert.strictEqual(e.detail.dependency_state, 'assigned');
    assert.strictEqual(e.detail.holder, wid);
    assert.strictEqual(e.detail.holder_role, 'worker');
    return true;
  });

  // The gate is checked before the worker, so an open dependency is the answer whichever worker was
  // named — otherwise the orchestrator fixes the worker and hits the real blocker on the next call.
  await rejects(orch.task.assign({ task_id: t.id, worker_id: 'never-existed' }), 'E_DEPENDENCY_OPEN');

  // Only `done` opens the gate, and only executable evidence writes `done` (api.md §2).
  assert.strictEqual((await orch.task.evaluate({ task_id: dep.id, worktree: dir })).state, 'done');
  const a = await orch.task.assign({ task_id: t.id, worker_id: wid });
  assert.strictEqual(a.task.state, 'assigned');
  assert.strictEqual(a.new_lease.holder, wid);
});

test('task.assign refuses a done task with E_TASK_DONE and writes nothing', async () => {
  const t = await orch.task.create({ spec: 'finished work', acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] } });
  await orch.task.assign({ task_id: t.id, worker_id: wid });
  assert.strictEqual((await orch.task.evaluate({ task_id: t.id, worktree: dir })).state, 'done');
  const snap = async () => JSON.stringify((await orch.store.diff({ since_ms: 0 })).tables);
  const before = await snap();
  await assert.rejects(orch.task.assign({ task_id: t.id, worker_id: wid }), e => {
    assert.strictEqual(e.code, 'E_TASK_DONE');
    assert.deepStrictEqual(e.detail, { task_id: t.id, state: 'done' });
    assert.ok(e.message.includes(t.id) && e.message.includes('task.evaluate'), e.message);
    return true;
  });
  assert.strictEqual(await snap(), before, 'no task row and no lease row was written by the refusal');
});

test('task.assign on a done task leaves its dependent\'s gate open', async () => {
  const dep = await orch.task.create({ spec: 'done dependency', acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] } });
  const t = await orch.task.create({ spec: 'dependent of a done task', depends_on: [dep.id] });
  await orch.task.assign({ task_id: dep.id, worker_id: wid });
  assert.strictEqual((await orch.task.evaluate({ task_id: dep.id, worktree: dir })).state, 'done');
  await rejects(orch.task.assign({ task_id: dep.id, worker_id: wid }), 'E_TASK_DONE');
  assert.strictEqual((await orch.task.get({ task_id: dep.id })).state, 'done', 'the refused assign did not un-earn done');
  const a = await orch.task.assign({ task_id: t.id, worker_id: wid });
  assert.strictEqual(a.task.state, 'assigned', 'the dependent is still assignable');
});

test('the acyclicity check fires on a cycle that reached the table by some other route', () => {
  // `task.create` refuses an edge to a task with no row and refuses an id that already has one, so a
  // cycle cannot be built through it. The check is the invariant stated as code rather than as an
  // argument, so it is exercised against a store handed the rows directly.
  const graph = (edges) => ({ p: () => ({ get: (id) => (edges[id] ? { id, depends_on: JSON.stringify(edges[id]) } : null) }) });
  const T = core('methods-task.cjs');
  assert.deepStrictEqual(T.findCycle(graph({ b: ['c'], c: ['a'] }), 'a', ['b']), ['a', 'b', 'c', 'a']);
  assert.strictEqual(T.findCycle(graph({ b: ['c'], c: [] }), 'a', ['b']), null);
  assert.deepStrictEqual(T.findCycle(graph({}), 'a', ['a']), ['a', 'a'], 'a task cannot depend on itself');
});

test('task.list and task.get carry the lease, holder liveness and the last checkpoint', async () => {
  const one = await orch.task.get({ task_id: taskId });
  assert.strictEqual(one.lease.id, leaseId);
  assert.strictEqual(one.lease.expired, false);
  assert.strictEqual(one.holder_pid_alive, true);
  assert.strictEqual(one.last_checkpoint_id, null);
  const many = await operator.task.list({ states: ['assigned'] });
  assert.ok(many.tasks.some(t => t.id === taskId));
  await rejects(orch.task.get({ task_id: 'nope' }), 'E_NOT_FOUND');
});

test('a worker checkpoint is labelled stated, forced to the caller, and its tool_digest is discarded', async () => {
  const ck = await worker.continuity.checkpoint({
    task_id: taskId, worker_id: 'someone-else', turn: 3, files_touched: ['src/core/index.cjs'],
    tool_digest: [{ tool: 'Bash', args_sha256_12: 'aaa', result_bytes: 1, at: Date.now() }],
    summary: 'wired the dispatch', next_step: 'write the tests', open_questions: ['is 400 bytes enough?'],
  });
  assert.strictEqual(ck.source, 'worker');
  assert.strictEqual(ck.worker_id, wid, 'the worker id comes from argv, never from the arguments');
  assert.strictEqual(ck.tool_digest, null, 'a worker cannot supply a tool digest');
  assert.strictEqual(ck.stated.next_step, 'write the tests');
  assert.deepStrictEqual(ck.stated.open_questions, ['is 400 bytes enough?']);
  assert.strictEqual(ck.written_by, wid);
});

test('an orchestrator checkpoint is harness-sourced and carries no stated block', async () => {
  const ck = await orch.continuity.checkpoint({
    task_id: taskId, worker_id: wid, turn: 4,
    tool_digest: Array.from({ length: 25 }, (_, i) => ({ tool: 'Read', args_sha256_12: String(i), result_bytes: i, at: Date.now() })),
    summary: 'ignored', next_step: 'ignored',
  });
  assert.strictEqual(ck.source, 'harness');
  assert.strictEqual(ck.stated, null);
  assert.strictEqual(ck.tool_digest.length, 20, 'only the last 20 tool calls are kept');
  assert.strictEqual(ck.tool_digest[0].args_sha256_12, '5');
});

test('lease.renew extends the lease for its holder and refuses everyone else', async () => {
  const before = await orch.task.get({ task_id: taskId });
  await sleep(5);
  const l = await worker.lease.renew({ lease_id: leaseId });
  assert.strictEqual(l.id, leaseId);
  assert.ok(l.expires_at > before.lease.expires_at, 'renew must move the expiry forward');
  const other = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w-other' }), embed: false });
  try { await rejects(other.lease.renew({ lease_id: leaseId }), 'E_NOT_HOLDER'); } finally { await other.close(); }
  await rejects(worker.lease.renew({ lease_id: 'no-such-lease' }), 'E_NOT_FOUND');
});

test('an expired lease cannot be renewed and blocks a worker checkpoint', async () => {
  const t = await orch.task.create({ spec: 'short lease' });
  const a = await orch.task.assign({ task_id: t.id, worker_id: wid, ttl_ms: 1 });
  await sleep(15);
  await rejects(worker.lease.renew({ lease_id: a.new_lease.id }), 'E_LEASE_EXPIRED');
  await rejects(worker.continuity.checkpoint({ task_id: t.id, summary: 'still here' }), 'E_NO_LEASE');
});

test('a worker checkpoint on a task it does not hold is E_NO_LEASE', async () => {
  const t = await orch.task.create({ spec: 'unheld' });
  await rejects(worker.continuity.checkpoint({ task_id: t.id, summary: 'x' }), 'E_NO_LEASE');
  await rejects(worker.continuity.checkpoint({ task_id: 'no-such-task', summary: 'x' }), 'E_NOT_FOUND');
});

test('lease.release moves the task to released and names the last checkpoint', async () => {
  const r = await worker.lease.release({ lease_id: leaseId, reason: 'handing back' });
  assert.strictEqual(r.state, 'released');
  assert.ok(r.last_checkpoint_id, 'the release must name the checkpoint a replacement would resume from');
  const after = await orch.task.get({ task_id: taskId });
  assert.strictEqual(after.lease, null, 'a released lease leaves no holder');
});

test('take-control moves the lease to the operator and then outranks the orchestrator', async () => {
  const r = await operator.lease.takeControl({ task_id: taskId });
  assert.strictEqual(r.new_lease.holder, 'operator');
  assert.strictEqual(r.new_lease.holder_role, 'operator');
  assert.ok(r.old_lease, 'the superseded lease is named');
  assert.strictEqual(r.new_lease.supersedes, r.old_lease.id);
  await assert.rejects(orch.task.assign({ task_id: taskId, worker_id: wid }), e => {
    assert.strictEqual(e.code, 'E_OPERATOR_HOLDS');
    assert.strictEqual(e.detail.lease_id, r.new_lease.id);
    return true;
  });
  // The operator outranks the worker, so only the operator can give it back.
  await rejects(worker.lease.release({ lease_id: r.new_lease.id }), 'E_NOT_HOLDER');
  await operator.lease.release({ lease_id: r.new_lease.id });
  const back = await orch.task.assign({ task_id: taskId, worker_id: wid });
  assert.strictEqual(back.task.state, 'assigned');
  leaseId = back.new_lease.id;
});

test('a superseded lease can neither be renewed nor released by its old holder', async () => {
  // The orchestrator moves a task from one worker to another. The first worker still knows its lease
  // id, and a lease id alone must not be authority: the current lease of a task is the highest-seq
  // lease row for it, so accepting either call would append a row that makes the old lease current
  // again and hand the task back. ADR 0010 §4: a worker cannot outrank an assignment.
  await orch.worker.write({ id: 'w-second', substrate: 'claude-code', pid: process.pid, state: 'running' });
  const second = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w-second' }), embed: false });
  try {
    const t = await orch.task.create({ spec: 'reassigned out from under its first holder' });
    const first = (await orch.task.assign({ task_id: t.id, worker_id: wid })).new_lease;
    const now = (await orch.task.assign({ task_id: t.id, worker_id: 'w-second' })).new_lease;
    assert.strictEqual(now.supersedes, first.id);

    for (const call of [() => worker.lease.renew({ lease_id: first.id }), () => worker.lease.release({ lease_id: first.id })]) {
      await assert.rejects(call(), e => {
        assert.strictEqual(e.code, 'E_LEASE_EXPIRED');
        assert.strictEqual(e.detail.superseded_by, now.id);
        assert.strictEqual(e.detail.current_holder, 'w-second');
        return true;
      });
    }
    // The task is untouched: the holder is still the worker the orchestrator assigned it to, and that
    // worker can still write a checkpoint against it.
    const after = await orch.task.get({ task_id: t.id });
    assert.strictEqual(after.lease.id, now.id);
    assert.strictEqual(after.lease.holder, 'w-second');
    assert.strictEqual(after.state, 'assigned');
    const ck = await second.continuity.checkpoint({ task_id: t.id, summary: 'still mine' });
    assert.strictEqual(ck.worker_id, 'w-second');
  } finally { await second.close(); }
});

test('take-control does not un-earn a done task', async () => {
  const t = await orch.task.create({ spec: 'earned done', acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'] }] } });
  const done = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  assert.strictEqual(done.state, 'done');
  const r = await operator.lease.takeControl({ task_id: t.id });
  assert.strictEqual(r.new_lease.holder_role, 'operator');
  assert.strictEqual((await orch.task.get({ task_id: t.id })).state, 'done', 'done is earned by executable evidence and take-control must not undo it');
  await operator.lease.release({ lease_id: r.new_lease.id });
});

// ---- authority -------------------------------------------------------------
test('roles are enforced in the core, from argv, and every refusal names the method', async () => {
  await rejects(worker.task.create({ spec: 'not mine' }), 'E_ROLE');
  await rejects(worker.run.attach({ adapter_pid: process.pid }), 'E_ROLE');
  await rejects(worker.worker.write({ id: 'x', state: 'starting' }), 'E_ROLE');
  await rejects(worker.lease.takeControl({ task_id: taskId }), 'E_ROLE');
  await rejects(orch.lease.renew({ lease_id: leaseId }), 'E_ROLE');
  await rejects(operator.task.evaluate({ task_id: taskId, worktree: dir }), 'E_ROLE');
  await rejects(operator.continuity.checkpoint({ task_id: taskId }), 'E_ROLE');
});

test('a caller field inside the arguments cannot change who a write is attributed to', async () => {
  const row = await worker.memory.store({
    text: 'attribution probe',
    caller: { role: 'orchestrator', run_id: 'test-run', worker_id: 'impostor', pid: 1 },
    embed: false,
  });
  assert.strictEqual(row.worker_id, wid, 'identity comes from argv, never from the request body');
  const ck = await worker.continuity.checkpoint({ task_id: taskId, summary: 's', caller: { role: 'operator', run_id: 'test-run' } });
  assert.strictEqual(ck.source, 'worker');
  assert.strictEqual(ck.written_by, wid);
});

test('an unknown method is refused rather than ignored', () => rejects(orch.handle('memory.explode', {}), 'E_ARGS'));

// ---- evaluate --------------------------------------------------------------
test('task.evaluate runs argv commands without a shell and checks the git worktree', async () => {
  const gitOk = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(path.join(wt, 'src', 'evaluated'), { recursive: true });
  if (gitOk) {
    for (const argv of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't'], ['commit', '-q', '--allow-empty', '-m', 'base']]) {
      spawnSync('git', argv, { cwd: wt, windowsHide: true });
    }
  }
  fs.writeFileSync(path.join(wt, 'src', 'evaluated', 'a.txt'), 'owned\n');

  const t = await orch.task.create({
    spec: 'evaluate me', files_owned: ['src/evaluated'],
    acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }], files_within_owned: true },
  });
  const r = await orch.task.evaluate({ task_id: t.id, worktree: wt });
  assert.strictEqual(r.results.checks[0].kind, 'command');
  assert.strictEqual(r.results.checks[0].exit_code, 0);
  assert.strictEqual(r.results.checks[0].passed, true);
  assert.ok(typeof r.results.checks[0].ms === 'number');
  const fw = r.results.checks[1];
  assert.strictEqual(fw.kind, 'files_within_owned');
  assert.strictEqual(fw.executable, gitOk, 'outside a git repo this check is not executable');
  if (gitOk) {
    assert.strictEqual(fw.passed, true);
    assert.strictEqual(r.state, 'done', 'done only when every check is executable and passed');
    assert.strictEqual(r.results.executable, true);
    assert.strictEqual(r.results.passed, true);
  } else {
    assert.notStrictEqual(r.state, 'done');
  }
});

test('a failing command keeps the task out of done', async () => {
  const t = await orch.task.create({ spec: 'fails', acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(3)'] }] } });
  const r = await orch.task.evaluate({ task_id: t.id, worktree: dir });
  assert.strictEqual(r.results.checks[0].exit_code, 3);
  assert.strictEqual(r.results.passed, false);
  assert.notStrictEqual(r.state, 'done');
});

test('a command that cannot be spawned is not executable, and no acceptance proves nothing', async () => {
  const t1 = await orch.task.create({ spec: 'no such binary', acceptance: { commands: [{ argv: ['definitely-not-a-real-binary-xyz'] }] } });
  const r1 = await orch.task.evaluate({ task_id: t1.id, worktree: dir });
  assert.strictEqual(r1.results.checks[0].executable, false);
  assert.strictEqual(r1.results.executable, false);
  assert.notStrictEqual(r1.state, 'done');

  const t2 = await orch.task.create({ spec: 'no acceptance at all' });
  const r2 = await orch.task.evaluate({ task_id: t2.id, worktree: dir });
  assert.deepStrictEqual(r2.results.checks, []);
  assert.strictEqual(r2.results.executable, false);
  assert.strictEqual(r2.state, 'open');
  assert.ok(r2.results.note.includes('nothing is proven'));
});

test('task.evaluate refuses a missing task and a missing worktree', async () => {
  await rejects(orch.task.evaluate({ task_id: 'nope', worktree: dir }), 'E_NOT_FOUND');
  await rejects(orch.task.evaluate({ task_id: taskId }), 'E_ARGS');
});
