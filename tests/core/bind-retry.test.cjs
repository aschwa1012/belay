'use strict';
// bind-retry.test.cjs — a bind or ticket call whose socket was lost before it was handed to the pipe (E_OWNER_LOST, sent:false)
// is re-dialled once, as Core._write does (ADR 0033). The re-dial never elects: a finished run's store gets no stray owner.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup } = require('./helpers.cjs');
const { claimBind } = core('bind.cjs');
const { openCore } = core('index.cjs');

const RUN = 'run-bind-retry';
const operatorCaller = { role: 'operator', run_id: RUN, pid: process.pid };

// After the first _ensureWriter that returns with a connected client, run `hook` once: the window between "connected" and "sent".
function afterEnsureWriter(c, hook) {
  const real = c._ensureWriter.bind(c);
  let done = false;
  c._ensureWriter = async (m, o) => {
    await real(m, o);
    if (!done && c.client && c.client.connected) { done = true; await hook(); }
  };
}

async function setup() {
  const dir = sandbox();
  const op = await openCore({ dataDir: dir, caller: operatorCaller, embed: false });
  await op.becomeOwner();
  const ob = await op.bindOpen({ role: 'orchestrator', run_id: RUN });
  const claimed = await claimBind(ob.pipe);
  const orch = await openCore({ dataDir: dir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, key: claimed.key, embed: false });
  return { dir, op, orch };
}

async function end(ctx) {
  try { await ctx.orch.close(); } finally { try { await ctx.op.shutdownOwner(); } finally { await ctx.op.close(); cleanup(ctx.dir); } }
}

test('bindOpen whose socket drops between connect and send is re-dialled once and succeeds', async () => {
  const ctx = await setup();
  try {
    await ctx.orch.bindStatus('none').catch(() => {}); // connects the orchestrator Core's client
    afterEnsureWriter(ctx.orch, () => ctx.orch.client.sock.destroy());
    ctx.orch.client.sock.destroy();
    const wb = await ctx.orch.bindOpen({ role: 'worker', run_id: RUN, worker_id: 'w1' });
    assert.strictEqual(wb.caller.worker_id, 'w1');
  } finally { await end(ctx); }
});

test('ticketRedeem-path: a lost socket before send is re-dialled for bindRevoke too', async () => {
  const ctx = await setup();
  try {
    const wb = await ctx.orch.bindOpen({ role: 'worker', run_id: RUN, worker_id: 'w2' });
    ctx.orch.client.sock.destroy();
    afterEnsureWriter(ctx.orch, () => ctx.orch.client.sock.destroy());
    assert.strictEqual((await ctx.orch.bindRevoke(wb.bind_id)).state, 'revoked');
  } finally { await end(ctx); }
});

test('the re-dial never elects: with the owner gone the bind call fails and no owner.lock appears', async () => {
  const dir = sandbox();
  const op = await openCore({ dataDir: dir, caller: operatorCaller, embed: false });
  const remote = await openCore({ dataDir: dir, caller: operatorCaller, embed: false });
  try {
    await op.becomeOwner();
    await remote.run.get({});
    await remote.task.create({ spec: 'warm the remote client' }).catch(() => {});
    assert.ok(remote.client && !remote.owner, 'the remote is a pipe client');
    afterEnsureWriter(remote, async () => { remote.client.sock.destroy(); await op.shutdownOwner(); });
    await assert.rejects(remote.bindOpen({ role: 'orchestrator', run_id: RUN }), (e) => ['E_NO_OWNER', 'E_OWNER_LOST'].includes(e.code));
    assert.ok(!fs.existsSync(path.join(dir, 'owner.lock')), 'no stray owner.lock was left');
    assert.ok(!remote.isOwner(), 'the remote did not elect');
  } finally {
    await remote.close();
    await op.close();
    cleanup(dir);
  }
});
