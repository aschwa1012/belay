'use strict';
// restart-late-rows.test.cjs — a restart yields the rows, and so the wakes, of the new life only. The previous life's terminal row
// was queued on the worker's write queue unbound to its launch: queued behind another write when a restart launched the next life,
// it landed after the new life's `starting` row and recorded the new life as dead, which the wake announced as a death (a late
// duplicate). Now a restart drains the queue before it launches, and a terminal row that still finds a newer launch is dropped.
// Deterministic seams: the worker's queue held by a gate, opened by the restart's own drain (or, without it, by the new life's
// first row), never a sleep.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EX = require('../../src/run/exit.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { diffWorkers } = require('../../src/run/wake.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');

const record = (queue) => ({ id: 'x', substrate: 'claude-code', launches: 1, queue, child: null, settled: false, turnWaiters: [], exitWaiters: [], readyWaiters: [] });

test('a terminal row still queued when the next life launches is dropped and named, never written over the new life', async () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  const writes = [];
  const ctx = { writeRow: async (w, state) => { writes.push([state, w.launches]); return {}; } };
  const w = record(gate);
  EX.settle(w, 1, null, 'exit-event', ctx);
  w.launches += 1; // a restart launched the next life
  open();
  await w.queue;
  assert.deepStrictEqual(writes, []);
  assert.deepStrictEqual([w.lastError.where, w.lastError.state, typeof w.lastError.dropped], ['worker.write/exit', 'dead', 'string']);

  const same = record(Promise.resolve());
  EX.settle(same, 1, null, 'exit-event', ctx);
  await same.queue;
  assert.deepStrictEqual(writes, [['dead', 1]], 'with no relaunch the row is written as before');
});

test('a restart of a worker whose dead row is still queued records that death first, and the new life wakes no death', { timeout: 90000 }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-late-rows-')).split(path.sep).join('/');
  fs.mkdirSync(`${d}/wt`, { recursive: true });
  const core = createFakeCore();
  const m = createRunManager({ core, dataDir: d, runId: 'run-lr', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  const spy = { armed: false, open: null };
  class SpyPromise extends Promise {
    then(a, b) { if (spy.armed && spy.open) { const o = spy.open; spy.open = null; o(); } return super.then(a, b); }
  }
  const write = core.worker.write;
  core.worker.write = async (r) => { if (r.state === 'starting' && spy.open) { const o = spy.open; spy.open = null; o(); } return write(r); };
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: `${d}/wt`, prompt: 'one', worker_id: 'lr' });
    await m.wait({ worker_ids: ['lr'], timeout_ms: 30000 }); // its first turn: the worker is idle
    const w = m._worker('lr');
    await w.queue;
    const baseline = diffWorkers({ prev: {}, rows: (await core.worker.list({})).workers, runId: 'run-lr', nowMs: 0, graceMs: 0 }).next;
    // The seam: another write holds the queue, so the death's own row is queued behind it.
    const gate = new SpyPromise((r) => { spy.open = r; });
    w.queue = SpyPromise.resolve(w.queue).then(() => gate);
    process.kill(row.pid); // the exact pid belay spawned
    assert.ok(await m._waitExit('lr', 30000), 'the exit event arrived');
    const before = core.rowsFor('lr').length;
    spy.armed = true; // from here, the first wait on the queue opens the gate; so does the new life's first row
    const r = await m.restart({ worker_id: 'lr', first_turn_timeout_ms: 8000 });
    assert.notStrictEqual(r.new_pid, row.pid);
    const after = core.rowsFor('lr').slice(before).map((x) => [x.state, x.pid]);
    assert.deepStrictEqual(after[0], ['dead', row.pid], `the old life's death is recorded before the new life's rows: ${JSON.stringify(after)}`);
    assert.ok(!after.slice(1).some(([s]) => s === 'dead'), `no dead row after the relaunch: ${JSON.stringify(after)}`);
    // The wake over the same rows: the old life's death, once, and nothing that says the new life died.
    const { events } = diffWorkers({ prev: baseline, rows: [core.currentWorker('lr')], runId: 'run-lr', nowMs: 1, graceMs: 0 });
    assert.ok(!events.some((e) => e.event === 'death'), `the current row is the new life's: ${JSON.stringify(events)}`);
  } finally {
    await m.shutdown();
    cleanup(d);
  }
});

test('a terminal row a relaunch overtook keeps its exit facts, and the next life\'s worker_wait answer carries them', async () => {
  let open;
  const gate = new Promise((r) => { open = r; });
  const w = { ...record(gate), turns: 1, turnEnded: true, lastCheckpointId: null };
  EX.settle(w, 3, null, 'exit-event', { writeRow: async () => ({}) });
  w.launches += 1; // a Codex message launched the next turn's process without draining
  open();
  await w.queue;
  assert.deepStrictEqual(w.droppedRow, { state: 'dead', exit_code: 3, exit_signal: null, established_by: 'exit-event', launch: 2 });
  w.settled = false; w.child = {}; // the new process, between turns
  const { createWait } = require('../../src/run/wait.cjs');
  const ans = await createWait({ workers: new Map([['x', w]]), get: () => w })({ worker_ids: ['x'], timeout_ms: 1000 });
  assert.deepStrictEqual([ans.event, ans.previous_row_dropped && ans.previous_row_dropped.exit_code], ['turn_end', 3]);
  w.launches += 1;
  assert.strictEqual((await createWait({ workers: new Map([['x', w]]), get: () => w })({ worker_ids: ['x'], timeout_ms: 1000 })).previous_row_dropped, undefined, 'only about the life right after it');
});
