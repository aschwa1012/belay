'use strict';
require('../helpers/tmp.cjs');
// kill-reused-image.test.cjs — a kill target with no recorded creation time and an expected image, whose pid the snapshot
// shows held by another image. A live process never changes its image, so the original has exited and the pid was reused:
// that is `mismatch` (already gone), never a kill of the new holder. The same pid with the right image and no creation time
// stays `unverifiable`. The snapshot and the kill are injected; nothing real is signalled.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const P = require('../../src/core/process.cjs');
const { closeRunWorkers } = require('../../src/cli/run-close.cjs');

const T = 1_800_000_000_000;
const snapOf = (rows) => async () => new Map(rows.map(([pid, ppid, created, image]) => [pid, { ppid, created, image }]));
const recorder = () => { const sent = []; return { sent, kill: (pid) => { sent.push(pid); } }; };
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });

test('killPid: no creation time and another image at the pid is a mismatch (reused), and nothing is signalled', async () => {
  const rec = recorder();
  const r = await P.killPid({ pid: 5001, created: null, image: ['node.exe'], image_recorded: true }, 'SIGKILL', { snapshot: snapOf([[5001, 1, T, 'conhost.exe']]), kill: rec.kill });
  assert.strictEqual(r.refused, 'identity');
  assert.strictEqual(r.kind, 'mismatch');
  assert.match(r.detail, /conhost\.exe/);
  assert.match(r.detail, /pid was reused/);
  assert.deepStrictEqual(rec.sent, [], 'the new holder of the pid must not be killed');
});

test('killProcess: the mismatch survives the tree-then-pid sequence, and nothing is signalled', async () => {
  const rec = recorder();
  const r = await P.killProcess({ pid: 5002, created: null, image: ['node.exe'], image_recorded: true }, { snapshot: snapOf([[5002, 1, T, 'conhost.exe']]), kill: rec.kill });
  assert.strictEqual(r.refused.refused, 'identity');
  assert.strictEqual(r.refused.kind, 'mismatch');
  assert.deepStrictEqual(rec.sent, []);
});

test('killPid: no creation time and no image to check it against stays unverifiable and unsignalled', async () => {
  const rec = recorder();
  const noImage = await P.killPid({ pid: 5003, created: null }, 'SIGKILL', { snapshot: snapOf([[5003, 1, T, 'node.exe']]), kill: rec.kill });
  assert.strictEqual(noImage.refused, 'identity');
  assert.strictEqual(noImage.kind, 'unverifiable');
  assert.match(noImage.detail, /no recorded creation time/);
  assert.deepStrictEqual(rec.sent, []);
});

test('killPid: a pid absent from the snapshot is absent, not a mismatch', async () => {
  const rec = recorder();
  const r = await P.killPid({ pid: 5004, created: null, image: ['node.exe'] }, 'SIGKILL', { snapshot: snapOf([[1, 0, T, 'x']]), kill: rec.kill });
  assert.strictEqual(r.kind, 'absent');
  assert.deepStrictEqual(rec.sent, []);
});

test('run close: a worker whose pid another image now holds is closed (gone), not left alive, and the holder is not signalled', async () => {
  const holder = sleeper(); // stands for the conhost that took the pid: a live process the close must leave alone
  try {
    const rec = recorder();
    const deps = { killProcess: (target) => P.killProcess(target, { snapshot: snapOf([[holder.pid, 1, T, 'conhost.exe']]), kill: rec.kill }) };
    const core = {
      run: { get: async () => ({ run: { adapter_pid: 999999999 } }) },
      worker: { list: async () => ({ workers: [{ id: 'w-reused', run_id: 'r1', substrate: 'claude-code', state: 'running', pid: holder.pid, pid_image: 'node.exe' }] }) },
    };
    const out = await closeRunWorkers({ core, runId: 'r1', graceMs: 100, deps });
    assert.strictEqual(out.killed[0].kind, 'mismatch');
    assert.strictEqual(out.killed[0].gone, true, 'another process holds the pid, so the worker has exited');
    assert.strictEqual(out.killed[0].outcome, 'closed');
    assert.strictEqual(out.killed[0].signalled, false);
    assert.deepStrictEqual(out.still_alive, [], 'nothing is left alive, so the close does not fail');
    assert.deepStrictEqual(rec.sent, []);
    assert.strictEqual(holder.exitCode, null, 'the new holder is untouched');
  } finally { if (holder.exitCode === null) holder.kill(); }
});

test('run close: an unverifiable refusal on a live pid still leaves the worker in still_alive', async () => {
  const holder = sleeper();
  try {
    const rec = recorder();
    const deps = { killProcess: (target) => P.killProcess(target, { snapshot: snapOf([[holder.pid, 1, T, 'node.exe']]), kill: rec.kill }) };
    const core = {
      run: { get: async () => ({ run: { adapter_pid: 999999999 } }) },
      worker: { list: async () => ({ workers: [{ id: 'w-unv', run_id: 'r1', substrate: 'claude-code', state: 'running', pid: holder.pid, pid_image: 'node.exe', pid_created_error: 'never read' }] }) },
    };
    const out = await closeRunWorkers({ core, runId: 'r1', graceMs: 100, deps });
    assert.strictEqual(out.killed[0].kind, 'unverifiable');
    assert.strictEqual(out.killed[0].gone, false);
    assert.strictEqual(out.still_alive.length, 1);
    assert.deepStrictEqual(rec.sent, []);
  } finally { if (holder.exitCode === null) holder.kill(); }
});

test('killPid: another image than the substrate\'s guess (no recorded image) proves nothing and stays unverifiable', async () => {
  const rec = recorder();
  const r = await P.killPid(P.rowTarget({ pid: 5005, substrate: 'claude-code' }), 'SIGKILL', { snapshot: snapOf([[5005, 1, T, 'node.exe']]), kill: rec.kill });
  assert.strictEqual(r.kind, 'unverifiable');
  assert.deepStrictEqual(rec.sent, []);
});

test('rowTarget: a row with a recorded pid_image marks the image as recorded; a row without does not', () => {
  assert.strictEqual(P.rowTarget({ pid: 7, substrate: 'claude-code', pid_image: 'node.exe' }).image_recorded, true);
  assert.strictEqual('image_recorded' in P.rowTarget({ pid: 7, substrate: 'claude-code' }), false);
});

test('killPid: no creation time and the recorded image at the pid is unverifiable, never a mismatch and never signalled', async () => {
  const rec = recorder();
  const r = await P.killPid({ pid: 5006, created: null, image: ['node.exe'], image_recorded: true }, 'SIGKILL', { snapshot: snapOf([[5006, 1, T, 'node.exe']]), kill: rec.kill });
  assert.strictEqual(r.kind, 'unverifiable', 'the same image with no creation time may be the same process');
  assert.match(r.detail, /^(?!.*reused)/);
});
