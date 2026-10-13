'use strict';
// permit.test.cjs — build step 6d, design item 3, ADR
// 0020 decisions 1, 3 and 5. The worker adapter as a real child process through tests/mcp/rpc.cjs,
// against an owner elected in this test process (openCore as orchestrator, run.attach, in a
// sandbox). `permit` is driven with `a.send('tools/call', ...)` rather than `a.call`, so the promise
// can be held while the test decides its verdict from the owning core.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { launch, sandboxDir } = require('./rpc.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { PERMISSION_STATES } = require('../../src/core/schema.cjs');
const REAL_TOOLS = require('../../src/mcp/tools.cjs');
const { createPermit } = require('../../src/mcp/permit.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const real = (o) => launch({ ...o, fake: false, noEmbed: true });

async function until(fn, timeoutMs, stepMs = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 >= timeoutMs) return null;
    await sleep(stepMs);
  }
}

async function setupOwner(dataDir, runId) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: false });
  await core.run.attach({ adapter_pid: process.pid });
  return core;
}

// ================================================================ (g) listing and the missing-flag refusal

test('permit: listed last only for an adapter launched with --permit, its bytes under 320, the worker listing without it unchanged and under 5,120, and a call without --permit is refused naming the flag', async (t) => {
  const dataDir = `${sandboxDir('permit-g')}/store`;
  const orchCore = await setupOwner(dataDir, 'run-g');
  t.after(async () => { await orchCore.shutdownOwner().catch(() => {}); await orchCore.close(); });

  const withoutPermit = real({ role: 'worker', run: 'run-g', workerId: 'w-g1', data: dataDir });
  t.after(async () => { await withoutPermit.close(); withoutPermit.kill(); });
  await withoutPermit.initialize();
  const listWithout = await withoutPermit.list();
  assert.ok(!listWithout.some((x) => x.name === 'permit'), 'permit must not be listed with no --permit');
  const bytesWithout = Buffer.byteLength(JSON.stringify(listWithout), 'utf8');
  assert.ok(bytesWithout <= 5120, `worker listing without permit is ${bytesWithout} bytes`);
  assert.strictEqual(bytesWithout, REAL_TOOLS.listingBytes('worker'), 'unchanged from toolsFor(worker) alone');

  const withPermit = real({ role: 'worker', run: 'run-g', workerId: 'w-g2', data: dataDir, extra: ['--permit'] });
  t.after(async () => { await withPermit.close(); withPermit.kill(); });
  await withPermit.initialize();
  const listWith = await withPermit.list();
  assert.strictEqual(listWith[listWith.length - 1].name, 'permit', 'permit is listed last');
  assert.strictEqual(listWith.length, listWithout.length + 1);
  const permitBytes = Buffer.byteLength(JSON.stringify(listWith[listWith.length - 1]), 'utf8');
  assert.ok(permitBytes <= 320, `permit tool is ${permitBytes} bytes`);
  assert.strictEqual(permitBytes, REAL_TOOLS.permitBytes());

  // a call without --permit is refused naming the flag
  const r = await withoutPermit.call('permit', { tool_name: 'Bash', tool_use_id: 'tu-g-no-flag', input: {} });
  assert.strictEqual(r.isError, true);
  assert.match(JSON.stringify(r), /--permit/);
});

// ================================================================ (h) allow

test("permit: a call writes a pending row from argv identity and answers allow with updatedInput equal to the input promptly once the orchestrator decides, not after its wait slice", async (t) => {
  const dataDir = `${sandboxDir('permit-h')}/store`;
  const orchCore = await setupOwner(dataDir, 'run-h');
  t.after(async () => { await orchCore.shutdownOwner().catch(() => {}); await orchCore.close(); });
  const a = real({ role: 'worker', run: 'run-h', workerId: 'w-h', data: dataDir, extra: ['--permit'] });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const toolUseId = `tu-h-${process.pid}`;
  const input = { command: 'echo hi' };
  const callPromise = a.send('tools/call', { name: 'permit', arguments: { tool_name: 'Bash', tool_use_id: toolUseId, input } });

  const row = await until(async () => {
    const { requests } = await orchCore.permission.list({ run_id: 'run-h' });
    return requests.find((r) => r.id === toolUseId) || null;
  }, 2000);
  assert.ok(row, 'the pending row never appeared within 2,000 ms');
  assert.strictEqual(row.worker_id, 'w-h');
  assert.strictEqual(row.run_id, 'run-h');
  assert.strictEqual(row.adapter_pid, a.pid);
  assert.strictEqual(row.state, 'pending');

  const t0 = Date.now();
  await orchCore.permission.decide({ id: toolUseId, verdict: 'allow' });
  const msg = await callPromise;
  const elapsed = Date.now() - t0;
  // The wait is woken by the decide, so a quiet host answers in tens of ms; a missed wake costs the adapter's 25 s wait
  // slice. 500 ms was thin for a hosted runner, so the bound is 10 s, still well under the slice.
  assert.ok(elapsed < 10000, `the call answered ${elapsed} ms after the decide`);
  const body = JSON.parse(msg.result.content[0].text);
  assert.strictEqual(body.behavior, 'allow');
  assert.deepStrictEqual(body.updatedInput, input);
});

