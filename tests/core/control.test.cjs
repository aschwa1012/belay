'use strict';
// control.test.cjs — build step 5c, design items 1 and 2.
// Drives Owner and Core in-process against a sandbox under the OS temp dir, in the shape of
// tests/core/ownership.test.cjs: helpers.cjs's sandbox, callerFor, listDataDir; every owner stopped
// through shutdownOwner() in a finally. These tests establish `run.stop` as a third pipe-level method
// dispatched to a control the owner was constructed with, and `Core.control(method, params)` as the
// mode-C caller of it (never elects, never dials with no live owner to dial).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, deadPid, listDataDir, sleep } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

test('control: run.stop reaches the control the owner was constructed with, and the reply carries what it returned', async () => {
  const dir = sandbox();
  let orch = null;
  try {
    orch = await openCore({
      dataDir: dir, caller: callerFor('orchestrator'), embed: false,
      ownerOpts: { controls: { 'run.stop': async (p) => ({ echoed: p.run_id, caller_role: p.caller.role }) } },
    });
    await orch.run.attach({ adapter_pid: process.pid }); // the write that elects; the owner now serves the control
    const before = listDataDir(dir);

    const op = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const result = await op.control('run.stop', { run_id: 'r1' });
    assert.deepStrictEqual(result, { echoed: 'r1', caller_role: 'operator' });
    assert.deepStrictEqual(listDataDir(dir), before, 'mode C created nothing');
    await op.close();
  } finally {
    if (orch) { await orch.shutdownOwner().catch(() => {}); await orch.close(); }
    cleanup(dir);
  }
});

test('control: a worker-role caller is refused E_ROLE, and an owner with no controls answers E_NOT_FOUND', async () => {
  const dir = sandbox();
  let orch = null;
  try {
    orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false }); // no controls
    await orch.run.attach({ adapter_pid: process.pid });

    const worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1' }), embed: false });
    await assert.rejects(worker.control('run.stop', { run_id: 'r1' }), (e) => {
      assert.strictEqual(e.code, 'E_ROLE');
      assert.deepStrictEqual(e.detail.allowed, ['operator']);
      return true;
    });
    await worker.close();

    const op = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    await assert.rejects(op.control('run.stop', { run_id: 'r1' }), (e) => {
      assert.strictEqual(e.code, 'E_NOT_FOUND');
      assert.deepStrictEqual(e.detail.controls, []);
      return true;
    });
    await op.close();
  } finally {
    if (orch) { await orch.shutdownOwner().catch(() => {}); await orch.close(); }
    cleanup(dir);
  }
});

test('control: with no owner, control rejects E_NO_OWNER without dialling and creates nothing', async () => {
  const dir = sandbox();
  try {
    const before = listDataDir(dir);
    const c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const t0 = Date.now();
    await assert.rejects(c.control('run.stop', { run_id: 'r1' }), (e) => { assert.strictEqual(e.code, 'E_NO_OWNER'); return true; });
    // control() dials with elect:false and connectRetries:1, so a missing pipe fails at once. The bug the 3000 bound
    // catches is a default 25-retry connect (about 5 s). 200 ms left no room for a loaded runner's scheduling.
    assert.ok(Date.now() - t0 < 3000, `control took ${Date.now() - t0} ms with no lock at all`);
    assert.deepStrictEqual(listDataDir(dir), before, 'no lock means control creates nothing');
    await c.close();

    fs.mkdirSync(path.join(dir, 'owner.lock'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'owner.lock', 'owner.json'), JSON.stringify({ pid: deadPid(), pipe: 'x', listening: true, acquired_at: Date.now() }));
    const c2 = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const t1 = Date.now();
    await assert.rejects(c2.control('run.stop', { run_id: 'r1' }), (e) => { assert.strictEqual(e.code, 'E_NO_OWNER'); return true; });
    assert.ok(Date.now() - t1 < 3000, `control took ${Date.now() - t1} ms against a lock naming a dead pid`);
    await c2.close();
  } finally { cleanup(dir); }
});

