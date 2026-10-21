'use strict';
// bind-adapter.test.cjs — ADR 0045 decision 2 through the real adapter binary against a real owner that serves `bound`: an adapter
// launched with --bind claims its identity before it answers `initialize`, then works; the same adapter without a bind is refused its
// writes; a bind that is spent, absent or for another identity ends the process before the session sees a server. Real children,
// killed by exact pid; a sandbox data dir; no model, no embedder.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { launch, sandboxDir } = require('./rpc.cjs');
const { Owner } = require('../../src/core/owner.cjs');

const RUN = 'run-bind-adapter';
const operator = { role: 'operator', run_id: RUN, pid: process.pid };

async function withBoundOwner(t, fn) {
  const data = sandboxDir('bind-adapter');
  const owner = new Owner(data, { embed: false, mode: 'bound' });
  await owner.start();
  const kids = [];
  const adapter = (opts) => { const a = launch({ run: RUN, data, fake: false, ...opts }); kids.push(a); return a; };
  try { await fn({ owner, data, adapter }); }
  finally {
    for (const a of kids) { await a.close(1500); a.kill(); }
    await owner.stop().catch(() => {});
    t.after(() => { try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* left for the OS temp sweep */ } });
  }
}

const bindFor = (owner, identity) => owner.bindCall('bind.open', { identity }, operator);

test('an adapter launched with its bind works as the bound identity; the same adapter with no bind is refused its writes', { timeout: 90000 }, async (t) => {
  await withBoundOwner(t, async ({ owner, adapter }) => {
    const b = await bindFor(owner, { role: 'orchestrator', run_id: RUN });
    const bound = adapter({ role: 'orchestrator', extra: ['--bind', b.pipe] });
    await bound.initialize();
    const made = await bound.call('task_create', { spec: 'a task written through a bound adapter' });
    assert.strictEqual(made.isError, false, JSON.stringify(made.structuredContent));
    assert.strictEqual((await owner.binds.status(b.bind_id)).claimed, true, 'the adapter claimed its bind before it answered');

    const unbound = adapter({ role: 'orchestrator' });
    await unbound.initialize();
    const refused = await unbound.call('task_create', { spec: 'a task from an adapter that holds no bind' });
    assert.strictEqual(refused.isError, true);
    assert.strictEqual(refused.structuredContent.error, 'E_UNBOUND', JSON.stringify(refused.structuredContent));
    const read = await unbound.call('task_list', {});
    assert.strictEqual(read.isError, false, 'a read needs no bind');
  });
});

test('a bind for another identity, a spent bind and a missing bind each end the adapter before it answers initialize', { timeout: 90000 }, async (t) => {
  await withBoundOwner(t, async ({ owner, adapter }) => {
    const wrong = await bindFor(owner, { role: 'worker', run_id: RUN, worker_id: 'w1' });
    const asOther = adapter({ role: 'worker', workerId: 'w2', extra: ['--bind', wrong.pipe] });
    const exit1 = await asOther.exited;
    assert.strictEqual(exit1.code, 3);
    assert.match(asOther.stderr, /not this adapter's argv identity/);
    assert.strictEqual((await owner.binds.status(wrong.bind_id)).claimed, true, 'the owner saw a claim; the adapter refused what it was given');

    const good = await bindFor(owner, { role: 'worker', run_id: RUN, worker_id: 'w3' });
    const first = adapter({ role: 'worker', workerId: 'w3', extra: ['--bind', good.pipe] });
    await first.initialize();
    const second = adapter({ role: 'worker', workerId: 'w3', extra: ['--bind', good.pipe] });
    const exit2 = await second.exited;
    assert.strictEqual(exit2.code, 3, 'a second adapter cannot claim a spent bind');
    assert.match(second.stderr, /E_BIND/);

    const missing = adapter({ role: 'worker', workerId: 'w4', extra: ['--bind', `${good.pipe}-nothing-listens-here`] });
    const exit3 = await missing.exited;
    assert.strictEqual(exit3.code, 3);
    assert.strictEqual(missing._buf, '', 'no byte of MCP was written');
    assert.ok(!asOther._buf && !second._buf, 'neither refused adapter wrote any MCP');
  });
});

test('a worker bind handed to an orchestrator adapter, and a bind for another run, each end the adapter with exit 3 and no MCP written', { timeout: 90000 }, async (t) => {
  await withBoundOwner(t, async ({ owner, adapter }) => {
    const workerBind = await bindFor(owner, { role: 'worker', run_id: RUN, worker_id: 'w1' });
    const asOrchestrator = adapter({ role: 'orchestrator', extra: ['--bind', workerBind.pipe] });
    const exit1 = await asOrchestrator.exited;
    assert.strictEqual(exit1.code, 3);
    assert.match(asOrchestrator.stderr, /not this adapter's argv identity/);
    assert.ok(!asOrchestrator._buf, 'no MCP written');

    const otherRun = await bindFor(owner, { role: 'worker', run_id: 'run-someone-else', worker_id: 'w5' });
    const asWrongRun = adapter({ role: 'worker', workerId: 'w5', extra: ['--bind', otherRun.pipe] });
    const exit2 = await asWrongRun.exited;
    assert.strictEqual(exit2.code, 3);
    assert.match(asWrongRun.stderr, /not this adapter's argv identity/);
    assert.ok(!asWrongRun._buf, 'no MCP written');
  });
});
