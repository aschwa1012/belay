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
  try {
    const first = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    // The injected slow step: the relaunch's first row is held until the test releases it, as a slow stop would hold it.
    let release = null;
    const held = new Promise((res) => { release = res; });
    const write = core.worker.write.bind(core.worker);
    let armed = false;
    core.worker.write = async (row) => {
      if (!armed && row.state === 'starting' && row.pid && row.pid !== first.pid) { armed = true; await held; }
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
    const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 60000, mcp_budget_ms: 6000 });
    assert.strictEqual(r.first_turn_awaited, false, JSON.stringify(r));
    assert.strictEqual(r.status, 'not ready yet');
    assert.strictEqual(r.restart_path, 'early_return');
    assert.ok(r.new_pid && r.worker.state === 'running', `the relaunch itself had finished: ${JSON.stringify(r.worker)}`);
    fs.writeFileSync(gate, 'open');
    const w = await m.wait({ worker_ids: ['w1'], timeout_ms: 20000 });
    assert.strictEqual(w.event, 'turn_end', JSON.stringify(w));
  } finally {
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
