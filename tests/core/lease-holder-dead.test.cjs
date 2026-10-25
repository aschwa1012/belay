'use strict';
// lease-holder-dead.test.cjs — ADR 0026 amendment 1 (proposed): a worker whose death belay establishes gives up its leases at
// once. Every death path the core owns is driven: worker.write's first dead row, run.attach's dead-pid marks, run.end's close.
// A park, a stop, a restart's held death (keep_leases) and a second dead row release nothing. Real core; dead pids are planted.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, cores = [];
const open = async (runId, role = 'orchestrator') => {
  const c = await openCore({ dataDir: dir, caller: callerFor(role, { run_id: runId }), embed: false });
  cores.push(c);
  return c;
};

before(() => { dir = sandbox(); });
after(async () => {
  for (const c of cores.slice(1)) await c.close();
  if (cores[0]) { await cores[0].shutdownOwner(); await cores[0].close(); }
  cleanup(dir);
});

const live = (id) => ({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });

// A run with one worker holding a lease on a task that owns a file.
async function leased(runId, workerId) {
  const c = await open(runId);
  await c.run.attach({ adapter_pid: process.pid });
  await c.worker.write(live(workerId));
  const t = await c.task.create({ spec: `work of ${workerId}`, files_owned: [`${runId}/${workerId}.js`] });
  const lease = (await c.task.assign({ task_id: t.id, worker_id: workerId })).new_lease;
  return { c, t, lease };
}

const leaseRows = async (c, leaseId, since) => {
  const d = await c.store.diff({ since_ms: since });
  return [...d.tables.lease.added, ...d.tables.lease.updated].filter((r) => r.id === leaseId);
};

test('the first dead row releases the worker\'s lease as holder_dead, reopens its task and names it on the row', async () => {
  const since = Date.now() - 1;
  const { c, t, lease } = await leased('run-dead', 'wd');
  const row = await c.worker.write({ id: 'wd', state: 'dead', pid: deadPid(), exit_code: 1, death_established_by: 'exit-event' });
  assert.deepStrictEqual(row.leases_released, [{ lease_id: lease.id, task_id: t.id }]);
  const task = await c.task.get({ task_id: t.id });
  assert.deepStrictEqual([task.state, task.lease, task.holds_files], ['open', null, true], 'open, unleased, and the task still holds its paths');
  const last = (await leaseRows(c, lease.id, since)).pop();
  assert.deepStrictEqual([last.released_reason, last.released_at != null], ['holder_dead', true]);
  // Assignable at once to another worker, no expiry waited out.
  await c.worker.write(live('wd2'));
  const again = await c.task.assign({ task_id: t.id, worker_id: 'wd2' });
  assert.deepStrictEqual([again.task.state, again.new_lease.holder, again.new_lease.supersedes], ['assigned', 'wd2', lease.id]);
  // A second dead row (the exit code filled in later) releases nothing more, and keeps the first one's record.
  const fill = await c.worker.write({ id: 'wd', state: 'dead', exit_code: 1, death_established_by: 'pid-poll+exit-event' });
  assert.deepStrictEqual(fill.leases_released, row.leases_released);
  assert.strictEqual((await c.task.get({ task_id: t.id })).lease.holder, 'wd2', 'the new holder keeps its lease');
  // The next life's rows carry no released list.
  const next = await c.worker.write(live('wd'));
  assert.strictEqual(next.leases_released, null);
});

test('a restart\'s held death (keep_leases), a park and a stop keep the lease', async () => {
  for (const [wid, write] of [
    ['wk', { state: 'dead', pid: deadPid(), death_established_by: 'pid-check-on-restart', keep_leases: true }],
    ['wp', { state: 'paused', paused_at: Date.now(), paused_by: 'operator' }],
    ['ws', { state: 'stopped', pid: deadPid(), death_established_by: 'exit-event' }],
  ]) {
    const { c, t, lease } = await leased(`run-${wid}`, wid);
    const row = await c.worker.write({ id: wid, ...write });
    assert.strictEqual(row.leases_released, null, wid);
    assert.strictEqual(row.keep_leases, undefined, 'keep_leases is a directive, never a column');
    const task = await c.task.get({ task_id: t.id });
    assert.deepStrictEqual([task.state, task.lease && task.lease.id], ['assigned', lease.id], wid);
  }
});

