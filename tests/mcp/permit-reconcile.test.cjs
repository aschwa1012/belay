'use strict';
require('../helpers/tmp.cjs');
// permit-reconcile.test.cjs — createPermit against an in-memory fake core. Two interleavings the
// real-adapter tests in permit.test.cjs do not reach: a cancel that lands before the request row
// exists, and a request write whose outcome is unknown (the owner lost after the send). In both a
// pending row must not be left behind with nothing waiting on it.

const test = require('node:test');
const assert = require('node:assert');

const { createPermit } = require('../../src/mcp/permit.cjs');

function coded(code, message, detail) {
  return Object.assign(new Error(message), { code, detail });
}

// A fake core over a Map. `hooks.beforeRequest` may stall the request; `hooks.afterRequest` may
// throw after the row has been written.
function fakeCore(hooks = {}) {
  const rows = new Map();
  const core = {
    rows,
    permission: {
      async request({ id, tool }) {
        if (hooks.beforeRequest) await hooks.beforeRequest();
        const row = { id, tool, state: 'pending' };
        rows.set(id, row);
        if (hooks.afterRequest) hooks.afterRequest();
        return { ...row };
      },
      async wait({ id }) {
        return { request: { ...rows.get(id) }, timed_out: false };
      },
      async decide({ id, verdict, reason }) {
        const row = rows.get(id);
        if (!row) throw coded('E_NOT_FOUND', `no permission row with id ${id}`);
        if (row.state !== 'pending') throw coded('E_ARGS', 'already decided', { state: row.state });
        row.state = verdict === 'expire' ? 'expired' : verdict === 'allow' ? 'allowed' : 'denied';
        row.reason = reason;
        return { verdict: { ...row } };
      },
      async list() {
        return { requests: [...rows.values()].filter((r) => r.state !== 'pending').map((r) => ({ ...r })) };
      },
    },
  };
  return core;
}

test('a cancel that lands before the request row exists is applied once the row is written', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const inRequest = new Promise((r) => { entered = r; });
  const core = fakeCore({ beforeRequest: () => { entered(); return gate; } });
  const permit = createPermit({ openCore: async () => core, waitMs: 3000 });

  const called = permit.call({ tool_name: 'Bash', tool_use_id: 'tu-c', input: {} }, 7);
  await inRequest;
  await permit.cancel(7); // the expire finds no row yet (E_NOT_FOUND)
  release();
  assert.strictEqual(await called, null, 'a cancelled call answers nothing');
  assert.strictEqual(core.rows.get('tu-c').state, 'expired', 'the row must not be left pending');
  await assert.rejects(core.permission.decide({ id: 'tu-c', verdict: 'allow' }), (e) => e.code === 'E_ARGS');
});

test('an unknown request outcome is reconciled: a committed row is expired, not left pending', async () => {
  const core = fakeCore({
    afterRequest: () => { throw coded('E_OWNER_LOST', 'the owner was lost after permission.request was sent; the owner may already have committed it', { sent: true, may_have_committed: true, outcome: 'unknown' }); },
  });
  const permit = createPermit({ openCore: async () => core, waitMs: 3000 });
  const answer = await permit.call({ tool_name: 'Bash', tool_use_id: 'tu-u', input: {} }, 9);
  const body = JSON.parse(answer.content[0].text);
  assert.strictEqual(body.behavior, 'deny');
  assert.strictEqual(core.rows.get('tu-u').state, 'expired', 'the committed row must be expired');
  assert.doesNotMatch(body.message, /could not be written/, 'a row that may exist is not "not written"');
  assert.match(body.message, /unknown/);
});

test('a cancel whose own expire failed after the row existed is retried when the wait returns', async () => {
  let releaseWait;
  const waitGate = new Promise((r) => { releaseWait = r; });
  let waiting;
  const inWait = new Promise((r) => { waiting = r; });
  const core = fakeCore();
  const realDecide = core.permission.decide;
  let failed = false;
  core.permission.decide = async (a) => {
    if (!failed) { failed = true; throw coded('E_OWNER_LOST', 'owner gone', { sent: false }); }
    return realDecide(a);
  };
  core.permission.wait = async ({ id }) => { waiting(); await waitGate; return { request: { ...core.rows.get(id) }, timed_out: true }; };
  const permit = createPermit({ openCore: async () => core, waitMs: 3000 });
  const called = permit.call({ tool_name: 'Bash', tool_use_id: 'tu-b', input: {} }, 13);
  await inWait;
  await permit.cancel(13); // its expire fails once
  assert.strictEqual(core.rows.get('tu-b').state, 'pending');
  releaseWait();
  assert.strictEqual(await called, null);
  assert.strictEqual(core.rows.get('tu-b').state, 'expired', 'the row must not be left pending');
});

