'use strict';
// worker_wait on the surface (ADR 0015 §1, admitted under the ADR 0010 §5 rule). It is an
// orchestrator tool: a worker cannot wait on its peers. The budget is asserted with the new total
// rather than with the old count, because §5 admits a tool on a measured number and not on a belief
// that one more will fit.

const test = require('node:test');
const assert = require('node:assert');

const { launch, sandboxDir } = require('./rpc.cjs');
const tools = require('../../src/mcp/tools.cjs');

test('the orchestrator lists worker_wait, next to the spawn it waits on', async (t) => {
  const a = launch({ role: 'orchestrator', data: `${sandboxDir('wait-o')}/store` });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  const names = (await a.list()).map((x) => x.name);
  assert.equal(names.length, 22); // 21 + ADR 0054 git_read
  assert.ok(names.includes('worker_wait'));
  assert.equal(names[names.indexOf('worker_spawn') + 1], 'worker_wait',
    'it reads beside worker_spawn: that call returns at ready, this one waits for what happens next');
});

test('a worker cannot wait on its peers, and the refusal names the role that can', async (t) => {
  const w = launch({ role: 'worker', workerId: 'wk-1', data: `${sandboxDir('wait-w')}/store` });
  t.after(async () => { await w.close(); w.kill(); });
  await w.initialize();
  const names = (await w.list()).map((x) => x.name);
  assert.equal(names.length, 13);
  assert.ok(!names.includes('worker_wait'));
  const r = await w.call('worker_wait', {});
  assert.equal(r.isError, true);
  assert.match(r.structuredContent.message, /orchestrator/, 'the refusal names the role it belongs to');
});

test('--experimental-worker-wait is still accepted, and changes nothing', async (t) => {
  // It gated the tool while ADR 0014 finding 1 was probed. Older probe drivers
  // still pass it, so it stays accepted and inert rather than
  // becoming an unknown-argument exit that would make those receipts unreproducible.
  const a = launch({ role: 'orchestrator', data: `${sandboxDir('wait-flag')}/store`, extra: ['--experimental-worker-wait'] });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  assert.equal((await a.list()).length, 22);
});

test('the listing is inside the ADR 0010 §5 budget with the nineteenth tool on it', () => {
  const bytes = tools.listingBytes('orchestrator');
  const budget = tools.BUDGET.orchestrator;
  console.log(`ADR 0015: orchestrator ${tools.toolsFor('orchestrator').length} tools, ${bytes} bytes, budget ${budget}, headroom ${budget - bytes}`);
  assert.ok(bytes <= budget, `${bytes} bytes is over the ${budget} byte budget`);
  assert.equal(tools.roleOf('worker_wait'), 'orchestrator');
  assert.equal(tools.routeOf('worker_wait').via, 'run');
  assert.equal(tools.routeOf('worker_wait').method, 'wait');
  assert.equal(tools.routeOf('worker_wait').experimental, undefined, 'no gate is left behind');
});
