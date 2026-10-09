// lease-keepalive.test.cjs — build step W2-2, ADR 0026. (k1)-(k7) are pure: a fake `call`, a fake clock
// and a fake `pidAlive`, so nothing here touches a store, a pid or a wall clock.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createKeepalive } = require('../../src/mcp/lease-keepalive.cjs');

const L = 600000;
const W = 'w1';

// One world: a clock, a task list, a worker row, and every call recorded.
function world(over = {}) {
  const w = {
    t: 1000000,
    leases: [{ id: 'l1', holder: W, holder_role: 'worker', granted_at: 1000000 - 400000, ttl_ms: 600000, expires_at: 1000000 + 200000 }],
    worker: { state: 'running', pid: 4242, last_event_age_ms: 1000 },
    alive: true,
    calls: [],
    logs: [],
    renewImpl: null,
    ...over,
  };
  w.call = async (method, args) => {
    w.calls.push({ method, args });
    if (method === 'task.list') return { tasks: w.leases.map((lease, i) => ({ id: `t${i}`, lease })) };
    if (method === 'worker.get') return { ...w.worker };
    if (method === 'lease.renew') {
      if (w.renewImpl) return w.renewImpl(args);
      // As the real core renews: expires_at and ttl_ms move, granted_at stays.
      const l = w.leases.find((x) => x && x.id === args.lease_id);
      if (l) { l.expires_at = w.t + args.ttl_ms; l.ttl_ms = args.ttl_ms; }
      return { id: args.lease_id, granted_at: l && l.granted_at, ttl_ms: args.ttl_ms, expires_at: w.t + args.ttl_ms };
    }
    throw new Error(`unexpected ${method}`);
  };
  w.log = (dir, line) => { w.logs.push({ dir, line }); };
  w.make = (extra = {}) => createKeepalive({
    call: w.call, workerId: W, log: w.log, now: () => w.t, pidAlive: () => w.alive, ...extra,
  });
  w.renews = () => w.calls.filter((c) => c.method === 'lease.renew');
  return w;
}

const entry = (w) => JSON.parse(w.logs[w.logs.length - 1].line.replace(/^lease-keepalive /, ''));

test('keepalive: a running worker with a live pid and recent events renews a lease past half its length, keeping its length', async () => {
  const w = world();
  // granted 400 s ago for 600 s: 200 s remain, under half of 600 s.
  const [r] = await w.make().tick();
  assert.strictEqual(r.action, 'renewed');
  assert.strictEqual(w.renews().length, 1);
  assert.deepStrictEqual(w.renews()[0].args, { lease_id: 'l1', ttl_ms: L }, 'the granted length, not the 600 s default by accident of equality');
  assert.strictEqual(r.expires_at, w.t + L, 'the log names the renewed row\'s expiry');
  assert.strictEqual(entry(w).action, 'renewed');
  // A non-default length is kept: a 4 s lease is renewed for 4 s.
  const v = world({ leases: [{ id: 'l2', holder: W, holder_role: 'worker', granted_at: 1000000 - 3000, ttl_ms: 4000, expires_at: 1000000 + 1000 }] });
  await v.make().tick();
  assert.deepStrictEqual(v.renews()[0].args, { lease_id: 'l2', ttl_ms: 4000 });
});

test('keepalive: no renewal before half the length has passed', async () => {
  const w = world({ leases: [{ id: 'l1', holder: W, holder_role: 'worker', granted_at: 1000000 - 100000, ttl_ms: 600000, expires_at: 1000000 + 500000 }] });
  const [r] = await w.make().tick();
  assert.strictEqual(r.action, 'skip');
  assert.strictEqual(r.reason, 'not-due');
  assert.strictEqual(w.renews().length, 0);
  // One millisecond more than half remaining is still not due.
  w.leases[0].expires_at = w.t + L / 2 + 1;
  assert.strictEqual((await w.make().tick())[0].reason, 'not-due');
  const v = world({ leases: [{ id: 'l1', holder: W, holder_role: 'worker', granted_at: 1000000 - 300001, ttl_ms: 600000, expires_at: 1000000 + 299999 }] });
  assert.strictEqual((await v.make().tick())[0].action, 'renewed');
});

