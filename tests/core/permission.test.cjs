'use strict';
// permission.test.cjs — build step 6d, design item 2,
// ADR 0020 decision 2. The permission table's four core methods, in the shape of
// tests/core/worker-forget.test.cjs and control.test.cjs: an orchestrator core that elects, a worker
// core w-1, a second worker core w-2, and an operator core, all in-process through the pipe or the
// engine. Every owner shut down in a finally.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { core, sandbox, cleanup, callerFor, deadPid, listDataDir, sleep } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { PERMISSION_STATES } = core('schema.cjs');

let dir, orch, w1, w2, operator;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid }); // the write that elects
  w1 = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w-1' }), embed: false });
  w2 = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w-2' }), embed: false });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
});

after(async () => {
  // Each step is tried on its own and each client is guarded: a before hook that failed part-way leaves some unset,
  // and one failing close must not skip the owner's shutdown.
  if (w1) await w1.close().catch(() => {});
  if (w2) await w2.close().catch(() => {});
  if (operator) await operator.close().catch(() => {});
  if (orch) { await orch.shutdownOwner().catch(() => {}); await orch.close().catch(() => {}); } // the only way to stop an owner; never a signal
  cleanup(dir);
});

const allCount = async () => (await operator.permission.list({ states: PERMISSION_STATES })).requests.length;

test("permission.request: a worker's request row carries its own worker id, run id and pid from argv, ignoring any of the three in the arguments, caps the input at 8,192 bytes with the sha over the full text, and refuses a duplicate id, a missing id or tool, and every other role, writing nothing", async () => {
  const id = `perm-a-${crypto.randomUUID()}`;
  const row = await w1.permission.request({
    id, tool: 'Bash', input: { command: 'echo hi' },
    worker_id: 'evil', run_id: 'evil-run', adapter_pid: 999999,
  });
  assert.strictEqual(row.worker_id, 'w-1', 'worker_id must come from argv, never the arguments');
  assert.strictEqual(row.run_id, 'test-run', 'run_id must come from argv, never the arguments');
  assert.strictEqual(row.adapter_pid, process.pid, 'adapter_pid must come from argv, never the arguments');
  assert.strictEqual(row.state, 'pending');
  assert.strictEqual(row.tool, 'Bash');

  // the input cap
  const bigId = `perm-a-big-${crypto.randomUUID()}`;
  const bigInput = { blob: 'x'.repeat(20000) };
  const full = JSON.stringify(bigInput);
  const sha = crypto.createHash('sha256').update(full).digest('hex');
  const bigRow = await w1.permission.request({ id: bigId, tool: 'Bash', input: bigInput });
  assert.strictEqual(bigRow.input_truncated, 1);
  assert.strictEqual(Buffer.byteLength(bigRow.input, 'utf8'), 8192);
  assert.strictEqual(bigRow.input_sha256, sha, 'the sha must be over the full text, before the cut');

  // a duplicate id
  const before1 = await allCount();
  await assert.rejects(w1.permission.request({ id, tool: 'Bash', input: null }), (e) => {
    assert.strictEqual(e.code, 'E_ARGS');
    assert.match(e.message, new RegExp(id));
    return true;
  });
  assert.strictEqual(await allCount(), before1, 'a duplicate id refusal must write nothing');

  // a missing id or tool
  const before2 = await allCount();
  await assert.rejects(w1.permission.request({ tool: 'Bash' }), (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; });
  await assert.rejects(w1.permission.request({ id: `perm-a-notool-${crypto.randomUUID()}` }), (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; });
  assert.strictEqual(await allCount(), before2, 'a missing-field refusal must write nothing');

  // every other role
  const before3 = await allCount();
  await assert.rejects(orch.permission.request({ id: `perm-a-orch-${crypto.randomUUID()}`, tool: 'Bash', input: null }), (e) => { assert.strictEqual(e.code, 'E_ROLE'); return true; });
  await assert.rejects(operator.permission.request({ id: `perm-a-op-${crypto.randomUUID()}`, tool: 'Bash', input: null }), (e) => { assert.strictEqual(e.code, 'E_ROLE'); return true; });
  assert.strictEqual(await allCount(), before3, 'a wrong-role refusal must write nothing');
});