test('run.end\'s close and run.attach\'s dead-pid mark release the leases of the workers they mark dead', async () => {
  const e = await leased('run-end', 'we');
  await e.c.worker.write({ ...live('we'), pid: deadPid(), state: 'stopping' });
  const ended = await e.c.run.end({ exit_reason: 'test' });
  const m = ended.workers_marked_dead.find((x) => x.worker_id === 'we');
  assert.deepStrictEqual(m.leases_released, [{ lease_id: e.lease.id, task_id: e.t.id }]);
  assert.strictEqual((await e.c.task.get({ task_id: e.t.id })).state, 'open');

  const a = await leased('run-att', 'wa');
  await a.c.worker.write({ ...live('wa'), pid: deadPid(), state: 'stopping' });
  const re = await (await open('run-att')).run.attach({ adapter_pid: process.pid });
  assert.deepStrictEqual(re.workers_marked_dead, ['wa']);
  assert.deepStrictEqual((await a.c.worker.get({ worker_id: 'wa' })).leases_released, [{ lease_id: a.lease.id, task_id: a.t.id }]);
  assert.deepStrictEqual([(await a.c.task.get({ task_id: a.t.id })).state, (await a.c.task.get({ task_id: a.t.id })).lease], ['open', null]);
});

test('a task its worker already released stays released when that worker dies', async () => {
  const { c, t, lease } = await leased('run-rel', 'wr');
  const w = await openCore({ dataDir: dir, caller: callerFor('worker', { run_id: 'run-rel', worker_id: 'wr' }), embed: false });
  cores.push(w);
  await w.lease.release({ lease_id: lease.id });
  const row = await c.worker.write({ id: 'wr', state: 'dead', pid: deadPid(), death_established_by: 'exit-event' });
  assert.strictEqual(row.leases_released, null, 'a lease the worker released itself is not released again');
  assert.strictEqual((await c.task.get({ task_id: t.id })).state, 'released');
});

const workerCore = async (runId, workerId) => {
  const w = await openCore({ dataDir: dir, caller: callerFor('worker', { run_id: runId, worker_id: workerId }), embed: false });
  cores.push(w);
  return w;
};
const deadRow = (id) => ({ id, state: 'dead', pid: deadPid(), exit_code: 1, death_established_by: 'exit-event' });

test('a hand-back that reaches the core after its holder\'s dead row is accepted as a release, and the receipt says why', async () => {
  const since = Date.now() - 1;
  const { c, t, lease } = await leased('run-late', 'wl');
  const w = await workerCore('run-late', 'wl');
  await c.worker.write(deadRow('wl')); // the interleaving: the death lands first, the adapter's release after it
  const before = await leaseRows(c, lease.id, since);
  const out = await w.lease.release({ lease_id: lease.id, result: { summary: 'did it' } });
  const after = await leaseRows(c, lease.id, since);
  assert.deepStrictEqual(after.map((r) => [r.seq, r.released_at, r.released_reason]), before.map((r) => [r.seq, r.released_at, r.released_reason]), 'the lease row is not written again: its death release stands');
  assert.deepStrictEqual([out.state, out.handoff.result, out.handoff.lease_id, out.lease_released_by], ['released', { summary: 'did it' }, lease.id, 'holder_dead']);
  assert.match(out.note, /already released when its holder wl died/);
  const task = await c.task.get({ task_id: t.id });
  assert.deepStrictEqual([task.state, task.handoff.by], ['released', 'wl']);
  await assert.rejects(w.lease.release({ lease_id: lease.id, result: { again: 1 } }), (e) => e.code === 'E_ARGS', 'accepted once: the task is no longer open');
});

test('a late hand-back on a task given to another worker since is refused, naming the death release and the new holder', async () => {
  const { c, t, lease } = await leased('run-late2', 'wm');
  const w = await workerCore('run-late2', 'wm');
  await c.worker.write(deadRow('wm'));
  await c.worker.write(live('wn'));
  const next = (await c.task.assign({ task_id: t.id, worker_id: 'wn' })).new_lease;
  await assert.rejects(w.lease.release({ lease_id: lease.id, result: { summary: 'late' } }), (e) => {
    assert.strictEqual(e.code, 'E_LEASE_EXPIRED');
    assert.match(e.message, /released when its holder wm died \(holder_dead\).*leased to worker wn/);
    assert.deepStrictEqual([e.detail.superseded_by, e.detail.current_holder], [next.id, 'wn']);
    return true;
  });
  const task = await c.task.get({ task_id: t.id });
  assert.deepStrictEqual([task.state, task.handoff, task.lease.holder], ['assigned', null, 'wn']);
});

