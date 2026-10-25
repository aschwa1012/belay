'use strict';
// lease-holder-dead.test.cjs — ADR 0026 amendment 1 (proposed), through the run manager: a worker killed by its exact pid while
// it holds a lease gives the lease up in its death handling, its task can be assigned to another worker at once, and the death
// wake says which lease it released. A death a restart settles on its way to relaunching keeps the lease. Real core, real run
// manager, the fake Claude Code substrate.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createWriteRow } = require('../../src/run/write-row.cjs');
const { diffWorkers, wakeText } = require('../../src/run/wake.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const RUN = 'lease-dead-run';
const fwd = (p) => p.split(path.sep).join('/');

test('a worker killed by its exact pid releases its lease in its death handling, and the task is assignable at once', { timeout: 90000 }, async () => {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const task = await core.task.create({ spec: 'do it', files_owned: ['src/a.js'] });
    m = createRunManager({ core: core.harness(), dataDir: dir, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    const row = await m.spawn({ substrate: 'claude-code', worktree: fwd(wt), prompt: 'one', worker_id: 'w1', task_id: task.id });
    const lease = (await core.task.get({ task_id: task.id })).lease;
    assert.strictEqual(lease.holder, 'w1');
    const baseline = diffWorkers({ prev: {}, rows: (await core.worker.list({})).workers, runId: RUN, nowMs: 0, graceMs: 0 }).next;

    process.kill(row.pid); // the exact pid belay spawned and recorded
    const exited = await m._waitExit('w1', 30000);
    assert.ok(exited, 'the exit event arrived');
    await m._worker('w1').queue; // the dead row's write

    const w = await core.worker.get({ worker_id: 'w1' });
    assert.deepStrictEqual([w.state, w.leases_released], ['dead', [{ lease_id: lease.id, task_id: task.id }]]);
    const t = await core.task.get({ task_id: task.id });
    assert.deepStrictEqual([t.state, t.lease], ['open', null], 'released by the death, not by an expiry 10 minutes later');

    const second = await m.spawn({ substrate: 'claude-code', worktree: fwd(wt), prompt: 'two', worker_id: 'w2', task_id: task.id });
    assert.strictEqual(second.state, 'running');
    assert.strictEqual((await core.task.get({ task_id: task.id })).lease.holder, 'w2');

    const { events } = diffWorkers({ prev: baseline, rows: (await core.worker.list({})).workers, runId: RUN, nowMs: 1, graceMs: 0 });
    const death = events.find((e) => e.worker_id === 'w1' && e.event === 'death');
    const text = wakeText(death);
    assert.match(text, new RegExp(`Released (lease ${lease.id} on task ${task.id}|its lease on task ${task.id})`), text);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 221, `${Buffer.byteLength(text, 'utf8')} bytes: ${text}`);
  } finally {
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
});

test('the dead row a restart settles on its way to relaunching asks the core to keep the lease; any other dead row does not', async () => {
  const sent = [];
  const ctx = { runId: 'r', adapterPid: process.pid, core: { worker: { write: async (r) => { sent.push(r); return { ...r, seq: sent.length }; } } } };
  const writeRow = createWriteRow(ctx, {});
  const w = (by) => ({ id: 'w', substrate: 'claude-code', pid: null, settled: true, headSha: 'x', deathEstablishedBy: by, queue: Promise.resolve(), turns: 0 });
  await writeRow(w('pid-check-on-restart'), 'dead');
  await writeRow(w('pid-check-on-restart+exit-event'), 'dead');
  await writeRow(w('exit-event'), 'dead');
  await writeRow(w('pid-check-on-restart'), 'stopped');
  assert.deepStrictEqual(sent.map((r) => r.keep_leases === true), [true, true, false, false]);
});

// One real core and run manager with worker w1 spawned on a task; `body(ctx)` runs, and everything is torn down after.
async function withRun(acceptance, body) {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  let m = null; const extra = [];
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const task = await core.task.create({ spec: 'do it', files_owned: ['src/a.js'], ...(acceptance ? { acceptance } : {}) });
    m = createRunManager({ core: core.harness(), dataDir: dir, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    const spawn = (id, task_id) => m.spawn({ substrate: 'claude-code', worktree: fwd(wt), prompt: 'one', worker_id: id, task_id });
    const row = await spawn('w1', task.id);
    const lease = (await core.task.get({ task_id: task.id })).lease;
    const kill = async () => { process.kill(row.pid); assert.ok(await m._waitExit('w1', 30000)); await m._worker('w1').queue; };
    const workerCore = async (id) => { const c = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: id, run_id: RUN }), embed: false }); extra.push(c); return c; };
    return await body({ core, m, task, lease, kill, spawn, workerCore, dir });
  } finally {
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    for (const c of extra) await c.close();
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
}

