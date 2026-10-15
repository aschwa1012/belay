'use strict';
// snapshot-retry.test.cjs — ADR 0048 decisions 1 and 3 (which amend ADR 0039 review follow-up 3): a kill-time
// snapshot and the spawn-time creation-time read each take ONE attempt, never retried; an unreadable snapshot
// refuses the kill at once with the exact way to end the process by hand; a spawn whose read failed is left
// pending, not unverified for good. `snapshotRetry` remains for test helpers only.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const P = require('../../src/core/process.cjs');
const ID = require('../../src/core/proc-identity.cjs');
const PI = require('../../src/run/pid-identity.cjs');

const T = 1_800_000_000_000;
const mapOf = (rows) => new Map(rows.map(([pid, ppid, created, image]) => [pid, { ppid, created, image }]));
const noKill = () => {};

// Stands in for the gate's snapshot: `answers` in order (null = unreadable), counting calls.
function standIn(answers) {
  const real = ID.snapshotShared;
  let calls = 0;
  ID.snapshotShared = async () => {
    const a = answers[Math.min(calls, answers.length - 1)]; calls++;
    return { snap: a, error: a ? null : 'unreadable', startSeq: Infinity, reqSeq: 0, ms: 0 };
  };
  return { calls: () => calls, restore: () => { ID.snapshotShared = real; } };
}

test('snapshotRetry (for test helpers): an unreadable snapshot is taken again, up to `attempts`, with the wait doubling', async () => {
  let n = 0;
  const t0 = Date.now();
  const got = await ID.snapshotRetry({ attempts: 3, backoffMs: 50, snapshot: async () => (++n < 3 ? null : mapOf([[1, 0, T, 'x.exe']])) });
  assert.strictEqual(n, 3);
  assert.ok(got && got.get(1));
  assert.ok(Date.now() - t0 >= 140, 'the waits were 50 then 100 ms');
  n = 0;
  assert.strictEqual(await ID.snapshotRetry({ attempts: 2, backoffMs: 1, snapshot: async () => { n++; return null; } }), null);
  assert.strictEqual(n, 2, 'never more than `attempts`');
});

test('the snapshot budget is one attempt of 8000 ms, and the retry constants are gone', () => {
  assert.strictEqual(ID.SNAPSHOT_TIMEOUT_MS, 8000);
  assert.strictEqual(P.KILL_SNAPSHOT_ATTEMPTS, undefined);
  assert.strictEqual(PI.SPAWN_READ_ATTEMPTS, undefined);
});

test('kill: an unreadable kill-time snapshot refuses at once, after exactly one attempt, and says why', async () => {
  const s = standIn([null]);
  try {
    const r = await P.killPid({ pid: 4202, created: T }, 'SIGKILL', { kill: noKill });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'unverifiable');
    assert.strictEqual(s.calls(), 1, 'no retry');
    assert.match(r.manual, /Stop-Process -Id 4202/);
    assert.ok(Number.isFinite(r.snapshot_ms), 'the refusal reports how long the snapshot took');
  } finally { s.restore(); }
});

test('kill: a readable snapshot kills on the first attempt and the receipt carries signalled_at and snapshot_ms', async () => {
  const s = standIn([mapOf([[4201, 1, T, 'node.exe']])]);
  try {
    const before = Date.now();
    const r = await P.killPid({ pid: 4201, created: T }, 'SIGKILL', { kill: noKill });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(s.calls(), 1);
    assert.ok(r.signalled_at >= before && r.signalled_at <= Date.now(), 'signalled_at is the signal, in ms since the epoch');
    assert.ok(Number.isFinite(r.snapshot_ms) && r.snapshot_ms >= 0);
  } finally { s.restore(); }
});

test('spawn: one read; a failure leaves the row pending (error names the retry), never final while the worker runs', async () => {
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  let calls = 0;
  try {
    const w = { pid: live.pid };
    await PI.noteSpawn(w, live, { createdOf: async () => { calls++; return null; }, schedule: [1e9], every: 1e9 });
    assert.strictEqual(calls, 1, 'one read, no retry');
    assert.strictEqual(w.pidCreated, null);
    assert.match(w.pidCreatedError, /retrying while the worker runs \(try 1\)/);
    // Another process meeting this row refuses, and says it may be verified shortly.
    const k = await P.killProcess(P.rowTarget({ pid: 4203, substrate: 'claude-code', pid_image: 'claude.exe', pid_created_error: w.pidCreatedError }), { kill: noKill, snapshot: async () => mapOf([[4203, 1, T, 'claude.exe']]) });
    assert.strictEqual(k.refused.kind, 'unverifiable');
    assert.match(k.refused.manual, /verified shortly/);
  } finally { live.kill(); }
});

test('spawn: a read that lands gives the row its creation time on the first attempt', async () => {
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  const s = standIn([mapOf([[live.pid, process.pid, T + 5, 'node.exe']])]);
  try {
    const w = { pid: live.pid };
    await PI.noteSpawn(w, live, { createdOf: (pid) => ID.createdOf(pid, { snapshot: async () => (await ID.snapshotShared()).snap }) });
    assert.strictEqual(s.calls(), 1);
    assert.strictEqual(w.pidCreated, T + 5);
    assert.strictEqual(w.pidCreatedError, null);
  } finally { s.restore(); live.kill(); }
});

test('an unverified row is refused with the pid, the image and the exact way to end it by hand; a mismatch is not', async () => {
  const k = await P.killProcess(P.rowTarget({ pid: 4203, substrate: 'claude-code', pid_image: 'claude.exe', pid_created_error: 'snapshot failed' }), { kill: noKill, snapshot: async () => mapOf([[4203, 1, T, 'claude.exe']]) });
  assert.strictEqual(k.refused.kind, 'unverifiable');
  assert.match(k.refused.manual, /pid 4203/);
  assert.match(k.refused.manual, /claude\.exe/);
  assert.match(k.refused.manual, /Task Manager > Details/);
  assert.match(k.refused.manual, /Stop-Process -Id 4203/);
  const m = await P.killProcess({ pid: 4204, created: T, image: ['node.exe'] }, { kill: noKill, snapshot: async () => mapOf([[4204, 1, T + 9, 'node.exe']]) });
  assert.strictEqual(m.refused.kind, 'mismatch');
  assert.strictEqual(m.refused.manual, undefined, 'another process provably holds the pid: no by-hand advice to kill it');
});