// ================================================================ (i) deny

test('permit: deny answers the reason as the message and the row reads denied with verdict_by orchestrator:<pid>', async (t) => {
  const dataDir = `${sandboxDir('permit-i')}/store`;
  const orchCore = await setupOwner(dataDir, 'run-i');
  t.after(async () => { await orchCore.shutdownOwner().catch(() => {}); await orchCore.close(); });
  const a = real({ role: 'worker', run: 'run-i', workerId: 'w-i', data: dataDir, extra: ['--permit'] });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const toolUseId = `tu-i-${process.pid}`;
  const callPromise = a.send('tools/call', { name: 'permit', arguments: { tool_name: 'Bash', tool_use_id: toolUseId, input: {} } });
  const row = await until(async () => {
    const { requests } = await orchCore.permission.list({ run_id: 'run-i' });
    return requests.find((r) => r.id === toolUseId) || null;
  }, 2000);
  assert.ok(row, 'the pending row never appeared within 2,000 ms');

  await orchCore.permission.decide({ id: toolUseId, verdict: 'deny', reason: 'no thanks' });
  const msg = await callPromise;
  const body = JSON.parse(msg.result.content[0].text);
  assert.strictEqual(body.behavior, 'deny');
  assert.strictEqual(body.message, 'no thanks');

  const { requests } = await orchCore.permission.list({ states: ['denied'] });
  const r = requests.find((x) => x.id === toolUseId);
  assert.ok(r, 'the row must read denied');
  assert.strictEqual(r.verdict_by, `orchestrator:${process.pid}`);
});

// ================================================================ (j) the adapter's own bound

test('permit: with --permit-wait-ms 1500 and no verdict the call answers deny naming the bound at its 1,500 ms, not after the full wait slice, and the row reads expired with verdict_by adapter-bound:<adapter pid>', async (t) => {
  const dataDir = `${sandboxDir('permit-j')}/store`;
  const orchCore = await setupOwner(dataDir, 'run-j');
  t.after(async () => { await orchCore.shutdownOwner().catch(() => {}); await orchCore.close(); });
  const a = real({ role: 'worker', run: 'run-j', workerId: 'w-j', data: dataDir, extra: ['--permit', '--permit-wait-ms', '1500'] });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const toolUseId = `tu-j-${process.pid}`;
  const t0 = Date.now();
  const msg = await a.send('tools/call', { name: 'permit', arguments: { tool_name: 'Bash', tool_use_id: toolUseId, input: {} } });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 1500 && elapsed <= 12000, `the call answered in ${elapsed} ms, expected 1,500 to 12,000`);
  // The upper bound separates the 1,500 ms bound honoured from a slice that was not shortened to it (25 s).
  const body = JSON.parse(msg.result.content[0].text);
  assert.strictEqual(body.behavior, 'deny');
  assert.match(body.message, /1500/);

  const { requests } = await orchCore.permission.list({ states: ['expired'] });
  const r = requests.find((x) => x.id === toolUseId);
  assert.ok(r, 'the row must read expired');
  assert.strictEqual(r.verdict_by, `adapter-bound:${a.pid}`);
});

// ================================================================ (k) cancellation