test('permission.decide: an operator and an orchestrator may allow or deny with verdict_by naming role and pid, a row that is not pending is refused naming its state and seq, an unknown id is E_NOT_FOUND, and adapter_pid_alive is a pid check', async () => {
  const id1 = `perm-b1-${crypto.randomUUID()}`;
  await w1.permission.request({ id: id1, tool: 'Bash', input: null });
  const decided = await operator.permission.decide({ id: id1, verdict: 'allow' });
  assert.strictEqual(decided.verdict.state, 'allowed');
  assert.strictEqual(decided.verdict.verdict_by, `operator:${process.pid}`);
  assert.strictEqual(decided.adapter_pid_alive, true, "w1's caller.pid is this alive process");

  const id2 = `perm-b2-${crypto.randomUUID()}`;
  await w1.permission.request({ id: id2, tool: 'Bash', input: null });
  const decided2 = await orch.permission.decide({ id: id2, verdict: 'deny', reason: 'no' });
  assert.strictEqual(decided2.verdict.state, 'denied');
  assert.strictEqual(decided2.verdict.verdict_by, `orchestrator:${process.pid}`);
  assert.strictEqual(decided2.verdict.reason, 'no');

  // a row that is not pending
  await assert.rejects(operator.permission.decide({ id: id1, verdict: 'deny' }), (e) => {
    assert.strictEqual(e.code, 'E_ARGS');
    assert.strictEqual(e.detail.state, 'allowed');
    assert.ok(Number.isInteger(e.detail.seq));
    return true;
  });

  // an unknown id
  await assert.rejects(operator.permission.decide({ id: 'no-such-permission-id', verdict: 'allow' }), (e) => {
    assert.strictEqual(e.code, 'E_NOT_FOUND');
    return true;
  });

  // adapter_pid_alive is a pid check
  const dead = deadPid();
  const wdead = await openCore({ dataDir: dir, caller: { role: 'worker', worker_id: 'w-dead', run_id: 'test-run', pid: dead }, embed: false });
  try {
    const id3 = `perm-b3-${crypto.randomUUID()}`;
    await wdead.permission.request({ id: id3, tool: 'Bash', input: null });
    const decided3 = await operator.permission.decide({ id: id3, verdict: 'allow' });
    assert.strictEqual(decided3.adapter_pid_alive, false);
  } finally { await wdead.close(); }
});

test("permission.decide: a worker may only expire, and only its own row; allow, deny and another worker's row are E_ROLE naming the verdict and the role", async () => {
  const id = `perm-c-${crypto.randomUUID()}`;
  await w1.permission.request({ id, tool: 'Bash', input: null });

  await assert.rejects(w1.permission.decide({ id, verdict: 'allow' }), (e) => {
    assert.strictEqual(e.code, 'E_ROLE');
    assert.strictEqual(e.detail.verdict, 'allow');
    assert.strictEqual(e.detail.role, 'worker');
    return true;
  });
  await assert.rejects(w1.permission.decide({ id, verdict: 'deny' }), (e) => {
    assert.strictEqual(e.code, 'E_ROLE');
    assert.strictEqual(e.detail.verdict, 'deny');
    return true;
  });
  // another worker's row
  await assert.rejects(w2.permission.decide({ id, verdict: 'expire' }), (e) => {
    assert.strictEqual(e.code, 'E_ROLE');
    assert.strictEqual(e.detail.verdict, 'expire');
    assert.strictEqual(e.detail.worker_id, 'w-1');
    return true;
  });
  // a worker may expire its own row
  const result = await w1.permission.decide({ id, verdict: 'expire', reason: 'own bound' });
  assert.strictEqual(result.verdict.state, 'expired');
  assert.strictEqual(result.verdict.verdict_by, `adapter-bound:${process.pid}`);
});

