'use strict';
// compose-assign-mark.test.cjs — task_assign marks the worker record before the core commits the lease, so stop_idle_on_done
// (idle-stop.cjs) sees an assign in flight; the mark is released when the core answers or fails, and an assign is refused
// before the core is called once an idle stop has decided to go ahead.

const test = require('node:test');
const assert = require('node:assert');
const { createCompose } = require('../../src/mcp/compose.cjs');

const deferred = () => { let resolve; let reject; const p = new Promise((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };

function harness(w) {
  const gate = deferred();
  const listed = deferred();
  const calls = [];
  const callCore = async (m, a) => {
    calls.push(m);
    if (m === 'task.assign') { listed.resolve(); return gate.p; }
    throw new Error(`unexpected ${m}`);
  };
  const mgr = { _worker: (id) => (id === 'w1' ? w : null), message: async () => ({ channel: 'stdin', bytes: 1 }) };
  return { c: createCompose({ callCore, manager: () => mgr }), gate, listed, calls };
}

test('the worker is marked while the core assign is in flight and released when it fails', async () => {
  const w = {};
  const h = harness(w);
  const run = h.c.assign({ task_id: 't1', worker_id: 'w1' });
  await h.listed.p; // callCore('task.assign') has been called and is held
  assert.strictEqual(w.assigning, 1);
  h.gate.reject(new Error('core down'));
  await assert.rejects(run, /core down/);
  assert.strictEqual(w.assigning, 0);
});

test('an assign is refused E_BUSY before the core is called once an idle stop has decided to stop', async () => {
  const w = { id: 'w1', op: { name: 'idle-stop', promise: Promise.resolve() }, stopCommitted: true };
  const h = harness(w);
  await assert.rejects(h.c.assign({ task_id: 't1', worker_id: 'w1' }), (e) => e.code === 'E_BUSY');
  assert.deepStrictEqual(h.calls, [], 'the core was never called');
  assert.ok(!w.assigning, 'no mark left behind');
});

test('a worker this session did not launch is assigned without a mark', async () => {
  const h = harness({});
  const run = h.c.assign({ task_id: 't1', worker_id: 'other' });
  await h.listed.p;
  h.gate.reject(new Error('stop here'));
  await assert.rejects(run, /stop here/);
});
