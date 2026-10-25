'use strict';
// wait-eval.test.cjs — gap 9 of the second 0.3.1 try: after a turn ends with its hand-back being evaluated, a later worker_wait
// holds until that evaluation ends and answers with its result, instead of answering `already` at once; one that times out first
// says the evaluation is still running. Real core, real run manager, the fake Claude Code substrate; the evaluation's one acceptance
// command waits for a gate file the test writes, so nothing here is timed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const RUN = 'wait-eval-run';
const WAIT_FOR_FILE = "const fs = require('fs'); const f = process.argv[1]; const t = setInterval(() => { if (fs.existsSync(f)) { clearInterval(t); process.exit(0); } }, 20);";

test('a later worker_wait holds for the hand-back being evaluated and answers with its result; a timed-out one says still evaluating', { timeout: 90000 }, async () => {
  const dir = sandbox();
  const turnGate = path.join(dir, 'turn-gate').split(path.sep).join('/');
  const evalGate = path.join(dir, 'eval-gate').split(path.sep).join('/');
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const saved = process.env.FAKE_ANSWER_GATE_FILE;
  process.env.FAKE_ANSWER_GATE_FILE = turnGate;
  let worker = null, m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const acceptance = { commands: [{ argv: [process.execPath, '-e', WAIT_FOR_FILE, evalGate], timeout_ms: 60000 }] };
    const task = await core.task.create({ spec: 'do it', acceptance, files_owned: [] });
    const wt = path.join(dir, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    m = createRunManager({ core: core.harness(), dataDir: dir, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    await m.spawn({ substrate: 'claude-code', worktree: wt.split(path.sep).join('/'), prompt: 'one', worker_id: 'w1', task_id: task.id });
    const lease = (await core.task.get({ task_id: task.id })).lease;
    worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1', run_id: RUN }), embed: false });
    await worker.lease.release({ lease_id: lease.id, reason: 'done', result: { branch: 'b' } });
    fs.writeFileSync(turnGate, 'go'); // the turn ends only now, after the release

    const atEnd = await m.wait({ worker_ids: ['w1'], timeout_ms: 30000 });
    assert.deepStrictEqual([atEnd.event, atEnd.evaluating], ['turn_end', [task.id]], 'the turn\'s own answer comes at once and names the evaluation');

    const early = await m.wait({ worker_ids: ['w1'], timeout_ms: 300 }); // the evaluation's command is held by its gate
    assert.strictEqual(early.timed_out, true);
    assert.deepStrictEqual(early.still_evaluating, [{ worker_id: 'w1', turn: atEnd.turn, tasks: [task.id] }]);

    const later = m.wait({ worker_ids: ['w1'], timeout_ms: 30000 });
    fs.writeFileSync(evalGate, 'go'); // the acceptance command passes
    const got = await later;
    assert.deepStrictEqual([got.timed_out, got.already, got.event, got.turn], [false, true, 'turn_end', atEnd.turn]);
    assert.deepStrictEqual(got.evaluated, [{ task_id: task.id, state: 'done', passed: true, executable: true, checks: 1, failing: [] }]);
    assert.strictEqual(got.evaluating, undefined);

    const after = await m.wait({ worker_ids: ['w1'], timeout_ms: 5000 }); // nothing in flight now: at once, as before
    assert.deepStrictEqual([after.already, after.timed_out, after.evaluated && after.evaluated[0].state], [true, false, 'done']);
  } finally {
    if (saved === undefined) delete process.env.FAKE_ANSWER_GATE_FILE; else process.env.FAKE_ANSWER_GATE_FILE = saved;
    try { fs.writeFileSync(evalGate, 'go'); } catch { /* the sandbox is gone */ }
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    if (worker) await worker.close();
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
});

// The hold's own seams: a stub worker record whose evaluation is a promise the test settles, so every ordering below is forced.
const { createWait } = require('../../src/run/wait.cjs');

function deferred() { let res; const p = new Promise((r) => { res = r; }); return { p, res }; }
function held({ id = 'w1' } = {}) {
  const w = { id, turns: 1, turnEnded: true, settled: false, readyWaiters: [], turnWaiters: [], exitWaiters: [], queue: Promise.resolve(), launches: 1, state: 'running' };
  const d = deferred();
  const ev = { turn: 1, task_ids: ['T1'], next: 0, done: false, promise: null };
  ev.promise = d.p.then((out) => { ev.done = true; w.turnEvaluated = out; w.turnEvaluatedTurn = ev.turn; return out; }).finally(() => { if (w.evaluation === ev) w.evaluation = null; });
  w.evaluation = ev;
  return { w, end: d.res };
}
const waitFor = (w) => { const m = new Map([[w.id, w]]); return createWait({ workers: m, get: (id) => m.get(id) }); };
const settledTick = () => new Promise((r) => setImmediate(r));
// Resolves with the wait's answer if it has come by the time the event loop has turned twice, else with the marker.
async function answeredNow(p) { const NONE = Symbol('none'); let got = NONE; p.then((v) => { got = v; }); await settledTick(); await settledTick(); return got === NONE ? null : got; }

test('a worker that dies during the hold is answered as its death while the evaluation still runs', { timeout: 20000 }, async () => {
  const { w, end } = held();
  const p = waitFor(w)({ worker_ids: ['w1'], timeout_ms: 10000 });
  await settledTick();
  Object.assign(w, { settled: true, settledState: 'dead', exitCode: 1, deathEstablishedBy: 'exit event' });
  for (const r of w.exitWaiters.splice(0)) r({ code: 1 });
  const early = await answeredNow(p);
  end([{ task_id: 'T1', state: 'done' }]);
  const got = await p;
  assert.ok(early, 'the death is not held for the evaluation');
  assert.deepStrictEqual([got.event, got.exit_code, got.already], ['dead', 1, undefined]);
});

test('a turn begun during the hold is not answered as the old turn, and one that ends is answered', { timeout: 20000 }, async () => {
  const { w, end } = held();
  const p = waitFor(w)({ worker_ids: ['w1'], timeout_ms: 10000 });
  await settledTick();
  w.turnEnded = false; // a message began turn 2
  end([{ task_id: 'T1', state: 'done' }]);
  assert.strictEqual(await answeredNow(p), null, 'the evaluation ending does not answer a worker mid-turn');
  w.turns = 2; w.turnEnded = true;
  for (const r of w.turnWaiters.splice(0)) r({ usage: null });
  const got = await p;
  assert.deepStrictEqual([got.event, got.turn, got.timed_out], ['turn_end', 2, false]);
});

test('a cancelled evaluation that never settles is not listed as still evaluating with no tasks', { timeout: 20000 }, async () => {
  const { w } = held();
  const p = waitFor(w)({ worker_ids: ['w1'], timeout_ms: 300 });
  await settledTick();
  w.evaluation = null; // cancelled by a lifecycle operation; its promise never settles
  const got = await p;
  assert.strictEqual(got.timed_out, true);
  assert.strictEqual(got.still_evaluating, undefined);
});
