'use strict';
// snapshot-gate.test.cjs — ADR 0048 decision 7.3: the share-next ordering, driven against the gate with fake
// snapshots resolved by hand. No PowerShell and no sleeps; the only timers are the deadline and timeout cases,
// which end on their own event.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { createGate } = require('../../src/core/snapshot-gate.cjs');
const ID = require('../../src/core/proc-identity.cjs');
const P = require('../../src/core/process.cjs');
const PI = require('../../src/run/pid-identity.cjs');

const mapOf = (rows) => new Map(rows.map(([pid, created]) => [pid, { ppid: 1, created, image: 'node.exe' }]));
// Two turns of the loop: the gate starts a waiting snapshot on a setImmediate registered after a take settles.
const tick = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

// A gate whose snapshots the test resolves by hand: take() records each call and hands back its resolver.
function handGate(opts = {}) {
  const takes = [];
  const gate = createGate({ take: ({ batch }) => new Promise((resolve) => { takes.push({ batch, resolve }); }), ...opts });
  return { gate, takes };
}

test('a request that arrives while a snapshot is in flight is served by the next one, which starts after its request', async () => {
  const { gate, takes } = handGate();
  const a = gate.request();
  assert.strictEqual(takes.length, 1, 'A: nothing in flight, so S1 starts at once');
  const b = gate.request();
  let bDone = false; b.then(() => { bDone = true; });
  takes[0].resolve(mapOf([[1, 1]]));
  const ra = await a;
  await tick();
  assert.strictEqual(bDone, false, 'B is not served by S1');
  assert.strictEqual(takes.length, 2, 'S2 started when S1 ended');
  takes[1].resolve(mapOf([[1, 2]]));
  const rb = await b;
  assert.strictEqual(rb.snap.get(1).created, 2);
  assert.ok(rb.startSeq > rb.reqSeq, `S2.startSeq ${rb.startSeq} must follow B's request ${rb.reqSeq}`);
  assert.ok(ra.startSeq < rb.startSeq);
});

test('two callers that join while one is in flight cause exactly one more snapshot and both get it', async () => {
  const { gate, takes } = handGate();
  const a = gate.request();
  const b = gate.request({ kind: 'kill' }); const c = gate.request({ kind: 'spawn-read' });
  takes[0].resolve(mapOf([[1, 1]]));
  await a; await tick();
  assert.strictEqual(takes.length, 2, 'exactly two spawns in all');
  takes[1].resolve(mapOf([[1, 2]]));
  const [rb, rc] = await Promise.all([b, c]);
  assert.strictEqual(rb.startSeq, rc.startSeq);
  assert.strictEqual(rb.callers, 2);
  assert.deepStrictEqual([...rb.kinds].sort(), ['kill', 'spawn-read']);
  assert.strictEqual(takes.length, 2);
});

test('a signal stamped after a snapshot started fails the use check; the caller re-takes once, and a second interleaved signal refuses', async () => {
  const { gate, takes } = handGate();
  const b = gate.request();
  takes[0].resolve(mapOf([[1, 1]]));
  const r2 = await b; await tick();
  assert.strictEqual(gate.fresh(r2.startSeq), true, 'no signal since it started');
  gate.signal();
  assert.strictEqual(gate.fresh(r2.startSeq), false, 'a signal after the start makes it unusable');
  const again = gate.request();
  takes[1].resolve(mapOf([[1, 3]]));
  const r3 = await again;
  assert.strictEqual(gate.fresh(r3.startSeq), true, 'S3 started after the signal');
  // The same through the kill path, on the real gate's counter: each snapshot is overtaken by a signal.
  const realShared = ID.snapshotShared;
  const calls = []; let overtake = 2;
  ID.snapshotShared = async () => { const startSeq = ID.gate.stamp(); calls.push(startSeq); if (overtake-- > 0) ID.gate.signal(); return { snap: mapOf([[4301, 5]]), startSeq, error: null }; };
  try {
    const sent = [];
    const r = await P.killPid({ pid: 4301, created: 5 }, 'SIGKILL', { kill: (pid) => sent.push(pid) });
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.kind, 'unverifiable');
    assert.match(r.detail, /signals in this process kept landing after each snapshot started/);
    assert.strictEqual(calls.length, 2, 'one re-take, then refused');
    assert.deepStrictEqual(sent, [], 'nothing was signalled');
    overtake = 1; calls.length = 0;
    const ok = await P.killPid({ pid: 4301, created: 5 }, 'SIGKILL', { kill: (pid) => sent.push(pid) });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(calls.length, 2, 'the re-take came after the signal and was usable');
    assert.deepStrictEqual(sent, [4301]);
    assert.ok(Number.isInteger(ok.signalled_at) && Number.isInteger(ok.snapshot_ms), 'the receipt names signalled_at and snapshot_ms');
  } finally { ID.snapshotShared = realShared; }
});