async function until(fn, ms = 30000) {
  for (const end = Date.now() + ms; ;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a hand-back that lands after the dead row is accepted and evaluated at release, though no turn of the worker ends', { timeout: 90000 }, async () => {
  const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
  await withRun(PASS, async ({ core, m, task, lease, kill, workerCore }) => {
    await kill(); // the dead row first; the worker's adapter, still alive for a moment, sends the hand-back after it
    const out = await (await workerCore('w1')).lease.release({ lease_id: lease.id, result: { branch: 'b' } });
    assert.deepStrictEqual([out.state, out.lease_released_by], ['released', 'holder_dead']);
    const ev = await until(() => m._worker('w1').lastEvaluation); // started by the pid poll's late look, not by a turn end
    await ev.promise;
    const row = await core.task.get({ task_id: task.id });
    assert.deepStrictEqual([row.state, row.results.trigger], ['done', 'release']);
  });
});

test('a restart after a recorded death gets the lease back while the task is open, and the receipt says so', { timeout: 90000 }, async () => {
  await withRun(null, async ({ core, m, task, lease, kill }) => {
    await kill();
    assert.strictEqual((await core.task.get({ task_id: task.id })).state, 'open');
    const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 });
    assert.deepStrictEqual(r.lease, { task_id: task.id, lease_id: lease.id, regranted: true });
    const t = await core.task.get({ task_id: task.id });
    assert.deepStrictEqual([t.state, t.lease.id, t.lease.holder], ['assigned', lease.id, 'w1']);
  });
});

test('a restart after the task went to another worker goes ahead holding no lease, and its first text says so', { timeout: 90000 }, async () => {
  await withRun(null, async ({ core, m, task, lease, kill, spawn, dir }) => {
    await kill();
    await spawn('w2', task.id); // the orchestrator gave the task to another worker
    const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 });
    assert.deepStrictEqual([r.lease.regranted, r.lease.lease_id, r.lease.task_state, r.lease.current_holder], [false, lease.id, 'assigned', 'worker w2']);
    assert.strictEqual((await core.task.get({ task_id: task.id })).lease.holder, 'w2', 'one live holder');
    const stream = fs.readFileSync(path.join(dir, 'workers', 'w1', 'stream.jsonl'), 'utf8');
    assert.match(stream, /You hold no lease on it: do not hand it back/);
  });
});

test('a death wake that released leases keeps its clause and its pointer under the interactive cap', () => {
  const id = '0f8b1c2e-1111-4222-8333-444455556666';
  const ev = (by, n) => ({ event: 'death', worker_id: 'coder-1', turn: 3, exit_code: 1, exit_signal: null, death_established_by: by, leases_released: Array.from({ length: n }, () => ({ lease_id: id, task_id: id })) });
  const long = 'run.end: pid 12345 not alive when the run ended; no adapter wrote its exit (ADR 0029)';
  for (const [by, n, want] of [['exit-event', 1, /Released its lease on task /], ['exit-event', 3, /Released 3 leases; open unless a hand-back lands\./], [long, 1, /Released its lease on task 0f8b1c2e-1111-4222-8333-444455556666; open unless its hand-back lands\./]]) {
    const text = wakeText(ev(by, n));
    assert.ok(Buffer.byteLength(text, 'utf8') <= 221, `${Buffer.byteLength(text, 'utf8')} bytes: ${text}`);
    assert.match(text, want);
    assert.match(text, /Its rows are in the store: task_list, briefing\.$/);
  }
  assert.ok(!wakeText(ev(long, 1)).includes('established by'), 'the long head gives way, the pointer stays');
});

test('a relaunch while the late look is reading the tasks starts no evaluation for the life that ended', async () => {
  const LH = require('../../src/run/late-handback.cjs');
  let answer;
  const listed = new Promise((r) => { answer = r; });
  const evaluated = [];
  const ctx = { runId: RUN, core: { task: {
    list: () => listed, // held: the look is in flight
    evaluate: async (a) => { evaluated.push(a.task_id); return { id: a.task_id, state: 'done', results: {} }; },
  } } };
  const released = { id: 't9', run_id: RUN, state: 'released', handoff: { by: 'w9', at: 1 }, results: null };
  const w = { id: 'w9', settled: true, settledState: 'dead', launches: 1, turns: 2, exitedAt: Date.now(), worktree: '/x' };
  LH.check(w, ctx);
  assert.strictEqual(w.lateHandback.busy, true, 'the look is in flight');
  w.settled = false; w.launches = 2; // a restart relaunched the worker meanwhile
  answer({ tasks: [released] });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual([evaluated, w.evaluation || null], [[], null], 'nothing evaluated for the life that ended');

  const w2 = { id: 'w9', settled: true, settledState: 'dead', launches: 1, turns: 2, exitedAt: Date.now(), worktree: '/x' };
  let answer2; const listed2 = new Promise((r) => { answer2 = r; });
  ctx.core.task.list = () => listed2;
  LH.check(w2, ctx);
  answer2({ tasks: [released] });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(w2.lastEvaluation, 'with no relaunch the same look starts the evaluation');
  await w2.lastEvaluation.promise;
  assert.deepStrictEqual(evaluated, ['t9']);
});
