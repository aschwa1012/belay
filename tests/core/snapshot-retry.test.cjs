'use strict';
// snapshot-retry.test.cjs — ADR 0039 review follow-up 3: an unreadable CIM snapshot is taken again before a
// kill is refused (once) and before a spawned worker's row is left unverified (three attempts in all); a row
// whose identity cannot be proved is refused with the exact way to end it by hand.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const P = require('../../src/core/process.cjs');
const ID = require('../../src/core/proc-identity.cjs');
const PI = require('../../src/run/pid-identity.cjs');

const T = 1_800_000_000_000;
const mapOf = (rows) => new Map(rows.map(([pid, ppid, created, image]) => [pid, { ppid, created, image }]));
const noKill = () => {};

// Stands in for the real snapshot: `answers` in order (null = unreadable), counting calls.
function standIn(answers) {
  const real = ID.processSnapshot;
  let calls = 0;
  ID.processSnapshot = async () => { const a = answers[Math.min(calls, answers.length - 1)]; calls++; return a; };
  return { calls: () => calls, restore: () => { ID.processSnapshot = real; } };
}

test('snapshotRetry: an unreadable snapshot is taken again, up to `attempts`, with the wait doubling', async () => {
  let n = 0;
  const t0 = Date.now();
  const got = await ID.snapshotRetry({ attempts: 3, backoffMs: 50, snapshot: async () => (++n < 3 ? null : mapOf([[1, 0, T, 'x.exe']])) });
  assert.strictEqual(n, 3);
  assert.ok(got && got.get(1));
  assert.ok(Date.now() - t0 >= 140, 'the waits were 50 then 100 ms');
  n = 0;
  assert.strictEqual(await ID.snapshotRetry({ attempts: 2, backoffMs: 1, snapshot: async () => { n++; return null; } }), null);
  assert.strictEqual(n, 2, 'never more than `attempts`');
  n = 0;
  await ID.snapshotRetry({ attempts: 3, backoffMs: 1, snapshot: async () => { n++; return new Map([[9, {}]]); } });
  assert.strictEqual(n, 1, 'a readable snapshot is never retried');
});

test('kill: a default (kill-time) snapshot that is unreadable once is retried, and the kill proceeds on the second', async () => {
  const s = standIn([null, mapOf([[4201, 1, T, 'node.exe']])]);
  try {
    const r = await P.killPid({ pid: 4201, created: T }, 'SIGKILL', { kill: noKill });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(s.calls(), 2);
  } finally { s.restore(); }
});

test('kill: two unreadable kill-time snapshots refuse, after exactly one retry; a caller\'s own snapshot is never retried', async () => {
  const s = standIn([null]);
  try {
    const r = await P.killPid({ pid: 4202, created: T }, 'SIGKILL', { kill: noKill });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'unverifiable');
    assert.strictEqual(s.calls(), P.KILL_SNAPSHOT_ATTEMPTS);
    assert.strictEqual(P.KILL_SNAPSHOT_ATTEMPTS, 2);
    let own = 0;
    const r2 = await P.killPid({ pid: 4202, created: T }, 'SIGKILL', { kill: noKill, snapshot: async () => { own++; return null; } });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(own, 1, 'the fast close passes its own snapshot and its own budget decides');
  } finally { s.restore(); }
});

test('spawn: the creation-time read is tried three times before the row is left unverified', async () => {
  const s = standIn([null, null, null, null]);
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    const w = { pid: live.pid };
    await PI.noteSpawn(w, live);
    assert.strictEqual(s.calls(), 3);
    assert.strictEqual(PI.SPAWN_READ_ATTEMPTS, 3);
    assert.strictEqual(w.pidCreated, null);
    assert.match(w.pidCreatedError, /unreadable on all 3 attempts/);
  } finally { s.restore(); live.kill(); }
});

test('spawn: a read that fails twice and lands on the third gives the row its creation time, never unverified', async () => {
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true, stdio: 'ignore' });
  const s = standIn([null, null, mapOf([[live.pid, process.pid, T + 5, 'node.exe']])]);
  try {
    const w = { pid: live.pid };
    await PI.noteSpawn(w, live);
    assert.strictEqual(s.calls(), 3);
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
