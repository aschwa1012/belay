'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// Process primitives: liveness, the refusal to kill anything that is not a pid, graceful stop.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const P = require('../../src/run/process.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('pidAlive is true for this process and false for a pid that cannot exist', () => {
  assert.equal(P.pidAlive(process.pid), true);
  assert.equal(P.pidAlive(0), false);
  assert.equal(P.pidAlive(-1), false);
  assert.equal(P.pidAlive(1.5), false);
  assert.equal(P.pidAlive(null), false);
  assert.equal(P.pidAlive('4'), false, 'a string is not a pid');
});

test('pidAlive follows a real child from alive to gone', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { windowsHide: true });
  await sleep(150);
  assert.equal(P.pidAlive(child.pid), true);
  P.killPid(child, 'SIGKILL');
  const ms = await P.waitPidGone(child.pid, { timeoutMs: 10000 });
  assert.ok(ms !== null, 'the pid must disappear');
  assert.equal(P.pidAlive(child.pid), false);
});

test('kill refuses anything that is not a positive integer pid', () => {
  for (const bad of [0, -1, 1.5, '1234', null, undefined, NaN, 'claude.exe']) {
    assert.throws(() => P.killPid(bad), (e) => e.code === 'E_ARGS', 'must refuse ' + String(bad));
  }
  assert.throws(() => P.assertPid('node.exe'), (e) => e.code === 'E_ARGS');
});

test('killPid on a pid that is already gone reports the failure rather than throwing', async () => {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await new Promise((r) => child.on('exit', r));
  await sleep(50);
  const r = P.killPid(child, 'SIGKILL');
  assert.equal(r.signalled, false);
  assert.equal(r.pid, child.pid);
  assert.ok(r.error);
});

test('gracefulStop closes stdin and resolves when the child exits', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.on("end",()=>process.exit(0));process.stdin.resume();'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const r = await P.gracefulStop(child, 8000);
  assert.equal(r.graceful, true);
  assert.equal(r.timed_out, false);
  assert.equal(r.exit_code, 0);
});

test('gracefulStop reports a timeout instead of claiming success', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();setTimeout(()=>{},60000)'], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const r = await P.gracefulStop(child, 500);
  assert.equal(r.graceful, false);
  assert.equal(r.timed_out, true);
  P.killPid(child, 'SIGKILL');
  await P.waitPidGone(child.pid, { timeoutMs: 5000 });
});

test('childPids finds a real grandchild and killTree removes the subtree', async (t) => {
  if (process.platform !== 'win32') return t.skip('subtree measurement is a Windows question here');
  const src = 'const{spawn}=require("child_process");spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});setTimeout(()=>{},60000)';
  const parent = spawn(process.execPath, ['-e', src], { stdio: 'ignore', windowsHide: true });
  await sleep(900);
  const kids = await P.childPids(parent.pid);
  assert.ok(kids.length >= 1, 'the grandchild must be visible: ' + JSON.stringify(kids));
  const r = await P.killTree(parent); // ADR 0039: the live handle is the identity
  assert.equal(r.method, 'snapshot-tree');
  assert.deepEqual(r.identity, { via: 'handle' });
  assert.ok(r.terminated >= 2, JSON.stringify(r));
  await P.waitPidGone(parent.pid, { timeoutMs: 8000 });
  await sleep(300);
  for (const k of kids) assert.equal(P.pidAlive(k), false, 'descendant ' + k + ' must be gone');
});