// Swap the process's gate for a hand-resolved one, so P.killPid (which reads ID.gate and ID.snapshotShared at each
// call) runs its real ordering check against snapshots the test resolves.
function withHandGate(fn) {
  const { gate, takes } = handGate();
  const realGate = ID.gate; const realShared = ID.snapshotShared;
  ID.gate = gate; ID.snapshotShared = (o) => gate.request(o);
  return Promise.resolve(fn({ gate, takes })).finally(() => { ID.gate = realGate; ID.snapshotShared = realShared; });
}

test('three concurrent killers: the next snapshot starts only after the current callers have signalled, so none is refused', () => withHandGate(async ({ gate, takes }) => {
  const sent = [];
  const kill = (pid) => sent.push(pid);
  const all = mapOf([[4401, 5], [4402, 5], [4403, 5]]);
  const kA = P.killPid({ pid: 4401, created: 5 }, 'SIGKILL', { kill });
  const kB = P.killPid({ pid: 4402, created: 5 }, 'SIGKILL', { kill });
  const kC = P.killPid({ pid: 4403, created: 5 }, 'SIGKILL', { kill });
  assert.strictEqual(takes.length, 1, 'S1 serves A alone; B and C wait for the next');
  takes[0].resolve(all);
  const a = await kA; await tick();
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  assert.strictEqual(takes.length, 2, 'S2 started once A had signalled');
  assert.ok(gate.fresh(takes[1].batch.startSeq), 'S2 started after A\'s signal, so B may use it');
  takes[1].resolve(all); // B signals first; C's copy of S2 then predates a signal and is re-taken, not refused
  const b = await kB; await tick();
  assert.strictEqual(b.ok, true, JSON.stringify(b));
  assert.strictEqual(takes.length, 3, 'C re-took once: S3');
  takes[2].resolve(all);
  const c = await kC;
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  assert.deepStrictEqual(sent, [4401, 4402, 4403]);
  assert.strictEqual(takes.length, 3, 'three snapshots in all, none wasted');
}));

test('fault injection: snapshots stall while a killer arrives between them and a signal from outside lands; no kill is made on a snapshot that predates a signal, and a refusal says so', () => withHandGate(async ({ gate, takes }) => {
  const sent = [];
  const kill = (pid) => sent.push(pid);
  const snap = mapOf([[4411, 5], [4412, 5], [4413, 5]]);
  const kA = P.killPid({ pid: 4411, created: 5 }, 'SIGKILL', { kill });          // S1, stalled
  const kB = P.killPid({ pid: 4412, created: 5 }, 'SIGKILL', { kill });          // waits for S2
  takes[0].resolve(snap); const a = await kA; await tick();                     // A signals; S2 starts and stalls
  assert.strictEqual(takes.length, 2);
  const kC = P.killPid({ pid: 4413, created: 5 }, 'SIGKILL', { kill });          // arrives during S2's stall: waits for S3
  gate.signal();                                                                  // a signal from another caller, during the stall
  takes[1].resolve(snap); await tick();                                          // B's S2 predates that signal: B asks again and joins C in S3
  assert.strictEqual(takes.length, 3, 'S3 started after the outside signal and after the second request');
  takes[2].resolve(snap);
  const [b, c] = await Promise.all([kB, kC]);
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  // C is served first, signals, and so B's copy of S3 predates a signal too. B has used both of its snapshots: refused, nothing sent for it.
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.kind, 'unverifiable');
  assert.match(b.detail, /signals in this process kept landing after each snapshot started/);
  assert.deepStrictEqual(sent, [4411, 4413], 'a kill was sent only on a snapshot that started after the last signal');
  assert.strictEqual(takes.length, 3);
}));

function fakeChild(pid) { const c = new EventEmitter(); Object.assign(c, { pid, exitCode: null, signalCode: null, spawnfile: 'node.exe' }); return c; }
const noSchedule = { schedule: [1e9], every: 1e9 };

test('the spawn read: a child spawned after S1 started is never looked up in S1', async () => {
  const { gate, takes } = handGate();
  const other = gate.request();                 // S1 is in flight
  const child = fakeChild(7001); const w = { pid: 7001 };
  const read = PI.noteSpawn(w, child, { gate, createdOf: (pid) => ID.createdOf(pid, { gate }), ...noSchedule });
  await tick();
  takes[0].resolve(mapOf([[7001, Date.now()]])); // S1 even contains the pid: it started before the spawn
  await other; await tick();
  assert.strictEqual(w.pidCreated, null, 'S1 was not used for the spawn');
  assert.strictEqual(takes.length, 2);
  takes[1].resolve(mapOf([[7001, Date.now()]]));
  await read;
  assert.ok(Number.isFinite(w.pidCreated), 'S2 started after the spawn and served it');
  assert.strictEqual(w.pidCreatedError, null);
});

test('a caller\'s deadline ends only that caller\'s wait; the shared snapshot still serves the others', async () => {
  const { gate, takes } = handGate();
  const a = gate.request();
  const impatient = gate.request({ deadlineMs: 15 });
  const patient = gate.request();
  takes[0].resolve(mapOf([[1, 1]]));
  await a; await tick();
  const cut = await impatient;
  assert.strictEqual(cut.error, 'deadline');
  assert.strictEqual(cut.snap, null);
  assert.strictEqual(takes.length, 2, 'the snapshot the impatient caller joined was not cancelled');
  takes[1].resolve(mapOf([[1, 2]]));
  const got = await patient;
  assert.strictEqual(got.snap.get(1).created, 2);
  assert.strictEqual(got.callers, 2, 'the cut caller was counted in the snapshot it joined');
});

