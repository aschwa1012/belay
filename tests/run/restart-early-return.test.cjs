'use strict';
// restart-early-return.test.cjs — ADR 0048: over MCP a restart answers inside MCP_TOOL_TIMEOUT. With a budget the call is
// not held by a slow stop or relaunch or by a first turn that does not end: it returns `not ready yet` with
// first_turn_awaited false, and worker_wait sees the worker come up. Both slow paths are injected (a held row write, a
// held fake answer), so nothing waits on a fixed sleep and no machine load is needed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The budget seam. manager.cjs destructures createBudget when it loads, so the wrap goes in first. A test sets `seam.ends` (a
// promise: the budget ends when it resolves, however slow the stop was) or `seam.leftMs` (what is left once the relaunch has
// finished). With neither set the real clock budget is used, so the other tests are unchanged.
const RB = require('../../src/run/restart-budget.cjs');
const seam = { ends: null, leftMs: null };
const realCreateBudget = RB.createBudget;
RB.createBudget = (ms, now) => {
  const real = realCreateBudget(ms, now);
  if (!seam.ends && seam.leftMs === null) return real;
  const ends = seam.ends; const leftMs = seam.leftMs;
  return {
    ...real,
    left: () => (leftMs === null ? real.left() : leftMs),
    within: (p) => (ends ? Promise.race([p, ends.then(() => RB.EARLY)]) : p),
  };
};
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => p.replace(/\\/g, '/');

async function until(pred, ms) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

function setup(prefix) {
  const data = fwd(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const worktree = fwd(path.join(data, 'wt'));
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore({ runId: 'run-fake', resumeLineText: 'LINE' });
  const m = createRunManager({ core, dataDir: data, runId: 'run-fake', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  return { data, worktree, core, m };
}

test('restart with a budget: a relaunch that is still being written when the budget ends returns not ready yet, and worker_wait sees the worker come up', async () => {
  const { data, worktree, core, m } = setup('belay-restart-early-a-');
  let release = null;
  try {
    const first = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    // The injected slow step: the relaunch's first row is held until the test releases it, as a slow stop would hold it.
    const held = new Promise((res) => { release = res; });
    let budgetEnds = null;
    seam.ends = new Promise((res) => { budgetEnds = res; });
    const write = core.worker.write.bind(core.worker);
    let armed = false;
    core.worker.write = async (row) => {
      // The budget ends at the moment the relaunch's first row is held, not at a clock time a slow stop could pass.
      if (!armed && row.state === 'starting' && row.pid && row.pid !== first.pid) { armed = true; budgetEnds(); await held; }
      return write(row);
    };
    const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000, mcp_budget_ms: 300 });
    assert.strictEqual(r.first_turn_awaited, false, JSON.stringify(r));
    assert.strictEqual(r.status, 'not ready yet');
    assert.strictEqual(r.restart_path, 'early_return');
    assert.ok(Number.isInteger(r.elapsed_ms) && r.elapsed_ms < 5000, `elapsed ${r.elapsed_ms}`);
    assert.strictEqual(r.old_pid, first.pid);
    assert.strictEqual(armed, true, 'the relaunch was held, so the call returned before it finished');
    release();
    assert.ok(await until(() => m._worker('w1').state === 'running' && m._worker('w1').pid !== first.pid, 20000), 'the relaunch carried on');
    const w = await m.wait({ worker_ids: ['w1'], timeout_ms: 20000 });
    assert.strictEqual(w.timed_out, false, JSON.stringify(w));
    assert.strictEqual(w.event, 'turn_end', JSON.stringify(w));
  } finally {
    seam.ends = null;
    if (release) release();
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(data);
  }
});

test('restart with a budget: a first turn that does not end inside what is left returns not ready yet, and worker_wait gets the turn when it ends', async () => {
  const { data, worktree, m } = setup('belay-restart-early-b-');
  const gate = fwd(path.join(data, 'answer.gate'));
  const prev = process.env.FAKE_ANSWER_GATE_FILE;
  try {
    fs.writeFileSync(gate, 'open'); process.env.FAKE_ANSWER_GATE_FILE = gate;
    await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    fs.unlinkSync(gate); // the relaunched worker's answer is now held until the file exists
    seam.leftMs = 300; // the relaunch finished; this much of the budget is left for the first turn, whatever the stop cost
    const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 60000, mcp_budget_ms: 6000 });
    assert.strictEqual(r.first_turn_awaited, false, JSON.stringify(r));
    assert.strictEqual(r.status, 'not ready yet');
    assert.strictEqual(r.restart_path, 'early_return');
    assert.ok(r.new_pid && r.worker.state === 'running', `the relaunch itself had finished: ${JSON.stringify(r.worker)}`);
    fs.writeFileSync(gate, 'open');
    const w = await m.wait({ worker_ids: ['w1'], timeout_ms: 20000 });
    assert.strictEqual(w.event, 'turn_end', JSON.stringify(w));
  } finally {
    seam.leftMs = null;
    if (prev === undefined) delete process.env.FAKE_ANSWER_GATE_FILE; else process.env.FAKE_ANSWER_GATE_FILE = prev;
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(data);
  }
});

