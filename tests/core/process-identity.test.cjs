'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// process-identity.test.cjs — ADR 0039 decisions 1 to 3 on src/core/process.cjs. Most cases inject the
// snapshot and the kill, so nothing real is signalled; the last group uses processes this test spawned
// and stops through their own handles.

const { readCreated } = require('../helpers/created.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const P = require('../../src/core/process.cjs');
const ID = require('../../src/core/proc-identity.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const snapOf = (rows) => async () => new Map(rows.map(([pid, ppid, created, image]) => [pid, { ppid, created, image }]));
const recorder = () => { const sent = []; return { sent, kill: (pid, sig) => { sent.push(pid); void sig; } }; };
const T = 1_800_000_000_000;

test('killPid: a creation time that differs by more than 2000 ms refuses and signals nothing', async () => {
  const rec = recorder();
  const r = await P.killPid({ pid: 4001, created: T }, 'SIGKILL', { snapshot: snapOf([[4001, 1, T + 2500, 'node.exe']]), kill: rec.kill });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.refused, 'identity');
  assert.match(r.detail, /different process holds the pid/);
  assert.deepStrictEqual(rec.sent, []);
});

test('killPid: the creation time must match EXACTLY; one millisecond off is another process', async () => {
  const rec = recorder();
  for (const off of [1, -1, 1500]) {
    const r = await P.killPid({ pid: 4002, created: T }, 'SIGKILL', { snapshot: snapOf([[4002, 1, T + off, 'node.exe']]), kill: rec.kill });
    assert.strictEqual(r.refused, 'identity', 'offset ' + off);
    assert.strictEqual(r.kind, 'mismatch');
  }
  assert.deepStrictEqual(rec.sent, []);
  const same = await P.killPid({ pid: 4002, created: T }, 'SIGKILL', { snapshot: snapOf([[4002, 1, T, 'node.exe']]), kill: rec.kill });
  assert.strictEqual(same.ok, true);
  assert.deepStrictEqual(same.identity, { via: 'created', created: T, image: 'node.exe' });
  assert.deepStrictEqual(rec.sent, [4002]);
});

test('killPid and killTree: the image is checked on the created path too, and a bare pid number is refused', async () => {
  const rec = recorder();
  const snapshot = snapOf([[4020, 1, T, 'chrome.exe']]);
  const one = await P.killPid({ pid: 4020, created: T, image: ['claude.exe'] }, 'SIGKILL', { snapshot, kill: rec.kill });
  assert.strictEqual(one.refused, 'identity');
  assert.match(one.detail, /chrome\.exe/);
  const tree = await P.killTree({ pid: 4020, created: T, image: ['claude.exe'] }, { snapshot, kill: rec.kill });
  assert.strictEqual(tree.refused, 'identity');
  const bare = P.killPid(4020, 'SIGKILL', { kill: rec.kill });
  assert.strictEqual(bare.refused, 'identity');
  assert.match(bare.detail, /bare pid/);
  assert.deepStrictEqual(rec.sent, []);
});

test('rowTarget: the image comes from the row (pid_image), node.exe is never a default, and a pid_created_error makes it unverified', async () => {
  assert.deepStrictEqual(P.rowTarget({ pid: 7, substrate: 'claude-code' }).image, ['claude.exe']);
  assert.deepStrictEqual(P.rowTarget({ pid: 7, substrate: 'claude-code', pid_image: 'node.exe' }).image, ['node.exe']);
  process.env.BELAY_CLAUDE_EXE = 'x.cjs'; // the killer's own environment is not evidence of what the spawner launched
  try { assert.deepStrictEqual(P.rowTarget({ pid: 7, substrate: 'claude-code' }).image, ['claude.exe']); } finally { delete process.env.BELAY_CLAUDE_EXE; }
  const u = P.rowTarget({ pid: 7, pid_created: T, pid_created_error: 'x', substrate: 'codex', pid_image: 'codex.exe' });
  assert.strictEqual(u.unverified, 'x');
  const rec = recorder();
  const r = await P.killPid(u, 'SIGKILL', { snapshot: snapOf([[7, 1, T, 'codex.exe']]), kill: rec.kill });
  assert.strictEqual(r.refused, 'identity');
  assert.deepStrictEqual(rec.sent, []);
});

test('killPid: a reused pid (created later, another image) and a pid that is not running both refuse', async () => {
  const rec = recorder();
  const reused = await P.killPid({ pid: 4003, created: T, image: ['claude.exe'] }, 'SIGKILL', { snapshot: snapOf([[4003, 1, T + 90_000, 'notepad.exe']]), kill: rec.kill });
  assert.strictEqual(reused.refused, 'identity');
  assert.match(reused.detail, /different process holds the pid/);
  const gone = await P.killPid({ pid: 4004, created: T }, 'SIGKILL', { snapshot: snapOf([[1, 0, T, 'x']]), kill: rec.kill });
  assert.strictEqual(gone.refused, 'identity');
  assert.deepStrictEqual(rec.sent, []);
});

test('killPid: an unreadable snapshot refuses; it never silently kills and never silently succeeds', async () => {
  const rec = recorder();
  const r = await P.killPid({ pid: 4005, created: T }, 'SIGKILL', { snapshot: async () => null, kill: rec.kill });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.refused, 'identity');
  assert.match(r.detail, /snapshot unreadable/);
  assert.deepStrictEqual(rec.sent, []);
});

