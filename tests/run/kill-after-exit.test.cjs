'use strict';
// A kill path checks its root handle before it awaits a process snapshot. A root that exits during the await may have lost its
// pid to another process, and the snapshot then names that process's children as descendants. Every path re-confirms the root
// after the snapshot and signals nothing below it otherwise. No real process is signalled: pids are fictitious and every kill
// goes to a recorder. The one real pid used (this process's own) only passes killMany's liveness pre-filter; it is never signalled.
const test = require('node:test');
const assert = require('node:assert');

const PROC = require('../../src/core/process.cjs');
const { createLeftovers } = require('../../src/run/orchestrator-leftovers.cjs');
const { killGitTree } = require('../../src/mcp/git-read.cjs');

const ROOT = 77;
const stranger = (own = 78) => new Map([
  [ROOT, { pid: ROOT, ppid: 4, created: 2000, image: 'stranger.exe' }],
  [own, { pid: own, ppid: ROOT, created: 2001, image: 'strangerchild.exe' }],
]);

test('killTree: a handle that exits during the snapshot signals no descendant', async () => {
  const handle = { pid: ROOT, exitCode: null, signalCode: null };
  const sent = [];
  const snapshot = async () => { handle.exitCode = 0; return stranger(); };
  const r = await PROC.killTree(handle, { snapshot, kill: (pid, sig) => sent.push([pid, sig]) });
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.killed, []);
  assert.match(r.output, /exited/);
});

test('killTree: a handle still live after the snapshot kills its descendants, then the root', async () => {
  const handle = { pid: ROOT, exitCode: null, signalCode: null };
  const sent = [];
  const r = await PROC.killTree(handle, { snapshot: async () => stranger(), kill: (pid) => sent.push(pid) });
  assert.deepStrictEqual(sent, [78, ROOT]);
  assert.strictEqual(r.ok, true);
});

test('descendantTargets: a handle that exits during the snapshot names no descendant, even with no creation time', async () => {
  const handle = { pid: ROOT, exitCode: null, signalCode: null };
  const snapshot = async () => { handle.exitCode = 0; return stranger(); };
  assert.deepStrictEqual(await PROC.descendantTargets(ROOT, { expectCreated: null, handle, snapshot }), []);
  const live = { pid: ROOT, exitCode: null, signalCode: null };
  const t = await PROC.descendantTargets(ROOT, { expectCreated: null, handle: live, snapshot: async () => stranger() });
  assert.deepStrictEqual(t.map((d) => d.pid), [78]);
});

test('orchestrator leftovers: an orchestrator that exits during the snapshot leaves nothing to kill', async () => {
  const child = { pid: ROOT, exitCode: null, signalCode: null };
  const killed = [];
  const P = {
    snapshotShared: async () => { child.exitCode = 0; return { snap: stranger() }; },
    killMany: async (t) => { killed.push(...t.map((x) => x.pid)); return []; },
  };
  const state = {};
  const lo = createLeftovers({ child, P, state, core: null, runId: 'r', owned: async () => ({ adapterKnown: true, list: [] }) });
  await lo.capture();
  const r = await lo.end();
  assert.deepStrictEqual(killed, []);
  assert.deepStrictEqual(r.found, []);
});

test('orchestrator leftovers: a root that exits during the owned-process read leaves nothing to kill', async () => {
  const child = { pid: ROOT, exitCode: null, signalCode: null };
  const killed = [];
  const P = { snapshotShared: async () => ({ snap: stranger() }), killMany: async (t) => { killed.push(...t.map((x) => x.pid)); return []; } };
  const lo = createLeftovers({ child, P, state: {}, core: null, runId: 'r', owned: async () => { child.exitCode = 0; return { adapterKnown: true, list: [] }; } });
  await lo.capture();
  assert.deepStrictEqual((await lo.end()).found, []);
});

test('killGitTree: git that exited during the first snapshot kills no descendant', async () => {
  const child = { pid: ROOT, exitCode: null, signalCode: null, kill() { throw new Error('child.kill must not run'); } };
  const sent = [];
  const snapshot = async () => { child.exitCode = 0; return stranger(process.pid); };
  const r = await killGitTree(child, { snapshot, kill: (pid) => sent.push(pid) });
  assert.deepStrictEqual(sent, []);
  assert.strictEqual(r.ok, false);
});

test('killGitTree: git already exited before any snapshot takes no snapshot and kills nothing', async () => {
  const child = { pid: ROOT, exitCode: 0, signalCode: null, kill() { throw new Error('child.kill must not run'); } };
  let snaps = 0;
  const r = await killGitTree(child, { snapshot: async () => { snaps++; return stranger(process.pid); }, kill: () => assert.fail('signalled') });
  assert.strictEqual(snaps, 0);
  assert.strictEqual(r.ok, false);
});

test('killGitTree: the descendants are checked against a snapshot taken after the one that named them', async () => {
  const child = { pid: ROOT, exitCode: null, signalCode: null, kill() { this.exitCode = 0; } };
  const me = process.pid;
  const named = new Map([[ROOT, { pid: ROOT, ppid: 4, created: 2000, image: 'git.exe' }], [me, { pid: me, ppid: ROOT, created: 2001, image: 'node.exe' }]]);
  // By the time of the check the descendant's pid belongs to a process created later: the first snapshot's word is not enough.
  const replaced = new Map([[me, { pid: me, ppid: 4, created: 9999, image: 'node.exe' }]]);
  const shots = [named, replaced, replaced];
  const sent = [];
  const r = await killGitTree(child, { snapshot: async () => shots.shift() || replaced, kill: (pid) => sent.push(pid) });
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(r.killed, [ROOT]);
  assert.strictEqual(r.ok, false);
});

test('killGitTree: a live git and its verified descendant are killed', async () => {
  const child = { pid: ROOT, exitCode: null, signalCode: null, kill() { this.exitCode = 0; } };
  const me = process.pid;
  const snap = () => new Map([[ROOT, { pid: ROOT, ppid: 4, created: 2000, image: 'git.exe' }], [me, { pid: me, ppid: ROOT, created: 2001, image: 'node.exe' }]]);
  const sent = [];
  const r = await killGitTree(child, { snapshot: async () => snap(), kill: (pid) => sent.push(pid) });
  assert.deepStrictEqual(sent, [me]);
  assert.deepStrictEqual(r.killed, [ROOT, me]);
});
