'use strict';
// write-rerun.test.cjs — ADR 0033 decisions 2 and 3: Core._write re-runs a write after E_OWNER_LOST only
// when the call never left or the method is in RERUN_SAFE_AFTER_SEND. The first Core elects and so is
// the in-process owner; a second Core reaches it over the pipe. The owner's engine.handle is wrapped so
// that, once the real call has committed, every connection is destroyed before the reply is written.

const { test } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { err } = core('errors.cjs');

async function setup() {
  const dir = sandbox();
  const host = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  let remote = null;
  try {
    await host.run.attach({ adapter_pid: process.pid });
    assert.ok(host.owner, 'the first Core is the owner');
    remote = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    await remote.run.get({}); // a read; the first write below connects over the pipe
  } catch (e) {
    // A failed setup must not leave the owner or the client open: unwind what exists, then rethrow.
    if (remote) await remote.close().catch(() => {});
    await host.shutdownOwner().catch(() => {});
    await host.close().catch(() => {});
    cleanup(dir);
    throw e;
  }
  return { dir, host, remote };
}

// Drop the reply of the first call to each named method, after it has committed.
function dropFirstReplies(host, methods) {
  const engine = host.owner.engine;
  const real = engine.handle.bind(engine);
  const seen = new Map();
  engine.handle = async (method, params) => {
    const result = await real(method, params);
    if (methods.includes(method) && !seen.get(method)) {
      seen.set(method, true);
      for (const c of host.owner.conns) c.destroy();
    }
    return result;
  };
  return seen;
}

async function teardown(ctx) {
  await ctx.remote.close().catch(() => {});
  await ctx.host.shutdownOwner().catch(() => {});
  await ctx.host.close().catch(() => {});
  cleanup(ctx.dir);
}

test('S8-FIX-3: run.end whose reply is lost is not re-run; one ended run row and outcome unknown', async () => {
  const ctx = await setup();
  try {
    await ctx.remote.task.create({ spec: 'warm the connection' }); // makes the remote a pipe client
    assert.ok(ctx.remote.client && ctx.remote.client.connected && !ctx.remote.owner);
    const seen = dropFirstReplies(ctx.host, ['run.end']);
    await assert.rejects(ctx.remote.run.end({ exit_reason: 'test' }), e => {
      assert.strictEqual(e.code, 'E_OWNER_LOST');
      assert.strictEqual(e.detail.outcome, 'unknown');
      assert.strictEqual(e.detail.sent, true);
      assert.strictEqual(e.detail.may_have_committed, true);
      return true;
    });
    assert.ok(seen.get('run.end'), 'the wrapper ran');
    const r = await ctx.host.run.get({});
    assert.strictEqual(r.epochs.filter(x => x.ended_at != null).length, 1, JSON.stringify(r.epochs));
  } finally { await teardown(ctx); }
});

test('task.create with no id whose reply is lost is not re-run; exactly one task row', async () => {
  const ctx = await setup();
  try {
    await ctx.remote.task.create({ spec: 'warm' });
    dropFirstReplies(ctx.host, ['task.create']);
    await assert.rejects(ctx.remote.task.create({ spec: 'lost reply' }), e => e.code === 'E_OWNER_LOST' && e.detail.outcome === 'unknown');
    const list = await ctx.host.task.list({});
    const rows = (list.tasks || list).filter(t => t.spec === 'lost reply');
    assert.strictEqual(rows.length, 1);
  } finally { await teardown(ctx); }
});

test('memory.store whose reply is lost is re-run, converges on one row and is flagged', async () => {
  const ctx = await setup();
  try {
    await ctx.remote.task.create({ spec: 'warm' });
    dropFirstReplies(ctx.host, ['memory.store']);
    const args = { namespace: 'rerun', text: 'same text', embedding: [1, 0], embedding_model: 'r', dim: 2 };
    const row = await ctx.remote.memory.store(args);
    assert.deepStrictEqual(row.rerun_after_owner_lost, { first_attempt: 'outcome unknown' });
    const found = await ctx.host.memory.list({ namespace: 'rerun' });
    const rows = found.rows || found.entries || found;
    assert.strictEqual(rows.length, 1, JSON.stringify(found));
  } finally { await teardown(ctx); }
});

test('a stub client rejecting sent: false is re-run once; one rejecting sent: true on worker.write is called once', async () => {
  const dir = sandbox();
  const c = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  try {
    let calls = 0;
    const stub = { connected: true, close: async () => {}, call: async () => { calls++; throw err('E_OWNER_LOST', 'stub', { sent: false }); } };
    c._ensureWriter = async () => { if (calls === 0) { c.client = stub; } else { c.client = { connected: true, close: async () => {}, call: async () => { calls++; return { ok: 'second' }; } }; } };
    const out = await c._write('worker.write', {});
    assert.deepStrictEqual(out, { ok: 'second' });
    assert.strictEqual(calls, 2);

    let sentCalls = 0;
    c._ensureWriter = async () => { c.client = { connected: true, close: async () => {}, call: async () => { sentCalls++; throw err('E_OWNER_LOST', 'stub', { sent: true, may_have_committed: true }); } }; };
    await assert.rejects(c._write('worker.write', {}), e => e.code === 'E_OWNER_LOST' && e.detail.outcome === 'unknown');
    assert.strictEqual(sentCalls, 1);
  } finally { cleanup(dir); }
});
