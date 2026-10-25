'use strict';
// relaunch-drain.test.cjs — ADR 0026 amendment 2 decisions 4 and 6: a relaunch (a restart, a Codex turn) of a worker whose old life
// dies while the relaunch is under way runs on the lease it asked about. Before, a dead row landing after task.ensureHold answered
// `run_live` released the lease and opened the task, and the worker ran on with no lease and nothing saying so. The relaunch now
// marks the record from its start until launch(), and a death written meanwhile keeps its lease. A relaunch that fails releases it.
// Deterministic seams, no sleeps: the death is caused (by the exact pid) at a chosen await, and its row is held by a gate that
// opens at a chosen point. Real core, real run manager, the fake substrates.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKES = path.join(__dirname, 'fakes').split(path.sep).join('/');
const RUN = 'relaunch-drain';

// A run with worker w1 spawned on a task. `hooks.ask(ctx, ask)` wraps task.ensureHold; `hooks.before(ctx)` runs before the relaunch;
// `env` is set just before it. Returns the relaunch's answer (or error), the task after it, the lease before it, what ensureHold
// answered, and the current worker row's leases_released.
async function scenario(substrate, relaunch, hooks = {}, env = {}) {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const h = core.harness();
  const ensureHold = h.task.ensureHold.bind(h.task);
  const ctx = { answers: [] };
  h.task.ensureHold = async (a) => (hooks.ask ? hooks.ask(ctx, () => ensureHold(a)) : ensureHold(a)).then((r) => { ctx.answers.push(r.reason); return r; });
  const keys = ['FAKE_CODEX_HANG', ...Object.keys(env)];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const task = await core.task.create({ spec: 'do it', files_owned: ['src/a.js'] });
    const exe = `${FAKES}/${substrate === 'codex' ? 'fake-codex.cjs' : 'fake-claude.cjs'}`;
    m = ctx.m = createRunManager({ core: h, dataDir: dir, runId: RUN, paths: { claudeExe: exe, codexExe: exe, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    if (substrate === 'codex') process.env.FAKE_CODEX_HANG = '1'; // its turn never ends, so the kill is a death, not Codex's idle
    const row = await m.spawn({ substrate, worktree: wt.split(path.sep).join('/'), prompt: 'one', worker_id: 'w1', task_id: task.id });
    ctx.pid = row.pid;
    if (substrate === 'claude-code') await m.wait({ worker_ids: ['w1'], timeout_ms: 30000 });
    ctx.w = m._worker('w1');
    await ctx.w.queue;
    ctx.lease = (await core.task.get({ task_id: task.id })).lease;
    if (substrate === 'codex') delete process.env.FAKE_CODEX_HANG;
    if (hooks.before) await hooks.before(ctx);
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    let r = null, error = null;
    try { r = await relaunch(m); } catch (e) { error = e; }
    const t = await core.task.get({ task_id: task.id });
    const dead = (await core.worker.get({ worker_id: 'w1' })).leases_released;
    return { r, error, t, lease: ctx.lease, answers: ctx.answers, dead };
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
}

// The old life dies (by its exact pid) with its dead row queued behind a gate; the caller decides when the row may land.
async function killQueued(ctx) {
  let open; const gate = new Promise((res) => { open = res; });
  ctx.w.queue = ctx.w.queue.then(() => gate); // another write in flight: the death's row queues behind it
  process.kill(ctx.pid);
  assert.ok(await ctx.m._waitExit('w1', 30000), 'the exit event arrived');
  return open;
}

const restart = (m) => m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 });
const codexTurn = (m) => m.message({ worker_id: 'w1', text: 'again' });

// The relaunch ran on the lease it asked about: one ask, answered run_live, the same lease id, still held by w1, nothing released.
function keptLease({ r, error, t, lease, answers, dead }, channel) {
  assert.strictEqual(error, null, error && error.message);
  if (channel) assert.strictEqual(r.channel, channel);
  assert.deepStrictEqual(answers, ['run_live']);
  assert.strictEqual(r.lease, undefined, 'no lease was released, so there is nothing to report');
  assert.deepStrictEqual([t.state, t.lease && t.lease.id, t.lease && t.lease.holder], ['assigned', lease.id, 'w1']);
  assert.strictEqual(dead, null, 'the relaunched life has no released list');
}

for (const [name, substrate, go, channel] of [['a restart', 'claude-code', restart, null], ['a Codex turn', 'codex', codexTurn, 'codex-resume']]) {
  test(`${name} whose dead row is still queued when it starts drains it first and keeps the lease`, { timeout: 90000 }, async () => {
    keptLease(await scenario(substrate, go, { before: async (ctx) => { const open = await killQueued(ctx); setImmediate(open); } }), channel);
  });

  test(`${name} whose worker dies while ensureHold is asked keeps the lease the answer was about`, { timeout: 90000 }, async () => {
    keptLease(await scenario(substrate, go, { ask: async (ctx, ask) => { const open = await killQueued(ctx); const r = await ask(); open(); return r; } }), channel);
  });
}

test('a restart whose worker dies during its second drain keeps the lease too: no window is left before launch', { timeout: 90000 }, async () => {
  // As the checker's repro: after the answer, a write chained on the queue kills the worker; its dead row lands while the relaunch
  // waits on the queue a second time, behind the very promise it captured.
  keptLease(await scenario('claude-code', restart, { ask: async (ctx, ask) => {
    const r = await ask();
    let open; const gate = new Promise((g) => { open = g; });
    ctx.w.queue = ctx.w.queue.then(() => new Promise((res) => setImmediate(() => { process.kill(ctx.pid); ctx.m._waitExit('w1', 30000).then(() => setImmediate(open)); res(); }))).then(() => gate);
    return r;
  } }));
});

test('a relaunch that fails after a death it kept the lease for releases that lease, before and after launching', { timeout: 90000 }, async () => {
  // Before launch: the death lands kept, then the ask itself fails. The guard restates the dead row with release_leases.
  const before = await scenario('claude-code', restart, { ask: async (ctx) => {
    process.kill(ctx.pid);
    assert.ok(await ctx.m._waitExit('w1', 30000));
    await ctx.w.queue; // the dead row has landed, kept
    throw Object.assign(new Error('refused for the test'), { code: 'E_FILES_OVERLAP' });
  } });
  assert.strictEqual(before.error && before.error.code, 'E_FILES_OVERLAP');
  assert.deepStrictEqual([before.t.state, before.t.lease], ['open', null], 'released when the relaunch failed');
  assert.deepStrictEqual(before.dead, [{ lease_id: before.lease.id, task_id: before.t.id }]);

  // After launch: the relaunched process fails the ready gate (an extra tool on resume), and its own dead row releases as normal.
  const after = await scenario('claude-code', restart, { before: async (ctx) => { const open = await killQueued(ctx); setImmediate(open); } },
    { FAKE_SURFACE: 'extra-tool', FAKE_SURFACE_ON_RESUME: '1' });
  assert.ok(after.error, 'the relaunch failed');
  assert.deepStrictEqual([after.t.state, after.t.lease], ['open', null]);
  assert.deepStrictEqual(after.dead, [{ lease_id: after.lease.id, task_id: after.t.id }]);
});
