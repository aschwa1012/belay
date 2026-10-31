'use strict';
// An orchestrator lists and decides the permission requests of its own run only; the run comes from its
// process arguments, never from the request or the call. The operator is not bound to a run.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { openCore } = core('index.cjs');
const { teardown } = require('../helpers/teardown.cjs');

let dir, a, b, wa, operator;

before(async () => {
  dir = sandbox();
  a = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'ra' }), embed: false });
  await a.run.attach({ adapter_pid: process.pid });
  b = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'rb' }), embed: false });
  await b.run.attach({ adapter_pid: process.pid });
  wa = await openCore({ dataDir: dir, caller: callerFor('worker', { run_id: 'ra', worker_id: 'X' }), embed: false });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
});

after(async () => {
  await teardown(null, [
    () => wa && wa.close(), () => operator && operator.close(), () => b && b.close(),
    () => a && a.shutdownOwner(), () => a && a.close(), () => cleanup(dir),
  ]);
});

test("an orchestrator of run rb neither lists nor decides run ra's permission request; ra's orchestrator and the operator can", async () => {
  await wa.permission.request({ id: 'tu1', tool: 'Bash', input: { command: 'echo hi' } });

  assert.deepStrictEqual((await b.permission.list({})).requests.map((r) => r.id), [], 'rb sees nothing of ra');
  await assert.rejects(b.permission.list({ run_id: 'ra' }), (e) => { assert.strictEqual(e.code, 'E_ROLE'); return true; });
  assert.deepStrictEqual((await a.permission.list({})).requests.map((r) => r.id), ['tu1']);
  assert.deepStrictEqual((await operator.permission.list({})).requests.map((r) => r.id), ['tu1'], 'the operator lists across runs');

  await assert.rejects(b.permission.decide({ id: 'tu1', verdict: 'allow' }), (e) => { assert.strictEqual(e.code, 'E_ROLE'); return true; });
  const still = (await operator.permission.list({})).requests.find((r) => r.id === 'tu1');
  assert.strictEqual(still.state, 'pending', 'the refused decide wrote nothing');

  const d = await operator.permission.decide({ id: 'tu1', verdict: 'deny' });
  assert.strictEqual(d.verdict.state, 'denied', 'the operator decides across runs');
  await wa.permission.request({ id: 'tu2', tool: 'Bash', input: null });
  assert.strictEqual((await a.permission.decide({ id: 'tu2', verdict: 'allow' })).verdict.state, 'allowed');
});

test("a worker with the same id in another run can neither expire nor wait on this run's permission row", async () => {
  const wb = await openCore({ dataDir: dir, caller: callerFor('worker', { run_id: 'rb', worker_id: 'X' }), embed: false });
  try {
    await wa.permission.request({ id: 'tu3', tool: 'Bash', input: null });
    await assert.rejects(wb.permission.decide({ id: 'tu3', verdict: 'expire' }), (e) => { assert.strictEqual(e.code, 'E_ROLE'); return true; });
    await assert.rejects(wb.permission.wait({ id: 'tu3', timeout_ms: 50 }), (e) => { assert.strictEqual(e.code, 'E_ROLE'); return true; });
    const row = (await operator.permission.list({})).requests.find((r) => r.id === 'tu3');
    assert.strictEqual(row.state, 'pending', 'the refused expire wrote nothing');
    assert.strictEqual((await wa.permission.decide({ id: 'tu3', verdict: 'expire' })).verdict.state, 'expired', 'the owner worker still can');
  } finally { await wb.close(); }
});
