'use strict';
// pid-identity-writes.test.cjs — ADR 0039: a pid that is alive is not enough where a row records the creation time of its process.
// run.attach, a worker written `running` and task.assign each read a worker row's pid as a life; a pid that another process now holds
// (here a real child created at another time than the row says) reads dead, a pid created as the row says reads live, and a row with
// no recorded time is judged by its pid alone, as before. The creation times are the OS's, from the process snapshot, so these run on
// Windows only.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { teardown } = require('../helpers/teardown.cjs');

const { openCore } = core('index.cjs');
const ID = core('proc-identity.cjs');
const WIN = { skip: process.platform !== 'win32' };

let dir, orch, holder, holderExited, created;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { windowsHide: true, stdio: 'ignore' });
  holderExited = new Promise((r) => holder.once('exit', r));
  const c = await ID.createdOf(holder.pid);
  created = c && c.created;
});

after(async () => {
  holder.kill();
  await holderExited;
  await teardown(null, [() => orch && orch.shutdownOwner(), () => orch && orch.close(), () => cleanup(dir)]);
});

const worker = (id, over) => ({ id, substrate: 'claude-code', pid: holder.pid, state: 'starting', turns: 0, started_at: Date.now(), ...over });

test('the holder\'s creation time is readable', WIN, () => assert.ok(created > 0));

test('worker.write running: a pid created at another time than the row records is refused', WIN, async () => {
  await assert.rejects(orch.worker.write(worker('w-other', { state: 'running', pid_created: created - 60000 })), (e) => e.code === 'E_WORKER_NOT_LIVE');
  const same = await orch.worker.write(worker('w-same', { state: 'running', pid_created: created }));
  assert.strictEqual(same.state, 'running');
  const bare = await orch.worker.write(worker('w-bare', { state: 'running' }));
  assert.strictEqual(bare.state, 'running', 'a row with no recorded creation time is judged by its pid');
});

test('worker.write running: a restart onto a new pid does not inherit the old life\'s creation time', WIN, async () => {
  await orch.worker.write(worker('w-restart', { pid: 2147482000, pid_created: 1, state: 'stopped', exit_code: 0, death_established_by: 'exit-event' }));
  const row = await orch.worker.write({ id: 'w-restart', pid: holder.pid, state: 'running' });
  assert.strictEqual(row.state, 'running');
});

test('task.assign: a worker row whose pid is held by another process is refused as not live', WIN, async () => {
  await orch.worker.write(worker('w-stale', { pid_created: created - 60000 }));
  const t = await orch.task.create({ spec: 'identity' });
  await assert.rejects(orch.task.assign({ task_id: t.id, worker_id: 'w-stale' }), (e) => e.code === 'E_WORKER_NOT_LIVE' && e.detail.pid === holder.pid);
  await orch.worker.write(worker('w-live', { pid_created: created }));
  assert.strictEqual((await orch.task.assign({ task_id: t.id, worker_id: 'w-live' })).task.state, 'assigned');
});

test('run.attach marks dead only the suspect workers whose pid is gone or held by another process', WIN, async () => {
  await orch.worker.write(worker('a-other', { pid_created: created - 60000 }));
  await orch.worker.write(worker('a-same', { pid_created: created }));
  await orch.worker.write(worker('a-bare'));
  const r = await orch.run.attach({ adapter_pid: process.pid });
  assert.ok(r.workers_marked_dead.includes('a-other'), JSON.stringify(r.workers_marked_dead));
  assert.ok(r.workers_marked_dead.includes('w-stale'));
  for (const id of ['a-same', 'a-bare', 'w-live']) assert.ok(!r.workers_marked_dead.includes(id), `${id} runs as its row records`);
  assert.strictEqual((await orch.worker.get({ worker_id: 'a-other' })).state, 'dead');
});

test('no snapshot is taken for a pid that is gone or a row with no creation time', async () => {
  const { prepare } = core('live-as.cjs');
  let taken = 0;
  const real = ID.processSnapshot;
  ID.processSnapshot = async () => { taken++; return real(); };
  try {
    const p = await prepare([{ pid: 2147483000, created: 5 }, { pid: process.pid, created: null }, { pid: null, created: 7 }]);
    assert.strictEqual(taken, 0);
    assert.strictEqual(p.runsAs(2147483000, 5), false);
    assert.strictEqual(p.runsAs(process.pid, null), true);
  } finally { ID.processSnapshot = real; }
});

// A stalled snapshot stands in for the second it costs. Counting the snapshots a write takes tells who pays for the check.
function stubSnapshot(gate) {
  const real = ID.processSnapshot;
  const calls = { n: 0 };
  ID.processSnapshot = async (o) => { calls.n++; if (gate) await gate; return real(o); };
  return { calls, restore: () => { ID.processSnapshot = real; } };
}

test('the adapter that holds the child restates a running row with no snapshot; any other caller pays one', WIN, async () => {
  await orch.worker.write(worker('w-turn', { pid_created: created }));
  const s = stubSnapshot();
  try {
    const a = await orch.worker.write({ id: 'w-turn', state: 'running', last_event_at: Date.now() }); // the bound adapter, pid unchanged
    assert.strictEqual(a.state, 'running');
    assert.strictEqual(s.calls.n, 0, 'the adapter\'s own write took a snapshot');
    const op = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { pid: process.ppid }), embed: false }); // not the run's bound adapter
    try {
      assert.strictEqual((await op.worker.write({ id: 'w-turn', state: 'running', last_event_at: Date.now() })).state, 'running');
    } finally { await op.close(); }
    assert.strictEqual(s.calls.n, 1, 'a write from another caller is checked');
  } finally { s.restore(); }
});

test('worker.write: a run that ends while the write waits on the snapshot takes no worker row', WIN, async () => {
  const d2 = sandbox();
  const o2 = await openCore({ dataDir: d2, caller: callerFor('orchestrator'), embed: false });
  const op2 = await openCore({ dataDir: d2, caller: { role: 'operator', run_id: 'test-run', pid: process.pid }, embed: false });
  let release; const gate = new Promise((r) => { release = r; });
  const s = stubSnapshot(gate);
  try {
    await o2.run.attach({ adapter_pid: process.pid });
    const pending = o2.worker.write(worker('w-late', { state: 'running', pid_created: created })).then(() => null, (e) => e);
    while (s.calls.n === 0) await new Promise((r) => setTimeout(r, 20)); // the write is waiting on the snapshot
    await op2.run.end({ exit_reason: 'ended while a write waited' });
    release();
    const e = await pending;
    assert.ok(e && e.code === 'E_ARGS' && /already ended/.test(e.message), `the write was not refused: ${e && e.message}`);
    assert.strictEqual(await o2.worker.get({ worker_id: 'w-late' }).then((w) => w && w.state, () => null), null, 'no row was written');
  } finally {
    release(); s.restore();
    await teardown(null, [() => op2.close(), () => o2.shutdownOwner(), () => o2.close(), () => cleanup(d2)]);
  }
});
