// lease-keepalive-real.test.cjs — build step W2-2, ADR 0026, (k8): a real worker-role adapter binary
// against the real core. The worker row is planted `running` with this test process's own pid (alive by
// construction) and a `last_event_at` the test keeps fresh, the way tests/cli/worker.test.cjs plants
// rows. BELAY_KEEPALIVE_TICK_MS shortens the tick from 60 s to 500 ms; nothing else is changed.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { launch, sandboxDir } = require('./rpc.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { releaseCore } = require('../cli/stop-helpers.cjs');

const RUN = 'run-keepalive';
const W = 'w1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const leaseOf = async (core, taskId) => {
  const { tasks } = await core.task.list({});
  return tasks.find((x) => x.id === taskId).lease;
};

test('keepalive: a real worker adapter with BELAY_KEEPALIVE_TICK_MS renews its worker\'s lease through the real core', async (t) => {
  const data = sandboxDir('keepalive');
  let core = null;
  let adapter = null;
  let fresh = null;
  try {
    core = await openCore({ dataDir: data, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid } });
    const plant = (state) => core.worker.write({
      id: W, substrate: 'claude-code', pid: process.pid, state, turns: 1, started_at: Date.now(), last_event_at: Date.now(),
    });
    await plant('running');
    const task = await core.task.create({ spec: 'a task whose lease must outlive its first length' });
    const assigned = await core.task.assign({ task_id: task.id, worker_id: W, ttl_ms: 4000 });
    const first = assigned.new_lease;
    assert.strictEqual(first.expires_at - first.granted_at, 4000);
    // The worker's stream stays fresh for as long as the test says it is working.
    fresh = setInterval(() => { plant('running').catch(() => {}); }, 300);

    // Build 12 A1: the log path is the one the run manager writes into the worker's own mcp.json, so a
    // tick landing in this file is a tick landing where a real worker's adapter logs.
    const L = require('../../src/run/launch.cjs');
    const written = L.writeWorkerFiles({
      dir: `${data}/workers/${W}`, workerId: W, runId: RUN, dataDir: data,
      logPath: L.wireLogPath(`${data}/workers/${W}`), settingsPath: `${data}/none.json`,
    });
    const margs = JSON.parse(fs.readFileSync(written.mcpJsonPath, 'utf8')).mcpServers.belay.args;
    const log = margs[margs.indexOf('--log') + 1];
    assert.ok(log.endsWith(`/workers/${W}/adapter.log`), log);
    adapter = launch({
      role: 'worker', run: RUN, data, workerId: W, fake: false, log, env: { BELAY_KEEPALIVE_TICK_MS: '500' },
    });
    await adapter.initialize();

    // Watch for 9 s, more than twice the lease's length: it must advance and never expire.
    const seen = new Set([first.expires_at]);
    let expiredWhileWorking = false;
    const until = Date.now() + 9000;
    while (Date.now() < until) {
      const l = await leaseOf(core, task.id);
      if (l.expired) expiredWhileWorking = true;
      seen.add(l.expires_at);
      await sleep(200);
    }
    assert.strictEqual(expiredWhileWorking, false, 'the lease expired while its worker was running');
    assert.ok(seen.size >= 3, `expires_at advanced only ${seen.size - 1} time(s): ${[...seen].join(', ')}`);
    const latest = Math.max(...seen);
    assert.ok(latest > first.expires_at + 4000, `the lease was pushed only ${latest - first.expires_at} ms past its first expiry`);
    assert.strictEqual((await leaseOf(core, task.id)).ttl_ms, 4000, 'every renewal kept the granted length');
    // ADR 0054 amendment 1: the keep-alive's task.list and lease.renew go on the keepalive channel, so the owner never counts them as
    // the worker's own calls (a review grant's baseline would read them as the model reaching the core).
    assert.strictEqual(core.owner.engine.workerCalls.has(W), false, 'the keep-alive calls are not the worker\'s');
    const logged =fs.readFileSync(log, 'utf8');
    assert.match(logged, /lease-keepalive .*"action":"renewed"/, 'the renewal is in the adapter\'s log');

    // The worker stops: its row says so, and the lease must now run out.
    clearInterval(fresh); fresh = null;
    await plant('stopped');
    await sleep(1300); // two ticks: any renewal that raced the plant has landed
    const settled = (await leaseOf(core, task.id)).expires_at;
    const deadline = Date.now() + 15000;
    let l = await leaseOf(core, task.id);
    while (!l.expired && Date.now() < deadline) { await sleep(200); l = await leaseOf(core, task.id); }
    assert.strictEqual(l.expired, true, 'the lease of a stopped worker never ran out');
    assert.strictEqual(l.expires_at, settled, 'a stopped worker\'s lease was renewed after its row said stopped');
    assert.match(fs.readFileSync(log, 'utf8'), /lease-keepalive .*"reason":"not-running"/);
    console.log(`keepalive real: ${seen.size - 1} renewals seen, first expiry ${first.expires_at}, latest ${latest}, settled ${settled}`);
  } finally {
    if (fresh) clearInterval(fresh);
    if (adapter) { await adapter.close(); adapter.kill(); }
    await releaseCore(core);
    t.after(() => { try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* left for the OS temp sweep */ } });
  }
});
