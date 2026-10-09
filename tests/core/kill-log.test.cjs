'use strict';
// kill-log.test.cjs — ADR 0039 P2, the refusal counter: BELAY_KILL_LOG set, every kill attempt in
// src/core/process.cjs appends one JSONL line; unset, nothing is written.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const P = require('../../src/core/process.cjs');
const KL = require('../../src/core/kill-log.cjs');

const snapOf = (rows) => async () => new Map(rows.map(([pid, ppid, created, image]) => [pid, { ppid, created, image }]));
const noKill = () => {};
const T = 1_800_000_000_000;
const ME = 'tests/core/kill-log.test.cjs';

function withLog(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-kill-log-'));
  const file = path.join(dir, 'kills.jsonl');
  const prev = process.env.BELAY_KILL_LOG;
  process.env.BELAY_KILL_LOG = file;
  const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return Promise.resolve(fn(lines, file)).finally(() => {
    if (prev === undefined) delete process.env.BELAY_KILL_LOG; else process.env.BELAY_KILL_LOG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('unset: no kill writes anything and no recorder is made', async () => {
  const prev = process.env.BELAY_KILL_LOG;
  delete process.env.BELAY_KILL_LOG;
  try {
    assert.strictEqual(KL.begin('killPid', 1234), null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-kill-log-'));
    const before = fs.readdirSync(dir);
    P.killPid(4100);
    await P.killTree({ pid: 4100, created: T }, { snapshot: snapOf([[4100, 1, T + 5, 'node.exe']]), kill: noKill });
    assert.deepStrictEqual(fs.readdirSync(dir), before);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally { if (prev !== undefined) process.env.BELAY_KILL_LOG = prev; }
});

test('set: a bare pid, a mismatch and a verified kill are each one line naming via, ok, kind and the caller', () => withLog(async (lines) => {
  P.killPid(4101);
  await P.killPid({ pid: 4102, created: T }, 'SIGKILL', { snapshot: snapOf([[4102, 1, T + 1, 'node.exe']]), kill: noKill });
  await P.killPid({ pid: 4103, created: T }, 'SIGKILL', { snapshot: snapOf([[4103, 1, T, 'node.exe']]), kill: noKill });
  const got = lines();
  assert.strictEqual(got.length, 3, JSON.stringify(got));
  assert.deepStrictEqual(got.map((l) => [l.pid, l.via, l.ok, l.kind, l.fn]), [
    [4101, 'bare', false, 'unverifiable', 'killPid'],
    [4102, 'created', false, 'mismatch', 'killPid'],
    [4103, 'created', true, null, 'killPid'],
  ]);
  for (const l of got) {
    assert.ok(l.caller && l.caller.startsWith(`${ME}:`), `caller is this file, not process.cjs: ${l.caller}`);
    assert.ok(!Number.isNaN(Date.parse(l.time)));
  }
  assert.match(got[0].detail, /bare pid/);
  assert.strictEqual(got[2].detail, null);
}));

test('set: a live handle is via handle; a spent one is refused as absent', () => withLog(async (lines) => {
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  const spent = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => spent.once('exit', r));
  try {
    assert.strictEqual(P.killPid(live, 'SIGKILL').ok, true);
    assert.strictEqual(P.killPid(spent, 'SIGKILL').ok, false);
  } finally { try { live.kill(); } catch { /* gone */ } }
  assert.deepStrictEqual(lines().map((l) => [l.via, l.ok, l.kind]), [['handle', true, null], ['handle', false, 'absent']]);
}));

test('set: killProcess is one line for the whole sequence; killMany is one line per live target', () => withLog(async (lines) => {
  // An older row (no creation time): the tree kill refuses, the single-pid kill by image lands; one line, ok.
  await P.killProcess({ pid: 4104, created: null, image: ['node.exe'] }, { snapshot: snapOf([[4104, 1, T, 'node.exe']]), kill: noKill });
  await P.killProcess({ pid: 4105, created: null, image: ['claude.exe'] }, { snapshot: snapOf([[4105, 1, T, 'node.exe']]), kill: noKill });
  const one = lines();
  assert.deepStrictEqual(one.map((l) => [l.pid, l.via, l.ok, l.kind, l.fn]), [
    [4104, 'image', true, null, 'killProcess'], [4105, 'image', false, 'unverifiable', 'killProcess'],
  ]);
  const a = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    await P.killMany([{ pid: a.pid, created: T }], { snapshot: snapOf([[a.pid, 1, T + 7, 'node.exe']]), kill: noKill });
    const m = lines().slice(2);
    assert.deepStrictEqual(m.map((l) => [l.pid, l.ok, l.kind, l.fn]), [[a.pid, false, 'mismatch', 'killMany']]);
    assert.ok(m[0].caller.startsWith(`${ME}:`), m[0].caller);
  } finally { a.kill(); }
}));

test('set: an unwritable log path never changes what a kill returns', async () => {
  const prev = process.env.BELAY_KILL_LOG;
  process.env.BELAY_KILL_LOG = path.join(os.tmpdir(), 'belay-no-such-dir-' + process.pid, 'x', 'kills.jsonl');
  try {
    const r = await P.killPid({ pid: 4106, created: T }, 'SIGKILL', { snapshot: snapOf([[4106, 1, T, 'node.exe']]), kill: noKill });
    assert.strictEqual(r.ok, true);
  } finally { if (prev === undefined) delete process.env.BELAY_KILL_LOG; else process.env.BELAY_KILL_LOG = prev; }
});

test('callerOf skips the kill mechanics and reports a repo-relative file and line', () => {
  const stack = [
    'Error',
    `    at begin (${path.join(__dirname, '..', '..', 'src', 'core', 'kill-log.cjs')}:40:16)`,
    `    at killPid (${path.join(__dirname, '..', '..', 'src', 'core', 'process.cjs')}:55:14)`,
    `    at stopOne (${path.join(__dirname, '..', '..', 'src', 'run', 'stop.cjs')}:31:20)`,
  ].join('\n');
  assert.strictEqual(KL.callerOf(stack), 'src/run/stop.cjs:31');
});
