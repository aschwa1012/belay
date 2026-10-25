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