test('a snapshot that never resolves is ended by the timeout, and the waiting one starts then', async () => {
  const { gate, takes } = handGate({ timeoutMs: 25 });
  const a = gate.request();
  const b = gate.request();
  const ra = await a;
  assert.strictEqual(ra.snap, null);
  assert.strictEqual(ra.error, 'timeout'); await tick();
  assert.strictEqual(takes.length, 2, 'S2 started once S1 timed out');
  takes[1].resolve(mapOf([[1, 9]]));
  assert.strictEqual((await b).snap.get(1).created, 9);
});

test('harvest: a pending pid_created is filled only by a snapshot that started after the spawn while the handle stayed live', async () => {
  const { gate, takes } = handGate();
  const early = gate.request();                       // started before the spawn
  const child = fakeChild(7002); const w = { pid: 7002 };
  const read = PI.noteSpawn(w, child, { gate, createdOf: (pid) => ID.createdOf(pid, { gate }), ...noSchedule });
  takes[0].resolve(mapOf([[7002, Date.now()]]));      // has the pid, but started before the spawn
  await early; await tick();
  takes[1].resolve(mapOf([[1, 1]]));                  // the spawn's own read: no entry for the pid
  await read;
  assert.strictEqual(w.pidCreated, null);
  assert.match(w.pidCreatedError, /retrying while the worker runs \(try 1\)/, 'pending, not final');
  // Another caller's snapshot, started after the spawn, but the handle has exited by the time it ends.
  const late = gate.request(); await tick();
  child.exitCode = 1;
  takes[2].resolve(mapOf([[7002, Date.now()]]));
  await late; await tick();
  assert.strictEqual(w.pidCreated, null, 'a snapshot that ended after the handle exited is not accepted');
  // A live handle and a snapshot that started after the spawn fill it, with no read of its own.
  const w2 = { pid: 7003 }; const live = fakeChild(7003);
  const r2 = PI.noteSpawn(w2, live, { gate, createdOf: async () => null, ...noSchedule });
  await r2;
  assert.match(w2.pidCreatedError, /try 1/);
  const other = gate.request(); await tick();
  takes[3].resolve(mapOf([[7003, Date.now() - 5000]]));  // earlier than one second before the spawn: a misread
  await other; await tick();
  assert.strictEqual(w2.pidCreated, null, 'a creation time long before the spawn is a misread');
  const other2 = gate.request(); await tick();
  takes[4].resolve(mapOf([[7003, Date.now()]]));
  await other2; await tick();
  assert.ok(Number.isFinite(w2.pidCreated));
  assert.strictEqual(w2.pidCreatedError, null);
});

test('a worker that exits before its creation time was read has a final error', async () => {
  const { gate, takes } = handGate();
  const child = fakeChild(7004); const w = { pid: 7004 };
  const read = PI.noteSpawn(w, child, { gate, createdOf: (pid) => ID.createdOf(pid, { gate }), ...noSchedule });
  await tick();
  takes[0].resolve(mapOf([[1, 1]]));
  await read;
  child.exitCode = 0; child.emit('exit', 0, null);
  assert.match(w.pidCreatedError, /^never read: the worker exited before its creation time was read \(1 try\)$/);
});

test('the creation-time slack is taken from before the spawn call, on the first read and on later ones', async () => {
  const now = Date.now();
  // The spawn call returned 3 s after CreateProcess started (antivirus): the process's creation time is 3 s before noteSpawn runs.
  const slow = fakeChild(7010); slow.belaySpawnStartedAt = now - 3000;
  const w = { pid: 7010 };
  await PI.noteSpawn(w, slow, { createdOf: async () => ({ created: now - 3200 }), ...noSchedule });
  assert.strictEqual(w.pidCreated, now - 3200, 'a creation time within 1 s of the spawn call start is accepted on the first read');
  const early = fakeChild(7011); early.belaySpawnStartedAt = now;
  const w2 = { pid: 7011 };
  await PI.noteSpawn(w2, early, { createdOf: async () => ({ created: now - 5000 }), ...noSchedule });
  assert.strictEqual(w2.pidCreated, null, 'a creation time long before the spawn is a misread on the first read too');
  assert.match(w2.pidCreatedError, /retrying while the worker runs/);
  // A late reading uses the same stamp.
  const { gate, takes } = handGate();
  const w3 = { pid: 7012 }; const c3 = fakeChild(7012); c3.belaySpawnStartedAt = Date.now() - 3000;
  await PI.noteSpawn(w3, c3, { gate, createdOf: async () => null, ...noSchedule });
  const other = gate.request(); await tick();
  takes[0].resolve(mapOf([[7012, Date.now() - 3500]]));
  await other; await tick(); // harvesters run after the next macrotask
  assert.ok(Number.isFinite(w3.pidCreated), 'a late reading within the slack of the call start is accepted');
});