test('a relaunch of a worker whose death released its lease gets the same lease back while the task is open, and none otherwise', async () => {
  const { c, t, lease } = await leased('run-re', 'wq');
  await c.worker.write(deadRow('wq'));
  const back = await c.task.ensureHold({ task_id: t.id, worker_id: 'wq' });
  assert.deepStrictEqual([back.reason, back.regranted, back.lease_id], ['regranted', true, lease.id]);
  const task = await c.task.get({ task_id: t.id });
  assert.deepStrictEqual([task.state, task.lease.id, task.lease.holder], ['assigned', lease.id, 'wq'], 'the same lease id, so the relaunched worker can still renew and release it');
  const w = await workerCore('run-re', 'wq');
  await c.worker.write(live('wq'));
  assert.strictEqual((await w.lease.renew({ lease_id: lease.id })).id, lease.id);

  const o = await leased('run-re2', 'wr2');
  await o.c.worker.write(deadRow('wr2'));
  await o.c.worker.write(live('ws2'));
  await o.c.task.assign({ task_id: o.t.id, worker_id: 'ws2' });
  const lost = await o.c.task.ensureHold({ task_id: o.t.id, worker_id: 'wr2' });
  assert.deepStrictEqual([lost.held, lost.reason, lost.lease_id, lost.task_state, lost.current_holder], [false, 'lease_lost', o.lease.id, 'assigned', 'worker ws2']);
  assert.strictEqual((await o.c.task.get({ task_id: o.t.id })).lease.holder, 'ws2', 'nothing written: one live holder');

  const d = await leased('run-re3', 'wt3');
  await d.c.worker.write(deadRow('wt3'));
  await d.c.task.cancel({ task_id: d.t.id, reason: 'not needed' });
  const gone = await d.c.task.ensureHold({ task_id: d.t.id, worker_id: 'wt3' });
  assert.deepStrictEqual([gone.reason, gone.task_state, gone.current_holder], ['lease_lost', 'cancelled', null]);
});

test('only a worker-role lease is released by its holder\'s death, never an operator\'s lease that shares the id', async () => {
  const { c, t } = await leased('run-role', 'operator');
  const op = await open('run-role', 'operator');
  const taken = await op.lease.takeControl({ task_id: t.id }); // holder 'operator', role operator
  assert.strictEqual(taken.new_lease.holder_role, 'operator');
  const row = await c.worker.write(deadRow('operator')); // a worker whose id is the operator's holder name dies
  assert.strictEqual(row.leases_released, null);
  const task = await c.task.get({ task_id: t.id });
  assert.deepStrictEqual([task.state, task.lease.id, task.lease.holder_role], ['assigned', taken.new_lease.id, 'operator']);
});

test('a worker whose superseded lease was released by its death, on a task whose next holder died too, gets no lease back', async () => {
  const { c, t, lease } = await leased('run-two', 'wa1');
  await c.worker.write(deadRow('wa1')); // L1 released holder_dead, the task open
  await c.worker.write(live('wa2'));
  const l2 = (await c.task.assign({ task_id: t.id, worker_id: 'wa2' })).new_lease;
  await c.worker.write(deadRow('wa2')); // L2 released holder_dead too, the task open again
  const lost = await c.task.ensureHold({ task_id: t.id, worker_id: 'wa1' });
  assert.deepStrictEqual([lost.held, lost.reason, lost.lease_id, lost.task_state], [false, 'lease_lost', lease.id, 'open']);
  const task = await c.task.get({ task_id: t.id });
  assert.deepStrictEqual([task.state, task.lease], ['open', null], 'L1 is never granted back over L2: the task waits for an assign');
  const back = await c.task.ensureHold({ task_id: t.id, worker_id: 'wa2' });
  assert.deepStrictEqual([back.reason, back.lease_id], ['regranted', l2.id], 'its last holder can still take it back');
});

test('release_leases on a dead row releases what the worker still holds, and keeps the death\'s record when nothing is left', async () => {
  const { c, t, lease } = await leased('run-rel2', 'wz');
  const first = await c.worker.write({ ...deadRow('wz'), keep_leases: true }); // a death a relaunch kept the lease for
  assert.strictEqual(first.leases_released, null);
  const restated = await c.worker.write({ id: 'wz', state: 'dead', release_leases: true });
  assert.deepStrictEqual(restated.leases_released, [{ lease_id: lease.id, task_id: t.id }]);
  assert.strictEqual(restated.release_leases, undefined, 'a directive, never a column');
  assert.deepStrictEqual([(await c.task.get({ task_id: t.id })).state, (await c.task.get({ task_id: t.id })).lease], ['open', null]);
  const again = await c.worker.write({ id: 'wz', state: 'dead', release_leases: true }); // nothing left to release
  assert.deepStrictEqual(again.leases_released, restated.leases_released, 'the death\'s record stays on the row');
});
