'use strict';
// release-eval.test.cjs — ADR 0058 decision 5: a worker that releases its task with a hand-back has it evaluated by the run
// manager once its turn's row is written, detached from the worker's queue; worker_wait and the wakes carry the result as facts,
// and a lifecycle operation cancels an evaluation in flight without waiting on its commands. Real core, real run manager, the fake
// Claude Code substrate held mid-turn by a gate file while the test releases the lease as the worker would.

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

// Waits for a condition the run manager sets, with a bound; never a fixed sleep.
async function until(fn, ms = 30000) {
  for (const end = Date.now() + ms; ;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// One turn in which the worker releases its task, then `during(m, w, ctx)` while the evaluation runs. Returns what was seen.
async function releasedTurn(acceptance, result, { stopIdleOnDone = false, during = null } = {}) {
  const dir = sandbox();
  const gate = path.join(dir, 'gate').split(path.sep).join('/');
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const saved = process.env.FAKE_ANSWER_GATE_FILE;
  process.env.FAKE_ANSWER_GATE_FILE = gate;
  let worker = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const task = await core.task.create({ spec: 'do it', acceptance: typeof acceptance === 'function' ? acceptance(dir) : acceptance, files_owned: [] });
    const wt = path.join(dir, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    const m = createRunManager({ core: core.harness(), dataDir: dir, runId: RUN, stopIdleOnDone, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    try {
      await m.spawn({ substrate: 'claude-code', worktree: wt.split(path.sep).join('/'), prompt: 'one', worker_id: 'w1', task_id: task.id });
      const lease = (await core.task.get({ task_id: task.id })).lease;
      worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1', run_id: RUN }), embed: false });
      await worker.lease.release({ lease_id: lease.id, reason: 'done', ...(result ? { result } : {}) });
      fs.writeFileSync(gate, 'go'); // the turn ends only now, after the release
      const atTurnEnd = await m.wait({ worker_ids: ['w1'], timeout_ms: 30000 });
      const w = m._worker('w1');
      const ev = await until(() => w.lastEvaluation); // started once the turn's row is written
      const wakeAtTurnEnd = wakeText((await RE.enrichWakes(core, RUN, [{ worker_id: 'w1', event: 'turn_end', turn: 1 }], new Map()))[0]);
      const seen = new Map();
      await RE.enrichWakes(core, RUN, [{ worker_id: 'w1', event: 'turn_end', turn: 1 }], seen); // the poll that saw the turn end
      const extra = during ? await during(m, w, dir) : null;
      const out = await ev.promise;
      const followUp = (await RE.enrichWakes(core, RUN, [], seen)).filter((e) => e.event === 'evaluated'); // a later poll
      const waited = await m.wait({ worker_ids: ['w1'], timeout_ms: 5000 }); // already: the turn ended, its evaluation landed
      const row = await core.task.get({ task_id: task.id });
      const exited = stopIdleOnDone ? await m._waitExit('w1', 20000) : null;
      await w.idleStopping; // the stop's own receipt
      return { atTurnEnd, out, waited, row, wakeAtTurnEnd, followUp, extra, exited, idleStop: w.idleStop || null, state: w.state };
    } finally { try { await m.shutdown(); } catch { /* best effort */ } }
  } finally {
    if (saved === undefined) delete process.env.FAKE_ANSWER_GATE_FILE; else process.env.FAKE_ANSWER_GATE_FILE = saved;
    if (worker) await worker.close();
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
}

test('a hand-back whose checks pass is evaluated after the turn, off its queue: done, and worker_wait and one wake say so', { timeout: 90000 }, async () => {
  const r = await releasedTurn(PASS, { branch: 'b', head: 'h' });
  assert.strictEqual(r.atTurnEnd.evaluated, undefined, 'the turn ended before its evaluation: worker_wait is not held for it');
  assert.deepStrictEqual([r.row.state, r.row.results.trigger], ['done', 'release']);
  assert.deepStrictEqual(r.waited.evaluated, [{ task_id: r.row.id, state: 'done', passed: true, executable: true, checks: 1, failing: [] }]);
  const all = [r.wakeAtTurnEnd, ...r.followUp.map((e) => e.text)].join('\n');
  assert.strictEqual((all.match(new RegExp(`task ${r.row.id} evaluated at release: passed, done`, 'g')) || []).length >= 1, true, all);
  for (const t of [r.wakeAtTurnEnd, ...r.followUp.map((e) => e.text)]) assert.ok(Buffer.byteLength(t, 'utf8') <= RE.WAKE_TEXT_MAX, `${Buffer.byteLength(t, 'utf8')} bytes: ${t}`);
});

test('a hand-back whose checks fail is evaluated and stays released, naming the failing check; no hand-back, no evaluation', { timeout: 90000 }, async () => {
  const r = await releasedTurn(FAIL, { branch: 'b' });
  assert.deepStrictEqual([r.row.state, r.row.results.passed, r.row.results.trigger], ['released', false, 'release']);
  assert.deepStrictEqual(r.waited.evaluated[0].failing, [`command ${process.execPath} -e process.exit(3) exit 3`]);
  const none = await releasedTurn(PASS, null);
  assert.deepStrictEqual([none.row.state, none.row.results, none.out, none.waited.evaluated], ['released', null, null, undefined], 'a release with no result is the orchestrator\'s to evaluate');
});

test('a stop during the evaluation does not wait for its command: the command is killed by its handle and nothing is written', { timeout: 120000 }, async () => {
  const slow = (dir) => {
    const pidFile = path.join(dir, 'cmd.pid').split(path.sep).join('/');
    return { commands: [{ argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000)`], timeout_ms: 300000 }] };
  };
  const r = await releasedTurn(slow, { branch: 'b' }, {
    during: async (m, w, dir) => {
      const pidFile = path.join(dir, 'cmd.pid');
      const pid = Number(await until(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : null)));
      const t0 = Date.now();
      const stopped = await m.stop({ worker_id: 'w1', mode: 'graceful' });
      const stopMs = Date.now() - t0;
      await until(() => !pidAlive(pid), 15000);
      return { pid, stopMs, stopped };
    },
  });
  assert.ok(r.extra.stopMs < 20000, `the stop took ${r.extra.stopMs} ms: it waited on the command`);
  assert.strictEqual(r.extra.stopped.graceful, true);
  assert.strictEqual(pidAlive(r.extra.pid), false, 'the acceptance command was killed');
  assert.deepStrictEqual(r.out.map((e) => [e.task_id, !!e.cancelled]), [[r.row.id, true]]);
  assert.match(String(r.out[0].by), /stop of worker w1/);
  assert.deepStrictEqual([r.row.state, r.row.results], ['released', null], 'a cancelled evaluation writes nothing');
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
