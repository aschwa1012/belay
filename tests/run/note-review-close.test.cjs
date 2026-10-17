'use strict';
// note-review-close.test.cjs — the per-task note-review job against the run's close. A real engine on a sandbox store, a fake run
// manager, and lifecycle.cjs's real shutdown. Every interleaving is forced through a gate (a promise the test opens), never a sleep:
//   C1  the close begins while afterTurn is still before onTaskEnded (a gated task.get): the job is still created, awaited and applied,
//       and it is spawned before any worker is stopped or the closed flag flips
//   C2  onTaskEnded registers its job before its first await, so a drain called in the same tick waits for it
//   C3  a job whose spawn finishes after the manager closed is stopped by the exact pid of a real child, and leaves an E_SHUTDOWN receipt
//   C4  every path that skips a task with notes leaves one review_job receipt for it
//   C5  a close with no notes written adds no wait, and awaits no queue twice

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn: spawnChild } = require('node:child_process');
const { core: coreMod, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const { Store } = coreMod('store.cjs');
const { Engine } = coreMod('engine.cjs');
const NR = require('../../src/run/note-review.cjs');
const MJ = require('../../src/run/memory-jobs.cjs');
const LC = require('../../src/run/lifecycle.cjs');
const P = require('../../src/run/process.cjs');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');

let dir, store, E, core;
const RUN = 'r-nrclose';
const orch = callerFor('orchestrator', { run_id: RUN });
const harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
const wcaller = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const receipts = (taskId) => store.p("SELECT * FROM memory_event WHERE kind = 'review_job' AND key = ? ORDER BY seq").all(`task:${taskId}`);
const LV = { ...DEFAULTS, project: 'acme', notes: true, note_review: true };
const STREAM_LINE = 'fixtures/unlisted.json was never opened';
let seq = 0, k = 0;

const DIM = 64;
const embed = async (text) => {
  const m = /\bK(\d+)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  v[m ? Number(m[1]) : DIM - 1] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};
const note = (marker) => ({ kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `add a ${marker} test fixture`, basis: 'observed', evidence: [{ where: `src/${marker}.js`, saw: 'never read' }], applies_to: ['fixtures'] });
const toolResult = (text) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: {} }] } })}\n${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: text }] } })}\n`;
const verdictsFor = (ids, v = 'confirmed') => JSON.stringify({ memory_verdicts: ids.map((id) => ({ id, verdict: v, cites: [{ where: 'stream', quote: STREAM_LINE }], reason: 'the stream shows it' })) });

async function written(w, n = 1) {
  await call('worker.write', orch, { id: w, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${w}`, last_event_at: Date.now(), worktree: dir });
  const t = await call('task.create', orch, { spec: `close ${++seq}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: w });
  await call('worker.write', orch, { id: w, task_id: t.id });
  fs.mkdirSync(`${dir}/workers/${w}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${w}/stream.jsonl`, toolResult(STREAM_LINE));
  const notes = Array.from({ length: n }, () => note(`K${++k}`));
  const out = await call('lease.release', wcaller(w), { lease_id: a.new_lease.id, notes, result: { summary: 'done' } });
  await call('task.evaluate', orch, { task_id: t.id, worktree: dir });
  return { task: { ...(await call('task.get', orch, { task_id: t.id })), state: 'released' }, notes: out.notes.map((x) => x.id), worker: w };
}

// A fake run manager. `log` is the order in which things happened; `closed` is the flag shutdown flips.
function fakeManager(answer, { onSpawn } = {}) {
  const m = { spawned: [], stopped: [], killed: [], log: [], flags: { closed: false, ownerGone: false }, recs: new Map(), failStop: false };
  m.spawn = async (a) => {
    m.log.push('spawn');
    m.spawned.push(a);
    await call('worker.write', orch, { id: a.worker_id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now(), worktree: a.worktree });
    m.recs.set(a.worker_id, { lastAssistantText: answer, costUsd: 0.01 });
    if (onSpawn) await onSpawn(m, a);
    return {};
  };
  m.wait = async () => ({ event: 'turn_end', is_error: false, timed_out: false });
  m.stop = async ({ worker_id }) => { m.log.push('stop-job'); if (m.failStop) throw Object.assign(new Error('the run is closed, so the stop could not write its row'), { code: 'E_SHUTDOWN' }); m.stopped.push(worker_id); };
  m._worker = (id) => m.recs.get(id);
  m._closed = () => m.flags.closed;
  m._killSurvivor = async (id) => { m.killed.push(id); };
  return m;
}
const ctxFor = (m, extra = {}) => ({ core, runId: RUN, dataDir: dir, memoryLevers: LV, worktree: dir, manager: m, shutdownFlags: m ? m.flags : { closed: false }, ...extra });
const J = (ctx) => ({ ctx, core: ctx.core, lv: LV, w: null, gate: { aborted: false }, s: {}, turnPath: false });
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const settled = (p) => { let done = false; p.then(() => { done = true; }, () => { done = true; }); return async () => { await ticks(); return done; }; };

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  core = new Proxy({}, { get: (_, g) => (g === 'caller' ? harness : new Proxy({}, { get: (__, n) => (args) => call(`${g}.${n}`, harness, args || {}) })) });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, note_review: true }) });
});
after(() => { store.close(); cleanup(dir); });

test('C1: the close begins before afterTurn reaches onTaskEnded; the job is still created first, awaited, applied, and the workers stop after it', async () => {
  const w = await written('wr-c1', 2);
  const m = fakeManager(verdictsFor([w.notes[0]]));
  const gate = defer();
  // The seam: task.get, the call afterTurn makes before it decides on the review, is held until the test opens it.
  const gated = { ...core, task: { get: async (a) => { await gate.promise; return w.task; }, list: (a) => core.task.list(a) }, memory: core.memory, worker: core.worker };
  const ctx = ctxFor(m, { core: gated });
  const rec = { id: w.worker, queue: Promise.resolve(), state: 'running' };
  const workers = new Map([[rec.id, rec]]);
  MJ.afterTurn(rec, ctx, { snap: { taskId: w.task.id, workerId: w.worker, turn: 1, substrate: 'claude-code', pid: 1, cost: 0.1 } });
  assert.ok(rec.memoryQueue, 'afterTurn queued its work');
  const NRdrain = require('../../src/core/spawn-bounds.cjs').NOTE_REVIEW_DRAIN_MS;
  const down = LC.shutdown(workers, {
    stop: async ({ worker_id }) => { m.log.push(`stop:${worker_id}`); },
    core: { isOwner: () => false }, clearPoll: () => {},
    markClosed: () => { m.log.push('closed'); m.flags.closed = true; },
    markOwnerGone: () => { m.flags.ownerGone = true; return new Set(); },
    beforeStop: () => NR.drain(ctx, NRdrain), queuesFirst: () => NR.expectsJobs(ctx),
    onDrained: async () => { m.log.push('drained'); },
  });
  const isDown = settled(down);
  assert.strictEqual(await isDown(), false, 'the close waits for the queue that will create the job');
  assert.deepStrictEqual(m.log, [], 'nothing has stopped and nothing has spawned yet');
  gate.resolve();
  const res = await down;
  assert.deepStrictEqual(res.memory_gave_up, []);
  assert.strictEqual(m.spawned.length, 1, 'the job was created');
  assert.strictEqual(m.spawned[0].worker_id, `notereview-${w.task.id}`);
  assert.deepStrictEqual(m.log, ['spawn', 'stop-job', `stop:${w.worker}`, 'closed', 'drained'], 'spawned and finished before any worker stopped or the flag flipped');
  assert.strictEqual(rowOf(w.notes[0]).status, 'verified', 'its verdict was applied');
  const rs = receipts(w.task.id);
  assert.deepStrictEqual(rs.map((r) => r.ok), [1], 'one receipt, ok');
});

test('C2: onTaskEnded registers the job before its first await, so a drain in the same tick waits for it', async () => {
  const w = await written('wr-c2');
  const gate = defer();
  const m = fakeManager(verdictsFor([w.notes[0]]));
  const gated = { ...core, task: { get: core.task.get, list: async (a) => { await gate.promise; return core.task.list(a); } }, memory: core.memory, worker: core.worker };
  const ctx = ctxFor(m, { core: gated });
  const p = NR.onTaskEnded(J(ctx), w.task);
  const drained = NR.drain(ctx, 60000); // same tick: before task.list has answered
  const isDrained = settled(drained);
  assert.strictEqual(await isDrained(), false, 'the drain sees the placeholder');
  assert.strictEqual(m.spawned.length, 0);
  gate.resolve();
  await drained;
  await p;
  assert.strictEqual(m.spawned.length, 1, 'the drain returned only after the job ran');
  assert.strictEqual(receipts(w.task.id).length, 1);
});

test('C3: a job whose spawn lands after the manager closed is stopped by the exact pid of its real child, with an E_SHUTDOWN receipt', async () => {
  const w = await written('wr-c3');
  let child = null;
  const m = fakeManager(verdictsFor([w.notes[0]]), {
    onSpawn: async (mm, a) => {
      child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      await new Promise((r) => child.once('spawn', r));
      mm.flags.closed = true; // the close finished while the child was starting: the shutdown loop never saw this one
      mm.failStop = true; // and a stop writes a row, which a closed run refuses
      mm.rec = { id: a.worker_id, pid: child.pid, child, settled: false };
      mm.log.push(`child:${child.pid}`);
    },
  });
  m._killSurvivor = async (id) => { m.killed.push(id); return LC.killSurvivor(m.rec, null); };
  const pid = () => child && child.pid;
  try {
    await NR.runJob(J(ctxFor(m)), w.task);
    assert.ok(child && child.pid, 'a real child was started');
    assert.strictEqual(P.pidAlive(child.pid), false, `the child ${pid()} was killed`);
    assert.deepStrictEqual(m.killed, [`notereview-${w.task.id}`], 'by the survivor kill, after the stop was refused');
    const rs = receipts(w.task.id);
    assert.deepStrictEqual(rs.map((r) => [r.ok, r.code, r.worker_id]), [[0, 'E_SHUTDOWN', `notereview-${w.task.id}`]]);
    assert.strictEqual(rowOf(w.notes[0]).status ?? 'unverified', 'unverified', 'nothing was applied from a stopped job');
  } finally { if (child && child.pid && P.pidAlive(child.pid)) { try { process.kill(child.pid); } catch { /* gone */ } } }
});

test('C4: every path that skips a task with notes leaves one receipt for it', async () => {
  // 1. the manager is closed when the task is decided on
  const a = await written('wr-c4a');
  const closedM = fakeManager('{}'); closedM.flags.closed = true;
  await NR.onTaskEnded(J(ctxFor(closedM)), a.task);
  assert.deepStrictEqual(receipts(a.task.id).map((r) => [r.ok, r.code]), [[0, 'E_SHUTDOWN']]);
  assert.strictEqual(closedM.spawned.length, 0);
  // 2. the task list cannot be read
  const b = await written('wr-c4b');
  const broken = { ...core, task: { get: core.task.get, list: async () => { throw Object.assign(new Error('list failed'), { code: 'E_INTERNAL' }); } }, memory: core.memory, worker: core.worker };
  await NR.onTaskEnded(J(ctxFor(fakeManager('{}'), { core: broken })), b.task);
  assert.deepStrictEqual(receipts(b.task.id).map((r) => [r.ok, r.code]), [[0, 'E_INTERNAL']]);
  // 3. the manager has no way to spawn
  const c = await written('wr-c4c');
  await NR.onTaskEnded(J(ctxFor({ _closed: () => false, flags: { closed: false } })), c.task);
  assert.deepStrictEqual(receipts(c.task.id).map((r) => [r.ok, r.code]), [[0, 'E_INTERNAL']]);
  // 4. the turn ended after the close: afterTurn names the drop on the worker, and the run's store-only sweep leaves the owed receipt
  const d = await written('wr-c4d');
  const m = fakeManager('{}'); m.flags.closed = true;
  const rec = { id: d.worker, queue: Promise.resolve(), state: 'running' };
  MJ.afterTurn(rec, ctxFor(m), { snap: { taskId: d.task.id, workerId: d.worker, turn: 1, substrate: 'claude-code', pid: 1, cost: 0.1 } });
  assert.strictEqual(rec.lastError.where, 'after-shutdown');
  assert.strictEqual(m.spawned.length, 0);
  const tasks = (await call('task.list', orch, {})).tasks;
  const workers = (await call('worker.list', orch, {})).workers;
  await NR.sweep(J(ctxFor(null)), tasks, workers);
  assert.deepStrictEqual(receipts(d.task.id).map((r) => [r.ok, r.code]), [[0, 'E_TIMEOUT']]);
  assert.deepStrictEqual(JSON.parse(receipts(d.task.id)[0].row_ids), d.notes, 'the owed receipt names the notes');
  // 5. the owner is already going: nothing is written (a write would elect a new owner), and the sweep names it later
  const e = await written('wr-c4e');
  const gone = fakeManager('{}'); gone.flags.closed = true; gone.flags.ownerGone = true;
  await NR.onTaskEnded(J(ctxFor(gone)), e.task);
  assert.strictEqual(receipts(e.task.id).length, 0);
  await NR.sweep(J(ctxFor(null)), (await call('task.list', orch, {})).tasks, (await call('worker.list', orch, {})).workers);
  assert.strictEqual(receipts(e.task.id).length, 1, 'the sweep names it');
});

test('C5: a close with no notes written adds no wait and awaits no queue twice', async () => {
  const mk = (id, q) => ({ id, queue: Promise.resolve(), state: 'running', ...(q ? { memoryQueue: q } : {}) });
  const workers = new Map([['a', mk('a')], ['b', mk('b', Promise.resolve())], ['c', mk('c', Promise.reject(new Error('a queue that failed')))]]);
  const log = [];
  const t0 = Date.now();
  const res = await LC.shutdown(workers, {
    stop: async ({ worker_id }) => { log.push(worker_id); },
    core: { isOwner: () => false }, clearPoll: () => {}, markClosed: () => {}, markOwnerGone: () => new Set(),
    beforeStop: () => NR.drain({}, 120000), queuesFirst: () => true, onDrained: async () => {},
  });
  const ms = Date.now() - t0;
  assert.deepStrictEqual(log, ['a', 'b', 'c']);
  assert.deepStrictEqual(res.memory_gave_up, []);
  assert.ok(ms < 1000, `the close took ${ms} ms with every queue settled`);
  // a run that expects no review job keeps its old order: a queue that settles only once the flag flips is not waited on before it
  const gate = defer();
  const held = new Map([['h', mk('h', gate.promise)]]);
  const out0 = await LC.shutdown(held, {
    stop: async () => {}, core: { isOwner: () => false }, clearPoll: () => {}, markClosed: () => gate.resolve(), markOwnerGone: () => new Set(),
    beforeStop: async () => {}, queuesFirst: () => false, onDrained: async () => {},
  });
  assert.deepStrictEqual(out0.memory_gave_up, [], 'the queue was released by the flag and finished inside its bound');
  // a queue that never settles is named once, and the bound is not spent twice (the early drain's give-up is not waited on again)
  const stuckWorkers = new Map([['s', mk('s', new Promise(() => {}))]]);
  const seen = [];
  const orig = global.setTimeout;
  global.setTimeout = (fn, ms2, ...rest) => { seen.push(ms2); return orig(fn, Math.min(ms2, 20), ...rest); }; // shrink every bound; count them
  try {
    const out = await LC.shutdown(stuckWorkers, {
      stop: async () => {}, core: { isOwner: () => false }, clearPoll: () => {}, markClosed: () => {}, markOwnerGone: () => new Set(),
      beforeStop: async () => {}, queuesFirst: () => true, onDrained: async () => {},
    });
    assert.deepStrictEqual(out.memory_gave_up, ['s'], 'named once');
    assert.strictEqual(seen.filter((x) => x === 5000).length, 1, 'the memory bound was started once, not once before the review drain and once after');
  } finally { global.setTimeout = orig; }
});
