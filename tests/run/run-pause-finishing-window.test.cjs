'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// A pause refuses a run that turns finishing (idle rule or timeout) while its store writes are pending, and parks nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createRunPauseControl } = require(path.join(__dirname, '..', '..', 'src', 'run', 'run-pause.cjs'));

function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }

function build(opts = {}) {
  const state = { finishing: false, paused: false, hookPauseCalls: 0 };
  const gate = deferred();
  const calls = [];
  const runRow = { id: 'r1', paused_at: null };
  const core = {
    run: {
      get: async () => ({ run: { ...runRow } }),
      setPaused: async (a) => {
        calls.push(a);
        if (calls.length === 1) await gate.p;
        if (!a.paused && opts.undoError) throw opts.undoError;
        if (a.paused) Object.assign(runRow, { paused_at: a.at, paused_by: a.by });
        else Object.assign(runRow, { paused_at: null, paused_by: null });
        return runRow;
      },
    },
    worker: { list: async () => (opts.onList && opts.onList(state), { workers: [
      { id: 'w1', run_id: 'r1', state: 'running', pid_alive: true, substrate: 'claude-code' },
      { id: 'w2', run_id: 'r1', state: 'running', pid_alive: true, substrate: 'claude-code' },
    ] }) },
  };
  const hook = {
    pid: 1, exited: () => false, finishing: () => state.finishing, endedBy: () => (state.finishing ? 'idle' : null),
    isPaused: () => state.paused,
    pause: async (by) => { state.hookPauseCalls += 1; state.paused = true; return { paused_at: 1, paused_by: by, interrupt: { sent: !state.finishing }, timeout: null }; },
  };
  const parks = [];
  const pauseWorker = async (id) => { parks.push(id); return { success: true, worker_id: id, paused_at: 2, paused_by: 'operator:9' }; };
  const ctl = createRunPauseControl({ runId: 'r1', core, hook, pauseWorker, resumeWorker: async () => ({ success: true }), stopInFlight: () => false });
  return { state, gate, calls, runRow, ctl, parks };
}

test('a run that starts finishing while setPaused is pending is refused, unpaused and not parked', async () => {
  const t = build();
  const p = t.ctl.pause({ run_id: 'r1', caller: { role: 'operator', pid: 9 } });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); // doPause is now parked inside the first setPaused
  assert.strictEqual(t.calls.length, 1);
  t.state.finishing = true;
  t.gate.resolve();
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, 'the pause is refused');
  assert.strictEqual(err.code, 'E_NOT_FOUND');
  assert.strictEqual(err.detail && err.detail.phase, 'finishing');
  assert.deepStrictEqual(t.parks, []);
  assert.strictEqual(t.state.hookPauseCalls, 0);
  assert.strictEqual(t.calls.length, 2, 'the row write is undone');
  assert.strictEqual(t.calls[1].paused, false);
  assert.strictEqual(t.runRow.paused_at, null);
});

test('a run that turns finishing inside the parked-rows listing is refused by the re-check before the row write', async () => {
  // The flip happens inside worker.list, after doPause's first finishing check and before its second one.
  const t = build({ onList: (s) => { s.finishing = true; } });
  t.gate.resolve();
  let err = null;
  try { await t.ctl.pause({ run_id: 'r1', caller: { role: 'operator', pid: 9 } }); } catch (e) { err = e; }
  assert.ok(err && err.code === 'E_NOT_FOUND');
  assert.strictEqual(err.detail && err.detail.phase, 'finishing');
  assert.strictEqual(t.calls.length, 0, 'no row was written');
  assert.strictEqual(t.state.hookPauseCalls, 0);
  assert.deepStrictEqual(t.parks, []);
});

test('a failed undo of the row write is named in the refusal', async () => {
  const undoError = Object.assign(new Error('owner is closing'), { code: 'E_BUSY' });
  const t = build({ undoError });
  const p = t.ctl.pause({ run_id: 'r1', caller: { role: 'operator', pid: 9 } });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  t.state.finishing = true;
  t.gate.resolve();
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err && err.code === 'E_NOT_FOUND');
  assert.match(err.message, /the row may be left paused: owner is closing/);
  assert.strictEqual(err.detail.row_left_paused, true);
});

test('a run that starts finishing while the parked rows are listed is refused before any row write', async () => {
  const t = build();
  t.gate.resolve();
  const p = t.ctl.pause({ run_id: 'r1', caller: { role: 'operator', pid: 9 } });
  t.state.finishing = true; // set synchronously, before doPause passes its first await
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err && err.code === 'E_NOT_FOUND');
  assert.strictEqual(t.calls.length, 0, 'no row was written');
  assert.deepStrictEqual(t.parks, []);
});