test('permission.wait: an already-decided row answers at once with already true; a pending row resolves promptly once decided over the pipe, with the verdict row, rather than after its wait slice; the bound answers timed_out true with the pending row; a wait past 25,000 ms or below 1 is E_ARGS; a worker with no owner is E_NO_OWNER having created nothing', async () => {
  // already-decided
  const id1 = `perm-d1-${crypto.randomUUID()}`;
  await w1.permission.request({ id: id1, tool: 'Bash', input: null });
  await operator.permission.decide({ id: id1, verdict: 'allow' });
  const already = await w1.permission.wait({ id: id1, timeout_ms: 1000 });
  assert.strictEqual(already.already, true);
  assert.strictEqual(already.timed_out, false);
  assert.strictEqual(already.waited_ms, 0);
  assert.strictEqual(already.request.state, 'allowed');

  // a pending row resolves within 500 ms of a decide over the pipe
  const id2 = `perm-d2-${crypto.randomUUID()}`;
  await w1.permission.request({ id: id2, tool: 'Bash', input: null });
  const waitPromise = w1.permission.wait({ id: id2, timeout_ms: 5000 });
  setTimeout(() => { operator.permission.decide({ id: id2, verdict: 'allow' }).catch(() => {}); }, 300);
  const t0 = Date.now();
  const resolved = await waitPromise;
  const elapsed = Date.now() - t0;
  // The decide lands at 300 ms; the bug is a wake that never comes, so the wait runs out its 5,000 ms. A loaded
  // runner needs headroom over the 300 ms, hence 4,000.
  assert.ok(elapsed < 4000, `wait resolved in ${elapsed} ms, expected close to the 300 ms decide`);
  assert.strictEqual(resolved.timed_out, false);
  assert.strictEqual(resolved.already, false);
  assert.strictEqual(resolved.request.state, 'allowed');
  assert.ok(resolved.waited_ms >= 250, `waited_ms was ${resolved.waited_ms}`);

  // the bound
  const id3 = `perm-d3-${crypto.randomUUID()}`;
  await w1.permission.request({ id: id3, tool: 'Bash', input: null });
  const bounded = await w1.permission.wait({ id: id3, timeout_ms: 300 });
  assert.strictEqual(bounded.timed_out, true);
  assert.strictEqual(bounded.request.state, 'pending');

  // out of range timeout_ms
  await assert.rejects(w1.permission.wait({ id: id3, timeout_ms: 25001 }), (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; });
  await assert.rejects(w1.permission.wait({ id: id3, timeout_ms: 0 }), (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; });

  // a worker with no owner
  const dir2 = sandbox();
  try {
    const orphan = await openCore({ dataDir: dir2, caller: callerFor('worker', { worker_id: 'w-orphan' }), embed: false });
    try {
      await assert.rejects(orphan.permission.wait({ id: 'whatever' }), (e) => { assert.strictEqual(e.code, 'E_NO_OWNER'); return true; });
    } finally { await orphan.close(); }
    assert.deepStrictEqual(listDataDir(dir2), [], 'a worker with no owner must create nothing');
  } finally { cleanup(dir2); }
});

test('permission.wait: an owner stopping settles every waiter, and the client sees E_OWNER_LOST, never a hang', async (tcx) => {
  const dir2 = sandbox();
  let orch2 = null;
  tcx.after(() => Promise.resolve().then(() => orch2.shutdownOwner()).catch(() => {}));
  try {
    orch2 = await openCore({ dataDir: dir2, caller: callerFor('orchestrator'), embed: false });
    await orch2.run.attach({ adapter_pid: process.pid });
    const w = await openCore({ dataDir: dir2, caller: callerFor('worker', { worker_id: 'w-e' }), embed: false });
    try {
      const id = `perm-e-${crypto.randomUUID()}`;
      await w.permission.request({ id, tool: 'Bash', input: null });
      const waitPromise = w.permission.wait({ id, timeout_ms: 20000 });
      await sleep(100);
      const t0 = Date.now();
      const shutdownPromise = orch2.shutdownOwner();
      let outcome;
      try { outcome = { ok: true, value: await waitPromise }; }
      catch (e) { outcome = { ok: false, error: e }; }
      const ms = Date.now() - t0;
      assert.ok(ms < 2000, `permission.wait took ${ms} ms once the owner began stopping`);
      // The owner settles the waiter at once (engine.cjs settleWaiters, called from Owner.stop before
      // its connections are destroyed), so the in-flight call first sees its own connection close —
      // Client._lost rejects it E_OWNER_LOST. Core._write then re-runs it once, because permission.wait
      // is in RERUN_SAFE_AFTER_SEND (index.cjs, ADR 0033; it writes nothing): a worker never elects, so
      // the re-run's own connect finds no owner at all and the call's final shape is E_NO_OWNER.
      // Either way the call settles well inside the bound and never hangs.
      if (outcome.ok) assert.strictEqual(outcome.value.timed_out, true, JSON.stringify(outcome.value));
      else assert.ok(['E_OWNER_LOST', 'E_NO_OWNER'].includes(outcome.error.code), outcome.error.message);
      await shutdownPromise;
    } finally { await w.close(); }
    orch2 = null; // already shut down above
  } finally {
    if (orch2) { await orch2.shutdownOwner().catch(() => {}); await orch2.close(); }
    cleanup(dir2);
  }
});