test('killPid: a row with no creation time is killed only when the image is the expected one', async () => {
  const rec = recorder();
  const snapshot = snapOf([[4006, 1, T, 'node.exe']]);
  const noImage = await P.killPid({ pid: 4006, created: null }, 'SIGKILL', { snapshot, kill: rec.kill });
  assert.strictEqual(noImage.refused, 'identity');
  const wrong = await P.killPid({ pid: 4006, created: null, image: ['claude.exe'] }, 'SIGKILL', { snapshot, kill: rec.kill });
  assert.strictEqual(wrong.refused, 'identity');
  assert.deepStrictEqual(rec.sent, []);
  const right = await P.killPid({ pid: 4006, created: null, image: ['claude.exe', 'node.exe'] }, 'SIGKILL', { snapshot, kill: rec.kill });
  assert.strictEqual(right.ok, true);
  assert.deepStrictEqual(right.identity, { via: 'image', image: 'node.exe' });
  assert.deepStrictEqual(rec.sent, [4006]);
});

test('killPid: a handle is live only while neither an exit code nor a signal is recorded', () => {
  const rec = recorder();
  const live = P.killPid({ pid: 4007, exitCode: null, signalCode: null }, 'SIGKILL', { kill: rec.kill });
  assert.deepStrictEqual(live.identity, { via: 'handle' });
  const exited = P.killPid({ pid: 4008, exitCode: 0, signalCode: null }, 'SIGKILL', { kill: rec.kill });
  const signalled = P.killPid({ pid: 4009, exitCode: null, signalCode: 'SIGKILL' }, 'SIGKILL', { kill: rec.kill });
  assert.strictEqual(exited.refused, 'identity');
  assert.strictEqual(signalled.refused, 'identity');
  assert.deepStrictEqual(rec.sent, [4007]);
});

test('killTree: a bare pid is refused, the shim never tree-kills', async () => {
  const rec = recorder();
  const r = await P.killTree(4010, { snapshot: snapOf([[4010, 1, T, 'node.exe'], [4011, 4010, T + 5, 'node.exe']]), kill: rec.kill });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.refused, 'identity');
  assert.match(r.detail, /bare pid/);
  assert.deepStrictEqual(rec.sent, []);
});

test('killTree: descendants die leaves first and the root last, each by its own single pid', async () => {
  const rec = recorder();
  const snapshot = snapOf([[100, 1, T, 'node.exe'], [101, 100, T + 10, 'node.exe'], [102, 101, T + 20, 'node.exe'], [103, 100, T + 30, 'node.exe'], [999, 1, T, 'other.exe']]);
  const r = await P.killTree({ pid: 100, created: T }, { snapshot, kill: rec.kill });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(rec.sent, [102, 101, 103, 100]);
  assert.deepStrictEqual(r.killed, [102, 101, 103, 100]);
  assert.strictEqual(r.terminated, 4);
  assert.deepStrictEqual(r.identity, { via: 'created', created: T, image: 'node.exe' });
});

test('killTree: a "child" created before its parent is a stale parent pid and is skipped (the stale-parent case)', async () => {
  const rec = recorder();
  // 201 names 200 as its parent but was created before 200 existed: 200 reused a dead parent's pid.
  const snapshot = snapOf([[200, 1, T, 'node.exe'], [201, 200, T - 60_000, 'unrelated.exe'], [202, 200, T + 5, 'node.exe'], [203, 201, T - 59_000, 'grandchild-of-stale.exe']]);
  const r = await P.killTree({ pid: 200, created: T }, { snapshot, kill: rec.kill });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(rec.sent, [202, 200], 'the stale child and everything under it survive');
  assert.deepStrictEqual(r.skipped.map((s) => s.pid), [201]);
});