test('a racing expire that already landed is not logged as a failed cancel', async () => {
  const core = fakeCore();
  core.permission.decide = async ({ id }) => { core.rows.get(id).state = 'expired'; throw coded('E_ARGS', 'already decided', { state: 'expired' }); };
  let releaseWait;
  const waitGate = new Promise((r) => { releaseWait = r; });
  let waiting;
  const inWait = new Promise((r) => { waiting = r; });
  core.permission.wait = async ({ id }) => { waiting(); await waitGate; return { request: { ...core.rows.get(id) }, timed_out: true }; };
  const logs = [];
  const permit = createPermit({ openCore: async () => core, waitMs: 3000, log: (k, m) => logs.push(`${k} ${m}`) });
  const called = permit.call({ tool_name: 'Bash', tool_use_id: 'tu-s', input: {} }, 14);
  await inWait;
  await permit.cancel(14);
  releaseWait();
  await called;
  assert.ok(!logs.some((l) => /cancel failed/.test(l)), logs.join('\n'));
});

test('the unknown-outcome reconcile is bounded by the adapter wait bound when the owner never answers', async () => {
  const core = fakeCore({
    afterRequest: () => { throw coded('E_OWNER_LOST', 'lost', { sent: true, may_have_committed: true, outcome: 'unknown' }); },
  });
  core.permission.decide = () => new Promise(() => {}); // wedged owner
  const permit = createPermit({ openCore: async () => core, waitMs: 200 });
  const t0 = Date.now();
  const a = JSON.parse((await permit.call({ tool_name: 'Bash', tool_use_id: 'tu-w', input: {} }, 15)).content[0].text);
  assert.ok(Date.now() - t0 < 5000, 'the reconcile must not wait on a wedged owner');
  assert.strictEqual(a.behavior, 'deny');
  assert.match(a.message, /could not be reconciled/);
});

test('an unknown request outcome whose row was never written is still a plain deny', async () => {
  const core = fakeCore({
    beforeRequest: () => { throw coded('E_TIMEOUT', 'the owner did not answer', { may_have_committed: true }); },
  });
  const permit = createPermit({ openCore: async () => core, waitMs: 3000 });
  const answer = await permit.call({ tool_name: 'Bash', tool_use_id: 'tu-n', input: {} }, 10);
  assert.strictEqual(JSON.parse(answer.content[0].text).behavior, 'deny');
  assert.strictEqual(core.rows.size, 0);
});

test('an unknown request outcome whose reconcile also fails retries the expire and then says so', async () => {
  const core = fakeCore({
    afterRequest: () => { throw coded('E_OWNER_LOST', 'lost', { sent: true, may_have_committed: true, outcome: 'unknown' }); },
  });
  const real = core.permission.decide;
  let calls = 0;
  core.permission.decide = async (a) => {
    calls += 1;
    if (calls < 2) throw coded('E_OWNER_LOST', 'owner still gone', { sent: false });
    return real(a);
  };
  const permit = createPermit({ openCore: async () => core, waitMs: 3000 });
  await permit.call({ tool_name: 'Bash', tool_use_id: 'tu-r', input: {} }, 11);
  assert.strictEqual(calls, 2, 'the expire is retried');
  assert.strictEqual(core.rows.get('tu-r').state, 'expired');

  const core2 = fakeCore({
    afterRequest: () => { throw coded('E_OWNER_LOST', 'lost', { sent: true, may_have_committed: true, outcome: 'unknown' }); },
  });
  core2.permission.decide = async () => { throw coded('E_OWNER_LOST', 'owner still gone', { sent: false }); };
  const p2 = createPermit({ openCore: async () => core2, waitMs: 3000 });
  const a2 = JSON.parse((await p2.call({ tool_name: 'Bash', tool_use_id: 'tu-r2', input: {} }, 12)).content[0].text);
  assert.strictEqual(a2.behavior, 'deny');
  assert.match(a2.message, /unknown and could not be reconciled/);
});