test('permit: notifications/cancelled for an in-flight call expires the row naming the substrate and no answer is written', async (t) => {
  const dataDir = `${sandboxDir('permit-k')}/store`;
  const orchCore = await setupOwner(dataDir, 'run-k');
  t.after(async () => { await orchCore.shutdownOwner().catch(() => {}); await orchCore.close(); });
  const a = real({ role: 'worker', run: 'run-k', workerId: 'w-k', data: dataDir, extra: ['--permit', '--permit-wait-ms', '30000'] });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  let stdoutBuf = '';
  a.child.stdout.on('data', (d) => { stdoutBuf += d.toString('utf8'); });

  const toolUseId = `tu-k-${process.pid}`;
  const rpcId = a._nextId;
  const callPromise = a.send('tools/call', { name: 'permit', arguments: { tool_name: 'Bash', tool_use_id: toolUseId, input: {} } });
  callPromise.catch(() => {}); // this call is cancelled below and never answers; swallow the eventual timeout

  const row = await until(async () => {
    const { requests } = await orchCore.permission.list({ run_id: 'run-k' });
    return requests.find((r) => r.id === toolUseId) || null;
  }, 2000);
  assert.ok(row, 'the pending row never appeared within 2,000 ms');

  a.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: rpcId } })}\n`);

  const gotRow = await until(async () => {
    const { requests } = await orchCore.permission.list({ states: ['expired'] });
    return requests.find((x) => x.id === toolUseId) || null;
  }, 2000);
  assert.ok(gotRow, 'the row must read expired after the cancel');
  assert.match(gotRow.reason, /substrate/);

  await sleep(1000);
  assert.ok(!stdoutBuf.includes(`"id":${rpcId}`), 'no answer may be written to stdout for a cancelled call');
});

// ================================================================ (l) missing fields

test('permit: a call missing tool_use_id or tool_name is an error result naming the field and writes no row', async (t) => {
  const dataDir = `${sandboxDir('permit-l')}/store`;
  const orchCore = await setupOwner(dataDir, 'run-l');
  t.after(async () => { await orchCore.shutdownOwner().catch(() => {}); await orchCore.close(); });
  const a = real({ role: 'worker', run: 'run-l', workerId: 'w-l', data: dataDir, extra: ['--permit'] });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const before = (await orchCore.permission.list({ states: PERMISSION_STATES })).requests.length;

  const r1 = await a.call('permit', { tool_name: 'Bash', input: {} });
  assert.strictEqual(r1.isError, true);
  assert.match(JSON.stringify(r1), /tool_use_id/);

  const r2 = await a.call('permit', { tool_use_id: 'x', input: {} });
  assert.strictEqual(r2.isError, true);
  assert.match(JSON.stringify(r2), /tool_name/);

  const after = (await orchCore.permission.list({ states: PERMISSION_STATES })).requests.length;
  assert.strictEqual(after, before, 'a field refusal must write nothing');
});

// ================================================================ (m) no owner

test('permit: with no owner the call answers deny naming E_NO_OWNER and creates nothing', async (t) => {
  const parent = sandboxDir('permit-m');
  const dataDir = `${parent}/store`;
  const a = real({ role: 'worker', run: 'run-m', workerId: 'w-m', data: dataDir, extra: ['--permit'] });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const r = await a.call('permit', { tool_name: 'Bash', tool_use_id: 'tu-m', input: {} });
  assert.strictEqual(r.isError, false, 'a permit answer is never itself an MCP error, even when it denies');
  const body = JSON.parse(r.content[0].text);
  assert.strictEqual(body.behavior, 'deny');
  assert.match(body.message, /E_NO_OWNER/);

  assert.strictEqual(fs.existsSync(dataDir), false, 'no owner and no election means nothing is created');
});

// ================================================================ (n) the orchestrator's own tools

test('permission_list and permission_decide: listed for the orchestrator after task_assign, routed to the core, refused E_ROLE for a worker, and the orchestrator listing stays under the orchestrator budget', async (t) => {
  const names = REAL_TOOLS.toolsFor('orchestrator').map((x) => x.name);
  assert.strictEqual(names[names.indexOf('task_assign') + 1], 'permission_list');
  assert.strictEqual(names[names.indexOf('task_assign') + 2], 'permission_decide');
  assert.ok(REAL_TOOLS.listingBytes('orchestrator') <= REAL_TOOLS.BUDGET.orchestrator);

  const data = sandboxDir('permit-n');
  const a = launch({ role: 'orchestrator', data }); // fake core, default
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const listed = await a.call('permission_list', { run_id: 'r' });
  assert.strictEqual(listed.isError, false);
  assert.ok(Array.isArray(listed.structuredContent.requests), 'permission_list is routed to the fake core');

  const decided = await a.call('permission_decide', { id: 'x', verdict: 'allow' });
  assert.strictEqual(decided.isError, false);
  assert.ok(decided.structuredContent.request && decided.structuredContent.verdict, 'permission_decide is routed to the fake core');

  const w = launch({ role: 'worker', data: `${data}-w`, workerId: 'wk-1' });
  t.after(async () => { await w.close(); w.kill(); });
  await w.initialize();
  assert.strictEqual((await w.call('permission_list', {})).structuredContent.error, 'E_ROLE');
  assert.strictEqual((await w.call('permission_decide', { id: 'x', verdict: 'allow' })).structuredContent.error, 'E_ROLE');

  // permission_decide routed to the real core once, over the real adapter and a sandbox with no
  // owner, so the shape is the real one and not just the fake's canned answer.
  const dataDir = `${sandboxDir('permit-n-real')}/store`;
  const orchCore = await setupOwner(dataDir, 'run-n');
  t.after(async () => { await orchCore.shutdownOwner().catch(() => {}); await orchCore.close(); });
  const realAdapter = real({ role: 'orchestrator', run: 'run-n', data: dataDir });
  t.after(async () => { await realAdapter.close(); realAdapter.kill(); });
  await realAdapter.initialize();
  const toolUseId = `tu-n-${process.pid}`;
  const worker = await openCore({ dataDir, caller: { role: 'worker', worker_id: 'w-n', run_id: 'run-n', pid: process.pid }, embed: false });
  try {
    await worker.permission.request({ id: toolUseId, tool: 'Bash', input: null });
  } finally { await worker.close(); }
  const realDecide = await realAdapter.call('permission_decide', { id: toolUseId, verdict: 'allow' });
  assert.strictEqual(realDecide.isError, false);
  assert.strictEqual(realDecide.structuredContent.verdict.state, 'allowed');
});

// ================================================================ (fix round) permission.wait failures
// are retried against the real clock, never mistaken for the adapter's own bound (reviewer finding,
// build-3/receipts/6d review: the loop used to break and expire on the first failed slice).

test("permit: a permission.wait failure with real time still on the clock is retried, never answered as the adapter's own bound", async () => {
  let waitCalls = 0;
  let decideCalls = 0;
  const verdictRow = { id: 'tu-fix1', state: 'allowed', verdict_by: 'operator:1', reason: null };
  const fakeCore = {
    permission: {
      request: async () => ({ id: 'tu-fix1', state: 'pending' }),
      wait: async () => {
        waitCalls += 1;
        if (waitCalls === 1) {
          const e = new Error('the owner did not answer permission.wait within 24000 ms');
          e.code = 'E_TIMEOUT';
          throw e;
        }
        return { request: verdictRow, timed_out: false, already: false, waited_ms: 5 };
      },
      decide: async () => { decideCalls += 1; throw new Error('must not be called'); },
      list: async () => ({ requests: [] }),
    },
  };
  const permit = createPermit({ openCore: async () => fakeCore, caller: { pid: 1 }, waitMs: 600000, log: () => {} });
  const answer = await permit.call({ tool_name: 'Bash', tool_use_id: 'tu-fix1', input: {} }, 1);
  const body = JSON.parse(answer.content[0].text);
  assert.strictEqual(body.behavior, 'allow');
  assert.strictEqual(waitCalls, 2, 'the second wait must be tried after the first failed');
  assert.strictEqual(decideCalls, 0, 'a single failed slice must never be answered as the bound expiring');
});

test('permit: when the store stays unreachable to the adapter\'s own bound, the answer names the store as unreachable, never a false claim about the bound', async () => {
  let waitCalls = 0;
  const fakeErr = () => { const e = new Error('no owner answered'); e.code = 'E_NO_OWNER'; return e; };
  const fakeCore = {
    permission: {
      request: async () => ({ id: 'tu-fix2', state: 'pending' }),
      wait: async () => { waitCalls += 1; throw fakeErr(); },
      decide: async () => { throw fakeErr(); },
      list: async () => ({ requests: [] }),
    },
  };
  const permit = createPermit({ openCore: async () => fakeCore, caller: { pid: 2 }, waitMs: 250, log: () => {} });
  const t0 = Date.now();
  const answer = await permit.call({ tool_name: 'Bash', tool_use_id: 'tu-fix2', input: {} }, 2);
  const elapsed = Date.now() - t0;
  const body = JSON.parse(answer.content[0].text);
  assert.strictEqual(body.behavior, 'deny');
  assert.match(body.message, /unreachable/);
  assert.match(body.message, /E_NO_OWNER/);
  assert.ok(!/^belay: no verdict within 250 ms$/.test(body.message), 'must not claim the plain bound when nothing confirmed it');
  assert.ok(waitCalls >= 1);
  assert.ok(elapsed >= 250, `must genuinely spend the bound retrying, took ${elapsed} ms`);
});