test('killTree: a mismatched root, a reused pid and an unreadable snapshot each refuse and kill nothing', async () => {
  const rec = recorder();
  const kids = [[301, 300, T + 1, 'node.exe']];
  const mismatch = await P.killTree({ pid: 300, created: T }, { snapshot: snapOf([[300, 1, T + 9000, 'node.exe'], ...kids]), kill: rec.kill });
  const reused = await P.killTree({ pid: 300, created: T, image: ['claude.exe'] }, { snapshot: snapOf([[300, 1, T + 90_000, 'chrome.exe'], ...kids]), kill: rec.kill });
  const unreadable = await P.killTree({ pid: 300, created: T }, { snapshot: async () => null, kill: rec.kill });
  const nullCreated = await P.killTree({ pid: 300, created: null }, { snapshot: snapOf([[300, 1, T, 'node.exe'], ...kids]), kill: rec.kill });
  for (const r of [mismatch, reused, unreadable, nullCreated]) { assert.strictEqual(r.ok, false); assert.strictEqual(r.refused, 'identity'); assert.strictEqual(r.terminated, 0); }
  assert.deepStrictEqual(rec.sent, []);
});

test('killTree: a live handle proves the root; an unreadable snapshot then kills the root only and says so', async () => {
  const rec = recorder();
  const handle = { pid: 400, exitCode: null, signalCode: null };
  const r = await P.killTree(handle, { snapshot: async () => null, kill: rec.kill });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(rec.sent, [400]);
  assert.match(r.tree_refused, /descendants not killed/);
  assert.deepStrictEqual(r.identity, { via: 'handle' });
  const dead = await P.killTree({ pid: 401, exitCode: 1, signalCode: null }, { snapshot: snapOf([]), kill: rec.kill });
  assert.strictEqual(dead.refused, 'identity');
  assert.deepStrictEqual(rec.sent, [400]);
});

test('descendantsOf and rowTarget: the walk is leaves-first and a row with no pid_created has none', () => {
  const snap = new Map([[1, { ppid: 0, created: T, image: 'a' }], [2, { ppid: 1, created: T + 1, image: 'b' }], [3, { ppid: 2, created: T + 2, image: 'c' }]]);
  assert.deepStrictEqual(ID.descendantsOf(1, snap).leavesFirst.map((d) => d.pid), [3, 2]);
  assert.deepStrictEqual(P.rowTarget({ pid: 7, pid_created: null, substrate: 'codex' }), { pid: 7, created: null, image: ['codex.exe'] });
  assert.strictEqual(P.rowTarget({ pid: 7, pid_created: T, substrate: 'claude-code' }).created, T);
});

// src/run/kill-guard.cjs is exempt: its regexes match taskkill in a worker's command in order to refuse it; it runs nothing.
const GUARD = 'src/run/kill-guard.cjs';
test('src/ never runs a tree kill by taskkill: no /T argument to taskkill anywhere', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.cjs$/.test(e.name)) continue;
      if (path.relative(ROOT, p).split(path.sep).join('/') === GUARD) continue;
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/taskkill/i.test(code)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepStrictEqual(offenders, []);
});

// ---------------------------------------------------------------- real processes, all this test's own

const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
const exited = (c) => c.exitCode !== null || c.signalCode !== null;

test('real: a live process whose pid a row holds with the wrong creation time is refused and survives', async () => {
  const s = sleeper();
  try {
    const one = await P.killPid({ pid: s.pid, created: 1 });
    assert.strictEqual(one.refused, 'identity', JSON.stringify(one));
    const tree = await P.killTree({ pid: s.pid, created: 1 });
    assert.strictEqual(tree.refused, 'identity', JSON.stringify(tree));
    const many = await P.killMany([{ pid: s.pid, created: 1, image: 'node.exe' }]);
    assert.strictEqual(many[0].refused, 'identity', JSON.stringify(many));
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(exited(s), false, 'the sleeper must still be running');
  } finally { s.kill(); }
});

