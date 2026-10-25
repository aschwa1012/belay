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