test('restart: the fast path still awaits the first turn and says so, with or without a budget', async () => {
  const { data, worktree, m } = setup('belay-restart-early-c-');
  try {
    await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const a = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000, mcp_budget_ms: 100000 });
    assert.strictEqual(a.first_turn_awaited, true, JSON.stringify(a));
    assert.strictEqual(a.restart_path, 'awaited');
    assert.strictEqual(a.status, undefined);
    assert.strictEqual(a.first_turn_ended_by, 'turn');
    assert.ok(Number.isInteger(a.elapsed_ms));
    const b = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000 });
    assert.strictEqual(b.first_turn_awaited, true);
    assert.strictEqual(b.restart_path, 'awaited');
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(data);
  }
});

// The budget can end before launch(): during the old life's stop, its kill snapshot or the index embed. The record is then still
// the old life, which has already settled, so a wait must not answer that stop as this worker's end.
function holdOldStop(core, oldPid, fail) {
  let release = null; let armed = false;
  const held = new Promise((res) => { release = res; });
  const write = core.worker.write.bind(core.worker);
  core.worker.write = async (row) => {
    if (!armed && row.pid === oldPid && (row.state === 'stopping' || row.state === 'stopped')) {
      armed = true; await held;
      if (fail) throw Object.assign(new Error('the stop row could not be written'), { code: 'E_SUBSTRATE' });
    }
    return write(row);
  };
  return { release: () => release(), armed: () => armed };
}

test('restart: a budget that ends before launch() leaves a worker_wait that waits for the relaunch, never answers the old life\'s stop', async () => {
  const { data, worktree, core, m } = setup('belay-restart-early-d-');
  let hold = null;
  try {
    const first = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    hold = holdOldStop(core, first.pid, false);
    const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000, mcp_budget_ms: 1500 });
    assert.strictEqual(r.restart_path, 'early_return', JSON.stringify(r));
    assert.strictEqual(r.relaunch_in_flight, true);
    assert.strictEqual(hold.armed(), true, 'the old life\'s stop was still being written when the budget ended');
    const waiting = m.wait({ worker_ids: ['w1'], timeout_ms: 30000 });
    hold.release();
    const w = await waiting;
    assert.strictEqual(w.timed_out, false, JSON.stringify(w));
    assert.notStrictEqual(w.event, 'stopped', `the old life's stop was answered: ${JSON.stringify(w)}`);
    assert.strictEqual(w.event, 'turn_end', JSON.stringify(w));
    assert.notStrictEqual(m._worker('w1').pid, first.pid, 'the answer is the new life\'s turn');
  } finally {
    if (hold) hold.release();
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(data);
  }
});

test('restart: when the relaunch that outlived the budget fails, worker_wait answers that failure, not the old life\'s stop', async () => {
  const { data, worktree, core, m } = setup('belay-restart-early-e-');
  let hold = null;
  try {
    const first = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    hold = holdOldStop(core, first.pid, true);
    const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000, mcp_budget_ms: 1500 });
    assert.strictEqual(r.restart_path, 'early_return', JSON.stringify(r));
    const waiting = m.wait({ worker_ids: ['w1'], timeout_ms: 30000 });
    hold.release();
    const w = await waiting;
    assert.strictEqual(w.event, 'restart_failed', JSON.stringify(w));
    assert.match(w.established_by, /the relaunch failed: the stop row could not be written/);
    assert.strictEqual(w.error_code, 'E_SUBSTRATE');
  } finally {
    if (hold) hold.release();
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(data);
  }
});

test('worker_wait over several workers answers one that has already finished while another is still relaunching', async () => {
  const { data, worktree, core, m } = setup('belay-restart-early-f-');
  let hold = null;
  try {
    const w1 = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
    await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w2' });
    await m._waitTurn('w1', 8000); await m._waitTurn('w2', 8000);
    hold = holdOldStop(core, w1.pid, false);
    const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000, mcp_budget_ms: 1500 });
    assert.strictEqual(r.relaunch_in_flight, true, JSON.stringify(r));
    const w = await m.wait({ worker_ids: ['w1', 'w2'], timeout_ms: 30000 });
    assert.strictEqual(w.worker_id, 'w2', `the finished worker is answered while w1 still relaunches: ${JSON.stringify(w)}`);
    assert.strictEqual(w.already, true);
    assert.strictEqual(hold.armed(), true);
    hold.release();
    const after = await m.wait({ worker_ids: ['w1'], timeout_ms: 30000 });
    assert.strictEqual(after.event, 'turn_end', JSON.stringify(after));
  } finally {
    if (hold) hold.release();
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(data);
  }
});

test('worker_wait names the worker whose relaunch failed, not the first one relaunching', async () => {
  const { data, worktree, core, m } = setup('belay-restart-early-g-');
  let hold1 = null; let hold2 = null;
  try {
    const w2 = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w2' });
    const w1 = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000); await m._waitTurn('w2', 8000);
    hold2 = holdOldStop(core, w2.pid, false); // w2's relaunch is listed first and does not fail
    hold1 = holdOldStop(core, w1.pid, true);  // w1's relaunch fails
    const r2 = await m.restart({ worker_id: 'w2', first_turn_timeout_ms: 20000, mcp_budget_ms: 1500 });
    const r1 = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 20000, mcp_budget_ms: 1500 });
    assert.strictEqual(r2.relaunch_in_flight && r1.relaunch_in_flight, true);
    const waiting = m.wait({ worker_ids: ['w2', 'w1'], timeout_ms: 30000 });
    hold1.release();
    const w = await waiting;
    assert.strictEqual(w.event, 'restart_failed', JSON.stringify(w));
    assert.strictEqual(w.worker_id, 'w1', JSON.stringify(w));
    hold2.release();
  } finally {
    if (hold1) hold1.release();
    if (hold2) hold2.release();
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(data);
  }
});