test('real: the creation time read from the snapshot is the identity that kills the tree, and only that tree', async (t) => {
  if (process.platform !== 'win32') return t.skip('the CIM snapshot is Windows only');
  // The parent names its grandchild on stdout once it has spawned it: the test waits for that, never for a guessed delay.
  const src = 'const{spawn}=require("child_process");const k=spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});process.stdout.write("grandchild "+k.pid+"\\n");setTimeout(()=>{},60000)';
  const parent = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const parentExit = new Promise((res) => parent.once('exit', res));
  const bystander = sleeper();
  try {
    await new Promise((res, rej) => {
      let out = '';
      parent.stdout.on('data', (d) => { out += d; if (/grandchild \d+\n/.test(out)) res(); });
      parent.once('exit', () => rej(new Error('the parent exited before it spawned its child')));
    });
    const c = await readCreated(parent.pid);
    assert.ok(c && Number.isFinite(c.created), 'the snapshot must give the parent a creation time');
    const r = await P.killProcess({ pid: parent.pid, created: c.created, image: ['node.exe'] });
    assert.strictEqual(r.refused, null, JSON.stringify(r));
    assert.strictEqual(r.identity.via, 'created');
    assert.ok(r.tree.terminated >= 2, `the grandchild must go too: ${JSON.stringify(r.tree)}`);
    // The kill ends the parent; the bound is only a hang guard with a message.
    let guard;
    await Promise.race([parentExit, new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('the parent did not exit within 30 s of the tree kill')), 30000); })]).finally(() => clearTimeout(guard));
    assert.strictEqual(exited(parent), true);
    assert.strictEqual(exited(bystander), false, 'a process outside the tree must survive');
  } finally { bystander.kill(); if (!exited(parent)) parent.kill(); }
});

test('real: a handle whose exit was already observed is never killed by its pid, even if another process holds it', async () => {
  const s = sleeper();
  try {
    const spent = { pid: s.pid, exitCode: 0, signalCode: null }; // a child whose exit event fired; the pid is "reused" by s
    assert.strictEqual((await P.killTree(spent)).refused, 'identity');
    assert.strictEqual(P.killPid(spent).refused, 'identity');
    assert.strictEqual((await P.killProcess(spent)).refused.refused, 'identity');
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(exited(s), false);
  } finally { s.kill(); }
});

test('image names compare case-insensitively and an extensionless name means .exe on Windows', async (t) => {
  const rec = recorder();
  const snapshot = snapOf([[4030, 1, T, 'Claude.EXE']]);
  const lower = await P.killPid({ pid: 4030, created: T, image: ['claude.exe'] }, 'SIGKILL', { snapshot, kill: rec.kill });
  assert.strictEqual(lower.ok, true, 'case differences are the same image');
  if (process.platform === 'win32') {
    const bare = await P.killPid({ pid: 4030, created: T, image: ['claude'] }, 'SIGKILL', { snapshot, kill: rec.kill });
    assert.strictEqual(bare.ok, true, 'a spawnfile of "claude" is the image CIM calls claude.exe');
    assert.strictEqual(ID.imageIn('node.exe', 'node'), true);
  } else t.skip('.exe normalisation is Windows only');
});

test('an image mismatch on a pid whose creation time matches is unverifiable, never a mismatch; a creation-time mismatch is', async () => {
  const rec = recorder();
  const same = await P.killPid({ pid: 4031, created: T, image: ['claude.exe'] }, 'SIGKILL', { snapshot: snapOf([[4031, 1, T, 'other.exe']]), kill: rec.kill });
  assert.strictEqual(same.refused, 'identity');
  assert.strictEqual(same.kind, 'unverifiable', 'same process time, other name: proves nothing about where the worker is');
  const tree = await P.killTree({ pid: 4031, created: T, image: ['claude.exe'] }, { snapshot: snapOf([[4031, 1, T, 'other.exe']]), kill: rec.kill });
  assert.strictEqual(tree.kind, 'unverifiable');
  const other = await P.killPid({ pid: 4031, created: T, image: ['claude.exe'] }, 'SIGKILL', { snapshot: snapOf([[4031, 1, T + 1, 'claude.exe']]), kill: rec.kill });
  assert.strictEqual(other.kind, 'mismatch');
  const absent = await P.killPid({ pid: 4031, created: T }, 'SIGKILL', { snapshot: snapOf([[1, 0, T, 'x']]), kill: rec.kill });
  assert.strictEqual(absent.kind, 'absent');
  assert.deepStrictEqual(rec.sent, []);
});