// 5c-2 Done item 4 (design item 3): an owner.lock directory present but with no readable owner.json
// inside — an election window becomeOwner() rides out with rereadOwnerPid, which control did not
// before this step — must not be reported the same as "no owner.lock exists at all".
test('control: an owner.lock directory with no owner.json names no readable owner, not a missing lock', async () => {
  const dir = sandbox();
  try {
    fs.mkdirSync(path.join(dir, 'owner.lock'), { recursive: true }); // no owner.json inside
    const before = listDataDir(dir);
    const c = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const t0 = Date.now();
    await assert.rejects(c.control('run.stop', { run_id: 'r1' }), (e) => {
      assert.strictEqual(e.code, 'E_NO_OWNER');
      assert.strictEqual(e.detail.lock_dir_present, true);
      assert.match(e.message, /names no readable owner/);
      return true;
    });
    assert.ok(Date.now() - t0 < 500, `control took ${Date.now() - t0} ms against a lock dir with no owner.json`);
    assert.deepStrictEqual(listDataDir(dir), before, 'control created something beyond the pre-existing empty lock dir');
    await c.close();
  } finally { cleanup(dir); }
});

test("control: an owner stopping while a control is in flight still delivers that control's reply", async () => {
  const dir = sandbox();
  let orch = null;
  try {
    orch = await openCore({
      dataDir: dir, caller: callerFor('orchestrator'), embed: false,
      ownerOpts: { controls: { 'run.stop': async () => { await sleep(300); return { ok: true }; } } },
    });
    await orch.run.attach({ adapter_pid: process.pid });

    const op = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
    const order = [];
    const controlPromise = op.control('run.stop', { run_id: 'r1' }).then((r) => { order.push('control'); return r; });
    await sleep(50);
    const shutdownPromise = orch.shutdownOwner().then((r) => { order.push('shutdown'); return r; });

    const [result] = await Promise.all([controlPromise, shutdownPromise]);
    assert.deepStrictEqual(result, { ok: true }, 'the in-flight control resolved with its own result, not E_OWNER_LOST');
    assert.deepStrictEqual(order, ['control', 'shutdown'], `expected the control's reply before shutdownOwner resolved, got ${JSON.stringify(order)}`);
    await op.close();
    orch = null; // already shut down above
  } finally {
    if (orch) { await orch.shutdownOwner().catch(() => {}); await orch.close(); }
    cleanup(dir);
  }
});

// 5c-2 design item 2, Done item 3: _dispatchRunStop's fail() path starts its reply write but, before
// this step, never added it to inFlightControls — a refusal (E_ROLE here) racing an owner shutdown
// could be dropped rather than flushed, and the caller then sees a transport fault (E_OWNER_LOST)
// instead of the refusal the owner actually computed.
//
// 5c-2 fix round (FINDINGS.json should-fix, line 170): the real-two-connections version of this test
// raced a separately-connected worker's `control` call against a separately-connected orchestrator's
// `shutdownOwner()`, and the reviewer drove it at every gap from 3 ms to 30 ms and found the fixed and
// reverted trees answer identically at every one — a refusal payload is a few hundred bytes, handed to
// the OS well inside a millisecond, long before a second connection's shutdown call over a real pipe
// round trip could ever reach `destroy()`. No timing gap reachable from two real connections lands this
// race on any host. So this drives `Owner._dispatchRunStop` and `Owner.stop()` directly, in the same
// process and the very same tick, against a fake connection whose `write()` only "arrives" on a later
// macrotask — the same shape a slow flush actually has, and the shape `destroy()` actually races
// against (Node's own contract: `destroy()` discards a write not yet flushed). The race is then
// deterministic, not load-dependent: with item 2 reverted this fails every run, not one in five.
function makeFakeConn() {
  const conn = { destroyed: false, flushed: false, droppedByDestroy: false };
  conn.write = (payload, cb) => {
    setImmediate(() => {
      if (conn.destroyed) { conn.droppedByDestroy = true; return; } // what destroy() before flush does
      conn.flushed = true;
      cb();
    });
  };
  conn.destroy = () => { conn.destroyed = true; };
  return conn;
}

test('control: a refusal racing an owner shutdown is still delivered', async () => {
  const { Owner } = require('../../src/core/owner.cjs');
  const dir = sandbox();
  try {
    const owner = new Owner(dir, {}); // never start()-ed: touches no lock, no store, no pipe
    const conn = makeFakeConn();
    owner.conns.add(conn);

    owner._dispatchRunStop(conn, { id: 1, method: 'run.stop', params: { caller: { role: 'worker' } } });
    await owner.stop(); // called in the very same tick as the refusal's write: the race by construction

    assert.strictEqual(conn.droppedByDestroy, false, "the refusal's write was destroyed before it flushed");
    assert.strictEqual(conn.flushed, true, "the refusal's write callback never fired");
  } finally { cleanup(dir); }
});