test('keepalive: a worker that is not running, whose pid is dead, or that is silent for a lease length is not renewed, each reason named', async () => {
  for (const state of ['paused', 'stopped', 'dead', 'idle', 'starting']) {
    const w = world({ worker: { state, pid: 4242, last_event_age_ms: 10 } });
    const [r] = await w.make().tick();
    assert.strictEqual(r.reason, 'not-running', state);
    assert.strictEqual(w.renews().length, 0, state);
  }
  const dead = world({ alive: false });
  assert.strictEqual((await dead.make().tick())[0].reason, 'pid-dead');
  assert.strictEqual(dead.renews().length, 0);
  const nopid = world({ worker: { state: 'running', pid: null, last_event_age_ms: 10 } });
  assert.strictEqual((await nopid.make().tick())[0].reason, 'pid-dead');
  const silent = world({ worker: { state: 'running', pid: 4242, last_event_age_ms: L } });
  assert.strictEqual((await silent.make().tick())[0].reason, 'silent');
  assert.strictEqual(silent.renews().length, 0);
  const never = world({ worker: { state: 'running', pid: 4242, last_event_age_ms: null } });
  assert.strictEqual((await never.make().tick())[0].reason, 'silent');
  // One millisecond under a lease length is not silent.
  const edge = world({ worker: { state: 'running', pid: 4242, last_event_age_ms: L - 1 } });
  assert.strictEqual((await edge.make().tick())[0].action, 'renewed');
});

test('keepalive: a released, superseded or other worker\'s lease is never renewed', async () => {
  const base = { granted_at: 1000000 - 500000, ttl_ms: 600000, expires_at: 1000000 + 100000 };
  const cases = {
    'another worker': [{ id: 'l1', holder: 'w2', holder_role: 'worker', ...base }],
    'the operator': [{ id: 'l1', holder: W, holder_role: 'operator', ...base }],
    'released': [{ id: 'l1', holder: W, holder_role: 'worker', released_at: 999999, ...base }],
    'expired': [{ id: 'l1', holder: W, holder_role: 'worker', granted_at: 1000000 - 700000, ttl_ms: 600000, expires_at: 1000000 - 100000 }],
    'no lease at all (task.list shows a released or superseded lease as null)': [null],
    'no task': [],
  };
  for (const [name, leases] of Object.entries(cases)) {
    const w = world({ leases });
    const out = await w.make().tick();
    assert.strictEqual(out.length, 1, name);
    assert.strictEqual(out[0].reason, 'no-lease', name);
    assert.strictEqual(w.renews().length, 0, name);
  }
  // Two tasks, one mine and one another worker's: only mine is renewed.
  const w = world({ leases: [
    { id: 'lx', holder: 'w2', holder_role: 'worker', ...base },
    { id: 'l1', holder: W, holder_role: 'worker', ...base },
  ] });
  await w.make().tick();
  assert.deepStrictEqual(w.renews().map((c) => c.args.lease_id), ['l1']);
});

test('keepalive: a refused renew is logged and the next tick carries on', async () => {
  const w = world();
  w.renewImpl = () => { const e = new Error('expired'); e.code = 'E_LEASE_EXPIRED'; throw e; };
  const [r] = await w.make().tick();
  assert.strictEqual(r.action, 'skip');
  assert.match(r.reason, /E_LEASE_EXPIRED/);
  assert.match(entry(w).reason, /E_LEASE_EXPIRED/);
  // The next tick finds whatever lease is current, here a new one, and renews it.
  const k = w.make();
  await k.tick();
  w.renewImpl = null;
  w.leases = [{ id: 'l9', holder: W, holder_role: 'worker', granted_at: w.t - 500000, ttl_ms: 600000, expires_at: w.t + 100000 }];
  const [r2] = await k.tick();
  assert.strictEqual(r2.action, 'renewed');
  assert.strictEqual(w.renews().pop().args.lease_id, 'l9');
  // A failing task.list does not throw either.
  const bad = world();
  bad.call = async () => { throw Object.assign(new Error('no owner'), { code: 'E_NO_OWNER' }); };
  const [r3] = await bad.make().tick();
  assert.strictEqual(r3.action, 'skip');
});

