'use strict';
// A retire or unregister by pid number alone deleted the record of whatever spawn held the number by then. Each path now names the
// identity it judged (worker id and store, or the orchestrator kind and store, plus the creation time when both sides know it) and
// leaves a record that is another spawn's. Paths: run.end's Codex idle close, run.end's creation-time mismatch close, the
// adopted-worker stamp tick, the headless orchestrator's exit hook and a worker child's exit hook. Controls check the own record
// is still retired.
const H = require('./helpers.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { openCore } = H.core('index.cjs');
const SR = H.core('spawn-register.cjs');
const SS = require('../../src/run/seen-stamp.cjs');
const PI = require('../../src/run/pid-identity.cjs');
const { registerOrchestrator } = require('../../src/run/register-orchestrator.cjs');

const recFile = (reg, pid) => path.join(reg.dir, `${pid}.json`);
function ownChild() { // a throwaway child of this process, ended by its handle
  const c = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  return { pid: c.pid, end: () => new Promise((r) => { if (c.exitCode !== null) return r(); c.once('exit', r); c.kill(); }) };
}
async function withRun(fn) {
  const reg = H.ownSpawnRegistry();
  const dir = H.sandbox();
  const orch = await openCore({ dataDir: dir, caller: H.callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  const b = ownChild();
  try { await fn({ reg, dir, orch, b }); } finally { await b.end(); await orch.shutdownOwner(); await orch.close(); H.cleanup(dir); reg.remove(); }
}

test('run.end: a Codex idle row leaves another store record at its pid', () => withRun(async ({ reg, dir, orch, b }) => {
  await orch.worker.write({ id: 'w-codex', substrate: 'codex', pid: b.pid, state: 'starting', worktree: dir, started_at: Date.now() - 5000 });
  await orch.worker.write({ id: 'w-codex', substrate: 'codex', pid: b.pid, state: 'idle', worktree: dir, started_at: Date.now() - 5000 });
  SR.register({ pid: b.pid, kind: 'worker', workerId: 'other', dataDir: 'B:/store', created: 123456 });
  const ended = await orch.run.end({ exit_reason: 'test' });
  assert.ok(ended.workers_marked_dead.some((m) => m.worker_id === 'w-codex'));
  assert.ok(!ended.workers_marked_dead.some((m) => m.register_retired), 'no record was this row to retire');
  assert.ok(fs.existsSync(recFile(reg, b.pid)), 'store B record stays');
}));

test('run.end: a creation-time mismatch row leaves the record of the process now holding the pid', () => withRun(async ({ reg, dir, orch, b }) => {
  await orch.worker.write({ id: 'w-a', substrate: 'claude-code', pid: b.pid, pid_created: 1000, state: 'starting', worktree: dir, started_at: Date.now() - 5000 });
  SR.register({ pid: b.pid, kind: 'worker', workerId: 'other', dataDir: 'B:/store', created: null });
  await orch.run.end({ exit_reason: 'test' });
  assert.ok(fs.existsSync(recFile(reg, b.pid)), 'store B record stays');
}));

test('run.end: the row own record (same worker, same store) is still retired', () => withRun(async ({ reg, dir, orch, b }) => {
  await orch.worker.write({ id: 'w-codex', substrate: 'codex', pid: b.pid, state: 'starting', worktree: dir, started_at: Date.now() - 5000 });
  await orch.worker.write({ id: 'w-codex', substrate: 'codex', pid: b.pid, state: 'idle', worktree: dir, started_at: Date.now() - 5000 });
  SR.register({ pid: b.pid, kind: 'worker', workerId: 'w-codex', dataDir: dir, created: null });
  const ended = await orch.run.end({ exit_reason: 'test' });
  assert.ok(ended.workers_marked_dead.some((m) => m.register_retired === true));
  assert.ok(!fs.existsSync(recFile(reg, b.pid)));
}));

test('tickAdopted: a mismatch leaves a record another spawn wrote at the pid, and retires the adopted worker own', async () => {
  const reg = H.ownSpawnRegistry();
  try {
    const snapAt = (created) => new Map([[4242, { pid: 4242, ppid: 1, created, image: 'claude.exe' }]]);
    const w = { id: 'w-adopted', dataDir: 'A:/store', pid: 4242, pidCreated: 1000, state: 'running' };
    assert.ok(SS.stampAdopted(w, { every: 3600000 }));
    SR.register({ pid: 4242, kind: 'worker', workerId: 'other', dataDir: 'B:/store', created: 2000 });
    await SS.tickAdopted({ snapshot: async () => snapAt(2000), touch: () => {} });
    assert.ok(fs.existsSync(recFile(reg, 4242)), 'store B record stays');
    // control: the adopted worker own record is retired when its process is gone
    assert.ok(SS.stampAdopted(w, { every: 3600000 }));
    SR.register({ pid: 4242, kind: 'worker', workerId: 'w-adopted', dataDir: 'A:/store', created: 1000 });
    await SS.tickAdopted({ snapshot: async () => snapAt(2000), touch: () => {} });
    assert.ok(!fs.existsSync(recFile(reg, 4242)), 'its own record is retired');
  } finally { SS.stopAdopted(); reg.remove(); }
});

test('registerOrchestrator: the exit hook leaves another spawn record, and removes its own', () => {
  const reg = H.ownSpawnRegistry();
  try {
    const proc = new EventEmitter();
    registerOrchestrator({ pid: 5151, exited: () => true }, { dataDir: 'A:/store', proc, createdOf: async () => null, stampOpts: { every: 3600000 } });
    SR.register({ pid: 5151, kind: 'worker', workerId: 'other', dataDir: 'B:/store', created: 3000 });
    proc.emit('exit');
    assert.ok(fs.existsSync(recFile(reg, 5151)), 'store B record stays');
    const own = new EventEmitter();
    registerOrchestrator({ pid: 5152, exited: () => true }, { dataDir: 'A:/store', proc: own, createdOf: async () => null, stampOpts: { every: 3600000 } });
    own.emit('exit');
    assert.ok(!fs.existsSync(recFile(reg, 5152)), 'its own record is removed');
  } finally { reg.remove(); }
});

test('registerSpawn: the child exit leaves a record another spawn wrote at its pid', () => {
  const reg = H.ownSpawnRegistry();
  try {
    const child = new EventEmitter();
    child.pid = 6161;
    PI.registerSpawn({ id: 'w-mine' }, child, 'A:/store');
    SR.register({ pid: 6161, kind: 'worker', workerId: 'other', dataDir: 'B:/store', created: 4000 });
    child.emit('exit');
    assert.ok(fs.existsSync(recFile(reg, 6161)), 'store B record stays');
    PI.registerSpawn({ id: 'w-mine' }, child, 'A:/store'); // same pid again, now its own record
    child.emit('exit');
    assert.ok(!fs.existsSync(recFile(reg, 6161)), 'its own record is removed');
  } finally { reg.remove(); }
});

test('matches: identity fields compared only when given, creation time only when both sides know it', () => {
  const rec = { pid: 1, kind: 'worker', worker_id: 'w', data_dir: 'A:/store', created: 5 };
  assert.ok(SR.matches(rec, null));
  assert.ok(SR.matches(rec, { workerId: 'w', dataDir: 'A:/store', created: 5 }));
  assert.ok(!SR.matches(rec, { workerId: 'x' }));
  assert.ok(!SR.matches(rec, { created: 6 }));
  assert.ok(SR.matches({ ...rec, created: null }, { created: 6 }));
  assert.ok(!SR.matches(rec, { kind: 'orchestrator' }));
});

test('registerOrchestrator: a later orchestrator of the same store at the reused pid keeps its record', () => {
  const reg = H.ownSpawnRegistry();
  try {
    const proc = new EventEmitter();
    registerOrchestrator({ pid: 5151, exited: () => true }, { dataDir: 'A:/store', proc, createdOf: async () => null, stampOpts: { every: 3600000 } });
    SR.register({ pid: 5151, kind: 'orchestrator', dataDir: 'A:/store', spawnedAt: Date.now() + 1 }); // run B, same store
    proc.emit('exit');
    assert.ok(fs.existsSync(recFile(reg, 5151)), 'run B orchestrator record stays');
  } finally { reg.remove(); }
});

test('tickAdopted: another store worker with the same id and no creation time yet keeps its record', async () => {
  const reg = H.ownSpawnRegistry();
  try {
    const w = { id: 'coder-1', dataDir: 'A:/store', pid: 4242, pidCreated: 1000, state: 'running' };
    assert.ok(SS.stampAdopted(w, { every: 3600000 }));
    SR.register({ pid: 4242, kind: 'worker', workerId: 'coder-1', dataDir: 'B:/store', created: null, spawnedAt: Date.now() });
    await SS.tickAdopted({ snapshot: async () => new Map([[4242, { pid: 4242, ppid: 1, created: 2000, image: 'claude.exe' }]]), touch: () => {} });
    assert.ok(fs.existsSync(recFile(reg, 4242)), 'store B record stays');
  } finally { SS.stopAdopted(); reg.remove(); }
});

test('spawnedAt tells two spawns of one worker id in one store apart; update and unregister both honour it', () => {
  const reg = H.ownSpawnRegistry();
  try {
    SR.register({ pid: 7001, kind: 'worker', workerId: 'w', dataDir: 'A:/store', spawnedAt: 200 }); // the later life
    assert.strictEqual(SR.update(7001, 99, { workerId: 'w', dataDir: 'A:/store', spawnedAt: 100 }), false);
    assert.strictEqual(JSON.parse(fs.readFileSync(recFile(reg, 7001), 'utf8')).created, null, 'created not written');
    SR.unregister(7001, { workerId: 'w', dataDir: 'A:/store', spawnedAt: 100 });
    assert.ok(fs.existsSync(recFile(reg, 7001)), 'the later life record stays');
    assert.strictEqual(SR.update(7001, 99, { workerId: 'w', dataDir: 'A:/store', spawnedAt: 200 }), true);
    SR.unregister(7001, { workerId: 'w', dataDir: 'A:/store', spawnedAt: 200 });
    assert.ok(!fs.existsSync(recFile(reg, 7001)));
  } finally { reg.remove(); }
});

test('same worker id in another store at the reused pid: run.end leaves it', () => withRun(async ({ reg, dir, orch, b }) => {
  await orch.worker.write({ id: 'coder-1', substrate: 'codex', pid: b.pid, state: 'starting', worktree: dir, started_at: Date.now() - 5000 });
  await orch.worker.write({ id: 'coder-1', substrate: 'codex', pid: b.pid, state: 'idle', worktree: dir, started_at: Date.now() - 5000 });
  SR.register({ pid: b.pid, kind: 'worker', workerId: 'coder-1', dataDir: 'B:/store', created: null });
  await orch.run.end({ exit_reason: 'test' });
  assert.ok(fs.existsSync(recFile(reg, b.pid)), 'store B record stays');
}));
