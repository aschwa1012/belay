'use strict';
// note-review-close-e2e.test.cjs — the review job against the run close through the REAL run manager and the fake executable: the close
// starts the instant a task's turn has ended, which is when an orchestrator ends a run. A fake core says the task ended with one note.
//   E1  the job is created, awaited (it ran to its own end, not cut short) and its receipt is written before any worker is stopped;
//       no child of the run survives shutdown()
//   E2  the manager's wiring: queuesFirst, the closing flag and _killSurvivor reach lifecycle, each on the real manager
//   E3  a turn that ends while the close is draining another job gets its job awaited too (the drain follows new jobs)
//   E4  a job that joins the worker map while the stop loop runs (a drain that gave up) is stopped before shutdown() returns

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunManager } = require('../../src/run/index.cjs');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const P = require('../../src/run/process.cjs');
const NR = require('../../src/run/note-review.cjs');
const LC = require('../../src/run/lifecycle.cjs');
const MJ = require('../../src/run/memory-jobs.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json');
const LV = { ...DEFAULTS, project: 'demo', notes: true, note_review: true, cost_ledger: true }; // cost_ledger: a turn reaches memory-jobs only with a job lever on

function build(tasks = ['t1']) {
  const core = createFakeCore({ runId: 'run-fake' });
  const events = [];
  core.run = { get: async () => ({ run: { memory_levers: JSON.stringify(LV) } }) };
  core.task.get = async ({ task_id }) => ({ id: task_id, run_id: 'run-fake', state: 'released' });
  core.task.list = async () => ({ tasks: tasks.map((id) => ({ id, state: 'released' })) });
  core.worker.list = async () => ({ workers: [...core.workerRows.keys()].map((id) => ({ ...core.currentWorker(id), run_id: 'run-fake' })) });
  Object.assign(core.memory, {
    events: async () => ({ events: events.slice() }),
    recordEvent: async (e) => { events.push(e); return { seq: events.length, ...e }; },
    reviewBrief: async () => ({ notes: [{ id: 'n1', title: 'x' }], reports: [], review: false, refuted_shown: [], reviewed_tasks: [] }),
    noteVerdicts: async () => ({ applied: [], refused: [], already: [], unjudged: [{ id: 'n1' }] }),
    noteSubjects: async ({ project }) => ({ project, subjects: [] }),
  });
  return { core, events };
}
const manager = (core, d) => createRunManager({ core, dataDir: d, runId: 'run-fake', memoryLevers: LV, worktree: `${d}/wt`, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
const sandbox = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-e2e-')).split(path.sep).join('/'); fs.mkdirSync(`${d}/wt`); return d; };
const reviewEvents = (events) => events.filter((e) => e.kind === 'review_job');
const cleanup = (d, pids) => { for (const pid of pids) if (pid && P.pidAlive(pid)) { try { process.kill(pid); } catch { /* gone */ } } try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } };

test('E1: the run closes right after a task that wrote a note: its job runs to its end first, and no child survives shutdown()', async () => {
  const d = sandbox();
  const { core, events } = build();
  const m = manager(core, d);
  const pids = [];
  try {
    await m.spawn({ substrate: 'claude-code', worktree: `${d}/wt`, prompt: 'do it', worker_id: 'w1', task_id: 't1' });
    pids.push(m._worker('w1').pid);
    await m._waitTurn('w1', 8000);
    const res = await m.shutdown(); // the instant the turn has ended
    const job = m._worker('notereview-t1');
    assert.ok(job, 'the job was created');
    pids.push(job.pid);
    assert.strictEqual(P.pidAlive(job.pid), false, 'the job child is gone when shutdown() returns');
    assert.strictEqual(P.pidAlive(pids[0]), false);
    const rs = reviewEvents(events).filter((e) => e.key === 'task:t1');
    assert.ok(rs.length >= 1, 'a receipt for the task');
    assert.ok(rs.every((e) => e.code !== 'E_SHUTDOWN' && e.code !== 'E_WORKER_NOT_LIVE' && e.code !== 'E_TIMEOUT'), `the job ran to its own end, it was not cut short: ${JSON.stringify(rs.map((e) => e.code))}`);
    assert.ok(!res.stopped.includes('notereview-t1') || job.state === 'stopped');
  } finally { cleanup(d, pids); }
});

test('E2: the manager wires queuesFirst, the closing flag and _killSurvivor', async () => {
  const d = sandbox();
  const { core } = build();
  const m = manager(core, d);
  const pids = [];
  try {
    await m.spawn({ substrate: 'claude-code', worktree: `${d}/wt`, prompt: 'x', worker_id: 'w1', task_id: 't1' });
    pids.push(m._worker('w1').pid);
    await m._waitTurn('w1', 8000);
    // _killSurvivor kills a live child by its handle and exact pid, and returns the receipt (null for an unknown id)
    assert.strictEqual(await m._killSurvivor('nobody'), null);
    const k = await m._killSurvivor('w1');
    assert.ok(k && k.pid === pids[0], JSON.stringify(k));
    assert.strictEqual(P.pidAlive(pids[0]), false);
    assert.ok(!m._closing());
    await m.shutdown();
    assert.strictEqual(m._closing(), true, 'shutdown set the closing flag before its stop loop');
    assert.strictEqual(m._closed(), true);
  } finally { cleanup(d, pids); }
  // queuesFirst: with the levers on, a close right after the turn finds the job (E1 would see a stopped job otherwise); the flag below is the unit
  assert.strictEqual(NR.expectsJobs({ memoryLevers: LV }), true);
  assert.strictEqual(NR.expectsJobs({ memoryLevers: { ...LV, note_review: false } }), false);
});

// Shared by E3 and E4: a fake of the stop loop's world, lifecycle's real shutdown over records that look like workers.
const rec = (id) => ({ id, queue: Promise.resolve(), state: 'running' });
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function world(drainMs) {
  const { core } = build(['ta', 'tb']);
  const events = [];
  core.memory.recordEvent = async (e) => { events.push(e); return e; };
  core.memory.events = async () => ({ events: events.slice() });
  const flags = { closed: false, closing: false, ownerGone: false };
  const workers = new Map();
  const m = { spawned: [], stopped: [], gates: new Map(), flags };
  m._closed = () => flags.closed; m._closing = () => flags.closing;
  m.spawn = async (a) => { if (m.gates.has(a.worker_id)) await m.gates.get(a.worker_id).promise; m.spawned.push(a.worker_id); workers.set(a.worker_id, rec(a.worker_id)); return {}; };
  m.wait = async ({ worker_ids }) => (m.waitFor ? m.waitFor(worker_ids[0]) : { event: 'turn_end', is_error: false, timed_out: false });
  m.stop = async ({ worker_id }) => { m.stopped.push(worker_id); };
  m._worker = (id) => ({ lastAssistantText: '{}', costUsd: 0.01, ...(workers.get(id) || {}) });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-w-')).split(path.sep).join('/');
  const ctx = { core, runId: 'run-fake', dataDir, memoryLevers: LV, worktree: dataDir, manager: m, shutdownFlags: flags };
  core.worker.list = async () => ({ workers: [] });
  const shutdown = () => LC.shutdown(workers, {
    stop: async (a) => m.stop(a), core: { isOwner: () => false }, clearPoll: () => {},
    markClosed: () => { flags.closed = true; }, markClosing: () => { flags.closing = true; }, markOwnerGone: () => { flags.ownerGone = true; return new Set(); },
    beforeStop: () => NR.drain(ctx, drainMs), queuesFirst: () => NR.expectsJobs(ctx), onDrained: async () => {},
  });
  const turn = (w, taskId) => MJ.afterTurn(w, ctx, { snap: { taskId, workerId: w.id, turn: 1, substrate: 'claude-code', pid: 1, cost: 0.1 } });
  return { m, events, workers, ctx, shutdown, turn, dataDir };
}

test('E3: a turn that ends while the close drains another job gets its job awaited too, before any worker is stopped', async () => {
  const W = world(120000);
  try {
    const a = rec('wa'), b = rec('wb'); W.workers.set('wa', a); W.workers.set('wb', b);
    const hold = defer();
    W.m.waitFor = async (id) => { if (id === 'notereview-ta') await hold.promise; return { event: 'turn_end', is_error: false, timed_out: false }; };
    W.turn(a, 'ta');
    await ticks();
    const down = W.shutdown();
    await ticks();
    W.turn(b, 'tb'); // B's turn ends while A's job is being drained
    await ticks();
    hold.resolve();
    await down;
    assert.deepStrictEqual(W.m.spawned.sort(), ['notereview-ta', 'notereview-tb'], 'both jobs were created');
    const stopsOfWorkers = W.m.stopped.filter((x) => !x.startsWith('notereview-'));
    assert.deepStrictEqual(stopsOfWorkers.sort(), ['wa', 'wb']);
    const lastJobStop = Math.max(...['notereview-ta', 'notereview-tb'].map((x) => W.m.stopped.indexOf(x)));
    assert.ok(lastJobStop < W.m.stopped.indexOf('wa') || lastJobStop < W.m.stopped.indexOf('wb'), `jobs finished first: ${W.m.stopped.join(',')}`);
    assert.strictEqual(W.m.stopped.indexOf('wa') > lastJobStop && W.m.stopped.indexOf('wb') > lastJobStop, true, 'no worker was stopped before both jobs finished');
  } finally { fs.rmSync(W.dataDir, { recursive: true, force: true }); }
});

test('E4: a job whose spawn lands while the stop loop runs (the drain gave up) is stopped before shutdown() returns, with a receipt', async () => {
  const W = world(30); // the drain gives up after 30 ms
  try {
    const a = rec('wa'); W.workers.set('wa', a);
    const gate = defer();
    W.m.gates.set('notereview-ta', gate); // the job's spawn is still under way when the drain gives up
    W.m.waitFor = async () => ({ event: 'exited', is_error: false, timed_out: false });
    W.turn(a, 'ta');
    await ticks();
    const origStop = W.m.stop;
    W.m.stop = async (x) => { await origStop(x); if (x.worker_id === 'wa') { gate.resolve(); await ticks(); } }; // while worker wa is being stopped, the job's record joins the map
    await W.shutdown();
    assert.ok(W.m.stopped.includes('notereview-ta'), `the late job was stopped: ${W.m.stopped.join(',')}`);
    assert.ok(reviewEvents(W.events).some((e) => e.key === 'task:ta' && e.ok === false), 'and its failure is a receipt');
  } finally { fs.rmSync(W.dataDir, { recursive: true, force: true }); }
});