test('permission.list: pending by default, states filters, run_id filters, adapter_alive and age_ms are derived, ordered by requested_at, and a copy answers it with no owner alive', async () => {
  const rid = 'perm-f-run';
  const wf = await openCore({ dataDir: dir, caller: { role: 'worker', worker_id: 'w-f', run_id: rid, pid: process.pid }, embed: false });
  try {
    const id1 = `perm-f1-${crypto.randomUUID()}`;
    const id2 = `perm-f2-${crypto.randomUUID()}`;
    await wf.permission.request({ id: id1, tool: 'Bash', input: null });
    await sleep(20);
    await wf.permission.request({ id: id2, tool: 'Bash', input: null });
    await operator.permission.decide({ id: id2, verdict: 'allow' });

    const pendingDefault = await operator.permission.list({ run_id: rid });
    assert.strictEqual(pendingDefault.requests.length, 1, 'default states filters to pending');
    assert.strictEqual(pendingDefault.requests[0].id, id1);
    assert.strictEqual(typeof pendingDefault.requests[0].adapter_alive, 'boolean');
    assert.strictEqual(pendingDefault.requests[0].adapter_alive, true);
    assert.ok(typeof pendingDefault.requests[0].age_ms === 'number' && pendingDefault.requests[0].age_ms >= 0);

    const both = await operator.permission.list({ run_id: rid, states: ['pending', 'allowed'] });
    assert.strictEqual(both.requests.length, 2);
    assert.deepStrictEqual(both.requests.map((r) => r.id), [id1, id2], 'ordered by requested_at ascending');

    await assert.rejects(operator.permission.list({ states: ['bogus'] }), (e) => { assert.strictEqual(e.code, 'E_ARGS'); return true; });

    const otherRun = await operator.permission.list({ run_id: 'no-such-run-at-all' });
    assert.strictEqual(otherRun.requests.length, 0, 'run_id filters');
  } finally { await wf.close(); }

  // a copy answers it with no owner alive
  const dir3 = sandbox();
  try {
    const orch3 = await openCore({ dataDir: dir3, caller: callerFor('orchestrator'), embed: false });
    await orch3.run.attach({ adapter_pid: process.pid });
    const w3 = await openCore({ dataDir: dir3, caller: callerFor('worker', { worker_id: 'w-copy' }), embed: false });
    const id3 = `perm-f3-${crypto.randomUUID()}`;
    await w3.permission.request({ id: id3, tool: 'Bash', input: null });
    await w3.close();
    await orch3.shutdownOwner();
    await orch3.close();

    const before = listDataDir(dir3);
    const opCopy = await openCore({ dataDir: dir3, caller: callerFor('operator'), embed: false });
    try {
      const listed = await opCopy.permission.list({});
      assert.strictEqual(listed.requests.length, 1);
      assert.strictEqual(listed.requests[0].id, id3);
    } finally { await opCopy.close(); }
    assert.deepStrictEqual(listDataDir(dir3), before, 'a read through a copy must create nothing new');
  } finally { cleanup(dir3); }
});
