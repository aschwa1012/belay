'use strict';
// worker-paused.test.cjs — build step 6e-4, ADR 0023
// amendment 2 decision 5, the shape of worker-forget.test.cjs. Through the engine (openCore's in-process
// path): `paused` is no longer a live state, so it needs no live pid to be written, and every row that is
// not itself paused clears both fields.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { WORKER_STATES } = core('schema.cjs');

let dir, orch, operator;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  await operator.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

// (l2)
test('worker.write: paused needs paused_by, does not need a live pid, carries paused_at and paused_by, and every row not paused has both null', async () => {
  await orch.worker.write({ id: 'w-p1', substrate: 'claude-code', pid: process.pid, state: 'starting', turns: 0, started_at: Date.now() });
  const before1 = (await orch.worker.get({ worker_id: 'w-p1' })).seq;
  const dead = deadPid();

  // missing paused_by, or a non-integer paused_at, is E_ARGS, and nothing is written — checked against
  // the `starting` row above, before any paused row exists to inherit a valid paused_by from.
  await assert.rejects(
    orch.worker.write({ id: 'w-p1', state: 'paused', pid: dead, paused_at: Date.now() }),
    (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; },
  );
  await assert.rejects(
    orch.worker.write({ id: 'w-p1', state: 'paused', pid: dead, paused_by: 'operator:1', paused_at: 'not-a-number' }),
    (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; },
  );
  assert.strictEqual((await orch.worker.get({ worker_id: 'w-p1' })).seq, before1, 'an args-refused pause must not write');

  // build step 6e-4: a dead pid is fine for `paused` (a park's own row is written after the process has
  // already exited) — only `paused_by` and an integer `paused_at` are required.
  const at = Date.now();
  const parked = await orch.worker.write({ id: 'w-p1', state: 'paused', pid: dead, paused_at: at, paused_by: 'operator:123', session_id: 'sess-1' });
  assert.strictEqual(parked.state, 'paused');
  assert.strictEqual(parked.pid, dead);
  assert.strictEqual(parked.paused_at, at);
  assert.strictEqual(parked.paused_by, 'operator:123');
  assert.strictEqual(parked.session_id, 'sess-1');

  // `running` still needs a live pid — the rule the paused row above no longer carries.
  await assert.rejects(
    orch.worker.write({ id: 'w-p1', state: 'running', pid: deadPid() }),
    (e) => { assert.strictEqual(e.code, 'E_WORKER_NOT_LIVE'); return true; },
  );

  // a later row not itself paused clears both, even though the merge would otherwise inherit them.
  const resumed = await orch.worker.write({ id: 'w-p1', state: 'running', pid: process.pid });
  assert.strictEqual(resumed.paused_at, null);
  assert.strictEqual(resumed.paused_by, null);

  // every other state written for this worker also carries both null.
  await orch.worker.write({ id: 'w-p1', state: 'idle', pid: null });
  const idleRow = await orch.worker.get({ worker_id: 'w-p1' });
  assert.strictEqual(idleRow.paused_at, null);
  assert.strictEqual(idleRow.paused_by, null);
  assert.strictEqual(before1 <= idleRow.seq, true);
});

// (m2)
test('paused is not live: task.assign refuses it, worker.forget accepts it, run.attach leaves it, and WORKER_STATES still ends with forgotten', async () => {
  assert.strictEqual(WORKER_STATES[WORKER_STATES.length - 1], 'forgotten');
  assert.ok(WORKER_STATES.includes('paused'));

  // task.assign: a paused worker, live pid or not, is not assignable (it is not a live state any more).
  const t = await orch.task.create({ spec: 'never assignable to a paused worker' });
  await orch.worker.write({ id: 'w-p2', substrate: 'claude-code', pid: deadPid(), state: 'paused', paused_at: Date.now(), paused_by: 'operator:1', turns: 0, started_at: Date.now() });
  await assert.rejects(operator.task.assign({ task_id: t.id, worker_id: 'w-p2' }), (e) => {
    assert.strictEqual(e.code, 'E_WORKER_NOT_LIVE');
    assert.strictEqual(e.detail.state, 'paused');
    return true;
  });

  // worker.forget accepts a paused worker outright: it is never live, so FORGET_LIVE_STATES's own
  // pid-aliveness check is never reached for it.
  const forgotten = await operator.worker.forget({ worker_id: 'w-p2' });
  assert.strictEqual(forgotten.row_after.state, 'forgotten');
  assert.strictEqual(forgotten.row_after.paused_at, null);
  assert.strictEqual(forgotten.row_after.paused_by, null);

  // run.attach: ATTACH_SUSPECT no longer names `paused`, so a paused row is left alone across a reattach,
  // whatever its pid — the opposite of a `running`/`starting`/`idle` row over a dead pid, which is marked
  // dead below for contrast.
  const { spawn } = require('node:child_process');
  const { killPid, waitPidGone } = core('process.cjs');
  let child;
  try {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
    await orch.worker.write({ id: 'w-p3', substrate: 'claude-code', pid: deadPid(), state: 'paused', paused_at: Date.now(), paused_by: 'operator:1', session_id: 'sess-3', turns: 0, started_at: Date.now() });
    await orch.worker.write({ id: 'w-p4', substrate: 'claude-code', pid: child.pid, state: 'running', turns: 0, started_at: Date.now() });
    killPid(child, 'SIGKILL');
    await waitPidGone(child.pid, { timeoutMs: 5000 });
    const before3 = (await orch.worker.get({ worker_id: 'w-p3' })).seq;
    const attach = await orch.run.attach({ adapter_pid: process.pid });
    assert.ok(!attach.workers_marked_dead.includes('w-p3'), 'a paused row must not be superseded dead on reattach');
    assert.ok(attach.workers_marked_dead.includes('w-p4'), 'a running row over a dead pid is still marked dead, for contrast');
    const after3 = await orch.worker.get({ worker_id: 'w-p3' });
    assert.strictEqual(after3.state, 'paused');
    assert.strictEqual(after3.seq, before3, 'nothing wrote a new row for the paused worker');
  } finally {
    if (child) killPid(child, 'SIGKILL');
  }
});