test('keepalive: stop clears the timer and a tick in flight is not overlapped', async () => {
  const w = world();
  const timers = [];
  const cleared = [];
  let unrefs = 0;
  const setTimer = (fn, ms) => { const h = { fn, ms, unref() { unrefs += 1; } }; timers.push(h); return h; };
  const clearTimer = (h) => { cleared.push(h); };
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = w.call;
  let listCalls = 0;
  w.call = async (m, a) => { if (m === 'task.list') { listCalls += 1; await gate; } return slow(m, a); };
  const k = w.make({ setTimer, clearTimer, tickMs: 250 });
  k.start();
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 250);
  assert.strictEqual(unrefs, 1, 'the timer is unref\'d so it never keeps the adapter alive');
  timers[0].fn(); // tick 1 starts and blocks on task.list
  timers[1].fn(); // tick 2 fires while tick 1 is in flight
  assert.strictEqual(listCalls, 1, 'the second tick did not start a second read');
  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(w.renews().length, 1, 'exactly one renewal came of the two firings');
  k.stop();
  assert.strictEqual(cleared.length, 1);
  assert.strictEqual(cleared[0], timers[timers.length - 1]);
  k.stop(); // twice is harmless
  assert.strictEqual(cleared.length, 1);
  // stop then start again works, and stop never throws even if clearTimer does.
  const t2 = world();
  const k2 = t2.make({ setTimer, clearTimer: () => { throw new Error('boom'); } });
  k2.start();
  assert.doesNotThrow(() => k2.stop());
});

test('keepalive: nothing is written to stdout', async () => {
  const seen = [];
  const orig = process.stdout.write;
  process.stdout.write = function w(chunk, ...rest) { seen.push(String(chunk)); return true; };
  try {
    const w = world();
    const k = w.make({ setTimer: () => ({ unref() {} }), clearTimer() {} });
    k.start();
    await k.tick(); // renewed
    w.worker.state = 'paused';
    await k.tick(); // skip
    w.renewImpl = null;
    w.leases = [];
    await k.tick(); // no lease
    k.stop();
    assert.ok(w.logs.length >= 3, 'the ticks did log, to the log function');
    const quiet = createKeepalive({ call: w.call, workerId: W, now: () => w.t, pidAlive: () => true });
    await quiet.tick(); // no log function at all
  } finally {
    process.stdout.write = orig;
  }
  // The test runner's own reporting travels the same stream, so only what the keepalive could have
  // written is looked for: its log line, or its entry fields.
  const mine = seen.filter((c) => c.includes("lease-keepalive {") || c.includes("\"action\":") || c.includes("\"lease_id\":"));
  assert.deepStrictEqual(mine, [], `stdout received ${JSON.stringify(mine)}`);
});

test('keepalive: the length is the lease\'s ttl_ms, unchanged across renewals and adapter restarts', async () => {
  const granted = 1000000;
  const w = world({ t: granted, leases: [{ id: 'l1', holder: W, holder_role: 'worker', granted_at: granted, ttl_ms: L, expires_at: granted + L }] });
  // Three adapter processes over one lease: each is a fresh keepalive with no memory, ticking every 60 s
  // for 400 s and then gone, as a restart, a park and resume, or a Codex turn ends one.
  for (let proc = 0; proc < 3; proc += 1) {
    const k = w.make();
    for (let i = 0; i < 7; i += 1) {
      await k.tick();
      assert.ok(w.leases[0].expires_at > w.t, `the lease lapsed at process ${proc}, tick ${i}`);
      w.t += 60000;
    }
  }
  assert.ok(w.renews().length >= 3, `only ${w.renews().length} renewals over 1,260 s`);
  for (const r of w.renews()) assert.strictEqual(r.args.ttl_ms, L, 'every renewal passes the lease\'s ttl_ms');
  assert.strictEqual(w.leases[0].granted_at, granted, 'renew leaves granted_at, as the real core does');
  assert.ok(w.leases[0].expires_at - w.t <= L, 'the lease was never lengthened');
});

test('keepalive: an old lease without ttl_ms falls back to the remaining time at first sight', async () => {
  const w = world({ leases: [{ id: 'l1', holder: W, holder_role: 'worker', granted_at: 1000000 - 100000, expires_at: 1000000 + 500000 }] });
  const k = w.make();
  assert.strictEqual((await k.tick())[0].reason, 'not-due', 'first sight: all of the remaining time remains');
  w.t += 260000; // 240 s remain, under half of the 500 s first seen
  const [r] = await k.tick();
  assert.strictEqual(r.action, 'renewed');
  assert.deepStrictEqual(w.renews()[0].args, { lease_id: 'l1', ttl_ms: 500000 }, 'not expires_at - granted_at (600 s)');
});
