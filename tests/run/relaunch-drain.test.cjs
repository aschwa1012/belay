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
    m = ctx.m = createRunManager({ core: hooks.core ? hooks.core(h, ctx) : h, dataDir: dir, runId: RUN, paths: { claudeExe: exe, codexExe: exe, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
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

test('a restart granted its lease back, then refused before any process, releases that lease again', { timeout: 90000 }, async () => {
  // The death is recorded first (its lease released, the task open); the restart's ask grants the lease back; then the launch's
  // bind is refused, so no process starts. Before, the dead worker held the granted lease until its expiry.
  const failed = await scenario('claude-code', restart, {
    core: (h, ctx) => Object.defineProperty(Object.create(h), 'bindOpen', { value: async (...a) => { if (ctx.failBind) throw Object.assign(new Error('refused for the test'), { code: 'E_ARGS' }); return h.bindOpen(...a); } }),
    before: async (ctx) => {
      process.kill(ctx.pid);
      assert.ok(await ctx.m._waitExit('w1', 30000));
      await ctx.w.queue; // the death is recorded: the lease released, the task open
      ctx.failBind = true;
    },
  });
  assert.ok(failed.error, 'the restart failed');
  assert.deepStrictEqual(failed.answers, ['regranted']);
  assert.deepStrictEqual([failed.t.state, failed.t.lease], ['open', null], 'the granted-back lease is released with the failure');
  assert.deepStrictEqual(failed.dead, [{ lease_id: failed.lease.id, task_id: failed.t.id }]);
});

test('a relaunch that fails while its kept dead row is still in flight releases the lease once that row lands', { timeout: 90000 }, async () => {
  // The worker dies during the ask. Its dead row is built with keep_leases (the relaunch is under way) and its write reaches the
  // core, which holds it behind a gate; the ask then fails, and the gate opens only after the failure has been thrown. The row
  // lands kept after the catch ran, so the release must read the record's state after the queue, not before.
  const failed = await scenario('claude-code', restart, {
    core: (h, ctx) => {
      const worker = Object.assign({}, h.worker, { write: async (r) => { if (r.state === 'dead' && r.keep_leases && ctx.held) await ctx.held; return h.worker.write(r); } });
      return Object.defineProperty(Object.create(h), 'worker', { value: worker });
    },
    ask: async (ctx) => {
      let open; ctx.held = new Promise((res) => { open = res; });
      process.kill(ctx.pid); // the exact pid belay spawned
      assert.ok(await ctx.m._waitExit('w1', 30000), 'the exit event arrived');
      setImmediate(open); // the kept row lands after the failure has been thrown
      throw Object.assign(new Error('refused for the test'), { code: 'E_FILES_OVERLAP' });
    },
  });
  assert.strictEqual(failed.error && failed.error.code, 'E_FILES_OVERLAP');
  assert.deepStrictEqual([failed.t.state, failed.t.lease], ['open', null]);
  assert.deepStrictEqual(failed.dead, [{ lease_id: failed.lease.id, task_id: failed.t.id }]);
});

test('a resume that fails leaves the worker parked, and a parked worker keeps its lease', { timeout: 90000 }, async () => {
  const failed = await scenario('claude-code', (m) => m.resume({ worker_id: 'w1', by: 'operator:2' }), {
    before: async (ctx) => { await ctx.m.pause({ worker_id: 'w1', by: 'operator:1' }); },
    ask: async () => { throw Object.assign(new Error('refused for the test'), { code: 'E_FILES_OVERLAP' }); },
  });
  assert.strictEqual(failed.error && failed.error.code, 'E_FILES_OVERLAP');
  assert.deepStrictEqual([failed.t.state, failed.t.lease && failed.t.lease.id, failed.t.lease && failed.t.lease.holder], ['assigned', failed.lease.id, 'w1']);
});

test('overlapping relaunches of one record: the one that fails neither clears the other\'s flag nor releases its lease', async () => {
  // The checker's seam: A gets past its checks and waits to launch; B, overlapping, fails. Unit level, through the guard itself.
  const RG = require('../../src/run/relaunch-guard.cjs');
  const writes = [];
  const w = { id: 'c1', state: 'dead', queue: Promise.resolve(), launches: 1 };
  const writeRow = async (rec, state, opts = {}) => { writes.push({ state, opts }); return {}; };
  let goA; const aGate = new Promise((r) => { goA = r; });
  const A = RG.relaunching(w, writeRow, async () => { await aGate; w.launches += 1; return 'A launched'; });
  const tokenA = w.relaunching;
  const B = await RG.relaunching(w, writeRow, async () => { throw Object.assign(new Error('mid-turn'), { code: 'E_SUBSTRATE' }); }).catch((e) => e.code);
  assert.strictEqual(B, 'E_SUBSTRATE');
  assert.ok(w.relaunching != null, 'A still owns the window');
  await w.queue;
  assert.deepStrictEqual(writes, [], 'B released nothing: a relaunch was still in flight');
  assert.throws(() => RG.refuseIfRelaunching(w, 'message'), (e) => e.code === 'E_BUSY');
  goA();
  assert.strictEqual(await A, 'A launched');
  assert.strictEqual(w.relaunching, null, 'A cleared its own token');
  assert.notStrictEqual(tokenA, null);

  // A failure after another relaunch has launched restates nothing either: w.launches moved since it began.
  const w2 = { id: 'c2', state: 'dead', queue: Promise.resolve(), launches: 1 };
  let goC; const cGate = new Promise((r) => { goC = r; });
  const C = RG.relaunching(w2, writeRow, async () => { await cGate; throw new Error('late failure'); }).catch((e) => e.message);
  w2.relaunching = null; w2.launches += 1; // as if the window had been taken over and launched (the token check alone would pass)
  goC();
  assert.strictEqual(await C, 'late failure');
  await w2.queue;
  assert.deepStrictEqual(writes, [], 'no restate over a life launched since');
});

test('two concurrent messages to a dead Codex worker: one relaunches holding the lease, the other is refused E_BUSY', { timeout: 90000 }, async () => {
  const out = await scenario('codex', async (m) => {
    const a = m.message({ worker_id: 'w1', text: 'one' }).catch((e) => e);
    const b = m.message({ worker_id: 'w1', text: 'two' }).catch((e) => e);
    return Promise.all([a, b]);
  }, { before: async (ctx) => { process.kill(ctx.pid); assert.ok(await ctx.m._waitExit('w1', 30000)); await ctx.w.queue; } });
  const [a, b] = out.r;
  const ok = [a, b].filter((x) => x && x.channel === 'codex-resume');
  const busy = [a, b].filter((x) => x instanceof Error && x.code === 'E_BUSY');
  assert.deepStrictEqual([ok.length, busy.length], [1, 1], JSON.stringify([a && (a.code || a.channel), b && (b.code || b.channel)]));
  assert.deepStrictEqual(ok[0].lease, { task_id: out.t.id, lease_id: out.lease.id, regranted: true });
  assert.deepStrictEqual([out.t.state, out.t.lease && out.t.lease.id, out.t.lease && out.t.lease.holder], ['assigned', out.lease.id, 'w1'], 'the refused one released nothing');
});

test('a restart while a Codex message is relaunching the worker is refused E_BUSY, and the message keeps its lease', { timeout: 90000 }, async () => {
  let refused = null;
  const out = await scenario('codex', (m) => m.message({ worker_id: 'w1', text: 'again' }), {
    before: async (ctx) => { process.kill(ctx.pid); assert.ok(await ctx.m._waitExit('w1', 30000)); await ctx.w.queue; },
    ask: async (ctx, ask) => { refused = await ctx.m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 }).then(() => null, (e) => e); return ask(); },
  });
  assert.strictEqual(refused && refused.code, 'E_BUSY');
  assert.strictEqual(out.r.channel, 'codex-resume');
  assert.deepStrictEqual([out.t.state, out.t.lease && out.t.lease.id, out.t.lease && out.t.lease.holder], ['assigned', out.lease.id, 'w1']);
});
