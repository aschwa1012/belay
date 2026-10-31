'use strict';
// Three exit races: a stop whose worker exits during the background-task stop, a core refusal of the running write
// for a process that died in flight, and the base restatement for a process already gone.
require('../helpers/tmp.cjs');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const W = require('../../src/run/worker.cjs');
const BG = require('../../src/run/background.cjs');
const WR = require('../../src/run/write-row.cjs');
const { createDoStop } = require('../../src/run/do-stop.cjs');
const H = require('../core/helpers.cjs');

function record(pid) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-race-')).split(path.sep).join('/');
  const w = W.newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: dataDir, dataDir, captureBase: false });
  const child = new EventEmitter(); child.pid = pid; child.exitCode = null; child.signalCode = null; child.stdin = null;
  w.child = child; w.pid = pid; w.launches = 1;
  return { w, child, dataDir };
}

test('stop: a worker that exits during the background-task stop returns the exited receipt', async () => {
  const { w, child } = record(process.pid);
  w.readyAt = Date.now(); w.state = 'running';
  const rows = [];
  const writeRow = async (rw, state) => { rows.push(state); rw.state = state; return { seq: rows.length }; };
  const ctx = { writeRow, runId: 'r1' }; w.ctx = ctx;
  const orig = BG.stopTasks;
  BG.stopTasks = async (rec) => { child.exitCode = 0; W.settle(rec, 0, null, 'exit-event', ctx); return [{ task_id: 't1', description: 'sleep', status_after: 'stopped' }]; };
  let res;
  try { res = await createDoStop({ ctx, writeRow })(w, 'graceful', 6000); } finally { BG.stopTasks = orig; }
  assert.strictEqual(res.graceful, true);
  assert.strictEqual(res.exit_code, 0);
  assert.strictEqual(res.background_tasks_stopped.length, 1);
  assert.strictEqual(w.child, null);
});

test('core refuses the running write for a process that died in flight: the death waits for the exit code', async () => {
  const { w, child, dataDir } = record(process.pid); // the pid still answers; the core says the worker is not live
  w.readyAt = Date.now(); w.state = 'starting';
  const written = [];
  const ctx = { runId: 'r1', adapterPid: process.pid, dataDir, core: { worker: {
    write: async (row) => {
      if (row.state === 'running') throw Object.assign(new Error('not live'), { code: 'E_WORKER_NOT_LIVE' });
      written.push({ state: row.state, exit_code: row.exit_code }); return { seq: written.length + 1 };
    }, get: async () => null } } };
  ctx.writeRow = WR.createWriteRow(ctx, { closed: false }); w.ctx = ctx;
  await ctx.writeRow(w, 'running');
  assert.strictEqual(w.settled, false, 'the death is held for the exit event, not settled with a null code');
  assert.deepStrictEqual(written, []);
  child.exitCode = 3; W.settle(w, 3, null, 'exit-event', ctx);
  await w.queue;
  const dead = written.find((x) => x.state === 'dead' || x.state === 'stopped');
  assert.ok(dead, 'a terminal row is written');
  assert.strictEqual(dead.exit_code, 3);
});

