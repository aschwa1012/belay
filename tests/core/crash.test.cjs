'use strict';
// crash.test.cjs — ADR 0039: the test helper that plays "the outside world" signals only what it can prove.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const { crash, note, crashDescendant, noted } = require('../crash.cjs');
const P = require('../../src/core/process.cjs');

const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
const running = (c) => c.exitCode === null && c.signalCode === null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('crash: a bare pid with no known creation time, or the wrong one, is not signalled', async () => {
  const s = sleeper();
  try {
    assert.strictEqual(crash(s.pid), false);
    assert.strictEqual(crash(s.pid, 1), false);
    assert.strictEqual(crash(0), false);
    await sleep(200);
    assert.strictEqual(running(s), true);
  } finally { s.kill(); }
});

test('crash: an object that is not a child handle (a wrapper around one) throws instead of silently signalling nothing', async () => {
  const s = sleeper();
  try {
    assert.throws(() => crash({ child: s, pid: s.pid }), TypeError);
    await sleep(200);
    assert.strictEqual(running(s), true);
  } finally { s.kill(); }
});

test('crash: an exited handle is never signalled, even when another process holds its pid', async () => {
  const s = sleeper();
  try {
    assert.strictEqual(crash({ pid: s.pid, exitCode: 0, signalCode: null }), false);
    await sleep(200);
    assert.strictEqual(running(s), true);
  } finally { s.kill(); }
});

test('crash: a live handle, or a pid with its true creation time, is signalled', async (t) => {
  const a = sleeper();
  assert.strictEqual(crash(a), true);
  await new Promise((r) => a.once('exit', r));
  if (process.platform !== 'win32') return t.skip('the creation time comes from the CIM snapshot');
  const b = sleeper();
  try {
    await sleep(300);
    const made = await P.createdOf(b.pid);
    assert.strictEqual(crash(b.pid, made.created), true);
    await new Promise((r) => b.once('exit', r));
  } finally { if (running(b)) b.kill(); }
});

test('note(): a bare pid throws; a live handle is recorded; a child that exited before the read lands is discarded', async (t) => {
  assert.throws(() => note(12345), /live child handle, never a bare pid/);
  if (process.platform !== 'win32') return t.skip('the creation time comes from the CIM snapshot');
  const live = sleeper();
  const gone = sleeper();
  try {
    note(live); note(gone);
    gone.kill(); // exits while its snapshot is still being read
    await sleep(2800);
    assert.ok(noted.has(live.pid), 'a handle still live when the read landed is kept');
    assert.ok(!noted.has(gone.pid), 'a handle that exited before the read landed is discarded');
    assert.strictEqual(crash(live.pid), true);
    await new Promise((r) => live.once('exit', r));
  } finally { if (running(live)) live.kill(); if (running(gone)) gone.kill(); }
});

test('crashDescendant: only a pid in this process\'s own tree is signalled', async (t) => {
  if (process.platform !== 'win32') return t.skip('the process tree comes from the CIM snapshot');
  const mine = sleeper();
  const code = "const{spawn}=require('child_process');const k=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});process.stdout.write(String(k.pid));setTimeout(()=>{},60000)";
  const parent = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const other = sleeper();
  try {
    const kid = await new Promise((r) => parent.stdout.once('data', (d) => r(Number(String(d)))));
    await sleep(500);
    assert.strictEqual(crashDescendant(kid), true, 'a grandchild of this process');
    assert.strictEqual(crashDescendant(1), false);
    assert.strictEqual(crashDescendant(process.pid), false, 'this process is not its own descendant');
  } finally { for (const c of [mine, parent, other]) if (running(c)) c.kill(); }
});

test('note(): a reading that lands after the handle exited is discarded even when the snapshot shows the pid alive (a bystander holds it)', async () => {
  const handle = { pid: 777001, exitCode: null, signalCode: null };
  let land;
  const snapshot = () => new Promise((r) => { land = r; });
  note(handle, { snapshot });
  handle.exitCode = 0; // the child exits while the snapshot is in flight
  land(new Map([[777001, { ppid: 1, created: 123456, image: 'bystander.exe' }]])); // another process now holds the pid
  await sleep(50);
  assert.ok(!noted.has(777001), 'the reading must be discarded: the handle was no longer live when it landed');
  const live = { pid: 777002, exitCode: null, signalCode: null };
  note(live, { snapshot: async () => new Map([[777002, { ppid: 1, created: 654321, image: 'x.exe' }]]) });
  await sleep(50);
  assert.strictEqual(noted.get(777002), 654321, 'a handle still live when the reading lands is kept');
});
