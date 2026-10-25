'use strict';
// relaunch-drain.test.cjs — ADR 0026 amendment 2: a relaunch (a restart, a Codex turn) drains the worker's write queue before it
// asks the core about its lease. Before, ensureHold could answer `run_live` while the old life's dead row was still queued; the row
// then landed, released the lease and opened the task, and the worker ran on with no lease and nothing saying so. Seam, no sleeps:
// another write holds the queue behind a gate that opens on the first wait on the queue once armed (the drain), or when ensureHold
// has answered (the old order). Real core, real run manager, the fake substrates.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKES = path.join(__dirname, 'fakes').split(path.sep).join('/');
const RUN = 'relaunch-drain';

async function race(substrate, relaunch) {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: RUN }), embed: false });
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const spy = { armed: false, open: null };
  const opener = () => { if (spy.open) { const o = spy.open; spy.open = null; o(); } };
  class SpyPromise extends Promise { then(a, b) { if (spy.armed) opener(); return super.then(a, b); } }
  const h = core.harness();
  const ensureHold = h.task.ensureHold.bind(h.task);
  const answers = [];
  h.task.ensureHold = async (a) => { const r = await ensureHold(a); answers.push(r.reason); opener(); return r; };
  const savedHang = process.env.FAKE_CODEX_HANG;
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const task = await core.task.create({ spec: 'do it', files_owned: ['src/a.js'] });
    const exe = `${FAKES}/${substrate === 'codex' ? 'fake-codex.cjs' : 'fake-claude.cjs'}`;
    m = createRunManager({ core: h, dataDir: dir, runId: RUN, paths: { claudeExe: exe, codexExe: exe, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    if (substrate === 'codex') process.env.FAKE_CODEX_HANG = '1'; // its turn never ends, so the kill is a death, not Codex's idle
    const row = await m.spawn({ substrate, worktree: wt.split(path.sep).join('/'), prompt: 'one', worker_id: 'w1', task_id: task.id });
    if (substrate === 'claude-code') await m.wait({ worker_ids: ['w1'], timeout_ms: 30000 });
    const w = m._worker('w1');
    await w.queue;
    const lease = (await core.task.get({ task_id: task.id })).lease;
    const gate = new SpyPromise((r) => { spy.open = r; });
    w.queue = SpyPromise.resolve(w.queue).then(() => gate); // another write in flight: the death's row queues behind it
    process.kill(row.pid); // the exact pid belay spawned
    assert.ok(await m._waitExit('w1', 30000), 'the exit event arrived');
    if (substrate === 'codex') delete process.env.FAKE_CODEX_HANG;
    spy.armed = true;
    const r = await relaunch(m);
    const t = await core.task.get({ task_id: task.id });
    return { r, t, lease, answers };
  } finally {
    if (savedHang === undefined) delete process.env.FAKE_CODEX_HANG; else process.env.FAKE_CODEX_HANG = savedHang;
    if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
}

test('a restart drains the dead row before it asks for the lease, so the worker relaunches holding its lease and says so', { timeout: 90000 }, async () => {
  const { r, t, lease, answers } = await race('claude-code', (m) => m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 }));
  assert.deepStrictEqual(answers, ['regranted'], 'ensureHold saw the death the queue held');
  assert.deepStrictEqual(r.lease, { task_id: t.id, lease_id: lease.id, regranted: true });
  assert.deepStrictEqual([t.state, t.lease && t.lease.id, t.lease && t.lease.holder], ['assigned', lease.id, 'w1']);
});

test('a Codex turn after a death drains the dead row the same way before it asks for the lease', { timeout: 90000 }, async () => {
  const { r, t, lease, answers } = await race('codex', (m) => m.message({ worker_id: 'w1', text: 'again' }));
  assert.strictEqual(r.channel, 'codex-resume');
  assert.deepStrictEqual(answers, ['regranted']);
  assert.deepStrictEqual(r.lease, { task_id: t.id, lease_id: lease.id, regranted: true });
  assert.deepStrictEqual([t.state, t.lease && t.lease.id, t.lease && t.lease.holder], ['assigned', lease.id, 'w1']);
});
