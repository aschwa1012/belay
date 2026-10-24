'use strict';
// release-eval.test.cjs — ADR 0058 decision 5: a worker that releases its task with a hand-back has it evaluated by the run
// manager before its turn's row is written; worker_wait and the turn_end wake carry the result as facts. Real core, real run
// manager, the fake Claude Code substrate held mid-turn by a gate file while the test releases the lease as the worker would.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const RE = require('../../src/run/release-eval.cjs');
const { wakeText } = require('../../src/run/wake.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const RUN = 'release-eval-run';
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const FAIL = { commands: [{ argv: [process.execPath, '-e', 'process.exit(3)'], timeout_ms: 20000 }] };

async function releasedTurn(acceptance, result, { stopIdleOnDone = false } = {}) {
  const dir = sandbox();
  const gate = path.join(dir, 'gate').split(path.sep).join('/');
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const saved = process.env.FAKE_ANSWER_GATE_FILE;
  process.env.FAKE_ANSWER_GATE_FILE = gate;
  let worker = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const task = await core.task.create({ spec: 'do it', acceptance, files_owned: [] });
    const wt = path.join(dir, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    const m = createRunManager({ core: core.harness(), dataDir: dir, runId: RUN, stopIdleOnDone, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    try {
      await m.spawn({ substrate: 'claude-code', worktree: wt.split(path.sep).join('/'), prompt: 'one', worker_id: 'w1', task_id: task.id });
      const lease = (await core.task.get({ task_id: task.id })).lease;
      worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1', run_id: RUN }), embed: false });
      await worker.lease.release({ lease_id: lease.id, reason: 'done', ...(result ? { result } : {}) });
      fs.writeFileSync(gate, 'go'); // the turn ends only now, after the release
      const waited = await m.wait({ worker_ids: ['w1'], timeout_ms: 30000 });
      const row = await core.task.get({ task_id: task.id });
      const events = await RE.enrichWakes(core, RUN, [{ worker_id: 'w1', event: 'turn_end', turn: 1 }], new Map());
      const again = await RE.enrichWakes(core, RUN, [{ worker_id: 'w1', event: 'turn_end', turn: 2 }], new Map([[task.id, row.results && row.results.evaluated_at]]));
      // ADR 0058 decision 8: with the lever on, a done task's idle worker is stopped once its turn's row is written.
      const w = m._worker('w1');
      const exited = stopIdleOnDone ? await m._waitExit('w1', 20000) : null;
      await w.idleStopping; // the stop's own receipt
      return { waited, row, wake: wakeText(events[0]), again: again[0], exited, idleStop: w.idleStop || null, state: w.state };
    } finally { try { await m.shutdown(); } catch { /* best effort */ } }
  } finally {
    if (saved === undefined) delete process.env.FAKE_ANSWER_GATE_FILE; else process.env.FAKE_ANSWER_GATE_FILE = saved;
    if (worker) await worker.close();
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
}

test('a hand-back whose checks pass is evaluated at release: done, worker_wait and the wake say so', { timeout: 90000 }, async () => {
  const { waited, row, wake, again } = await releasedTurn(PASS, { branch: 'b', head: 'h' });
  assert.strictEqual(row.state, 'done');
  assert.strictEqual(row.results.trigger, 'release');
  assert.deepStrictEqual(waited.evaluated, [{ task_id: row.id, state: 'done', passed: true, executable: true, checks: 1, failing: [] }]);
  assert.match(wake, new RegExp(`task ${row.id} evaluated at release: passed, done\\.`));
  assert.ok(Buffer.byteLength(wake, 'utf8') <= 400, `the wake is ${Buffer.byteLength(wake, 'utf8')} bytes`);
  assert.strictEqual(again.evaluated, undefined, 'an evaluation is carried by one wake only');
});

test('a hand-back whose checks fail is evaluated and stays released, naming the failing check; no hand-back, no evaluation', { timeout: 90000 }, async () => {
  const { waited, row, wake } = await releasedTurn(FAIL, { branch: 'b' });
  assert.deepStrictEqual([row.state, row.results.passed, row.results.trigger], ['released', false, 'release']);
  assert.deepStrictEqual(waited.evaluated[0].failing, [`command ${process.execPath} -e process.exit(3) exit 3`]);
  assert.match(wake, /evaluated at release: not done; failing: command /);
  assert.ok(Buffer.byteLength(wake, 'utf8') <= 400, `the wake is ${Buffer.byteLength(wake, 'utf8')} bytes`);
  const none = await releasedTurn(PASS, null);
  assert.deepStrictEqual([none.row.state, none.row.results, none.waited.evaluated], ['released', null, undefined], 'a release with no result is the orchestrator\'s to evaluate');
});

test('the wake clause is cut to its bound', () => {
  const evs = Array.from({ length: 6 }, (_, i) => ({ task_id: `t-${'x'.repeat(30)}-${i}`, state: 'released', failing: ['command npm test exit 1', 'files_within_owned'] }));
  const c = RE.clause(evs);
  assert.ok(Buffer.byteLength(c, 'utf8') <= RE.CLAUSE_MAX);
  assert.match(c, /\.\.\.$/);
});

test('stop_idle_on_done: a worker whose released task is evaluated done is stopped gracefully once idle; a failing one is left running', { timeout: 120000 }, async () => {
  const done = await releasedTurn(PASS, { branch: 'b' }, { stopIdleOnDone: true });
  assert.strictEqual(done.waited.evaluated[0].stop_idle_on_done, true);
  assert.ok(done.exited, 'the worker process exited');
  assert.deepStrictEqual([done.idleStop.stopped, done.idleStop.by, done.idleStop.receipt.graceful, done.state], [true, 'stop_idle_on_done', true, 'stopped']);
  const failed = await releasedTurn(FAIL, { branch: 'b' }, { stopIdleOnDone: true });
  assert.deepStrictEqual([failed.idleStop, failed.waited.evaluated[0].stop_idle_on_done, failed.state], [null, undefined, 'running']);
  const off = await releasedTurn(PASS, { branch: 'b' });
  assert.deepStrictEqual([off.idleStop, off.state], [null, 'running'], 'the lever is off by default');
});

test('stop_idle_on_done: the spec lever is a boolean, absent unless on, and reaches the orchestrator adapter argv', () => {
  const { parseLevers } = require('../../src/cli/run-levers.cjs');
  assert.strictEqual(parseLevers({ stop_idle_on_done: true }).stop_idle_on_done, true);
  assert.ok(!('stop_idle_on_done' in parseLevers({})));
  assert.ok(!('stop_idle_on_done' in parseLevers({ stop_idle_on_done: false })));
  assert.match(parseLevers({ stop_idle_on_done: 'yes' }).error, /stop_idle_on_done must be true or false/);
  const L = require('../../src/run/launch.cjs');
  const args = (on) => L.orchestratorMcpConfig({ runId: 'r', dataDir: 'C:/d', mcpPath: 'm.cjs', stopIdleOnDone: on }).mcpServers.belay.args;
  assert.ok(args(true).includes('--stop-idle-on-done'));
  assert.ok(!args(false).includes('--stop-idle-on-done'));
});
