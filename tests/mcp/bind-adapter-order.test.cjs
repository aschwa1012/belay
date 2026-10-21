'use strict';
// bind-adapter-order.test.cjs — ADR 0045 decision 2: the adapter claims its bind BEFORE it serves MCP. A bind server the test controls
// withholds its answer; `initialize` is sent at once and queued behind it. While the claim is pending the adapter must write no MCP
// byte, and once the claim fails it must write none at all. A mutant that starts serving before the claim answers `initialize` while
// the server still holds its reply, and both tests fail on that.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');

const { launch, sandboxDir } = require('./rpc.cjs');
const { bindPipeName } = require('../../src/core/lock.cjs');

const RUN = 'run-bind-order';

// A bind pipe whose reply the test releases. `seen` resolves when the adapter has connected (it is in claimBind, awaiting the line).
function controlledBind(data) {
  const name = bindPipeName(data, `order-${process.pid}-${Math.random().toString(16).slice(2, 8)}`);
  let seen; const connected = new Promise((r) => { seen = r; });
  let held = null;
  const server = net.createServer((s) => { held = s; seen(); });
  const listening = new Promise((r, j) => { server.once('error', j); server.listen(name, r); });
  return {
    name, connected, listening,
    release: (caller) => { held.end(JSON.stringify({ bind_id: 'b-order', key: 'k-order', caller }) + '\n'); },
    refuse: () => { held.end(); },
    close: () => new Promise((r) => { try { held && held.destroy(); } catch { /* gone */ } server.close(() => r()); }),
  };
}

// Every byte the adapter writes to stdout, counted at the socket (the Adapter helper consumes its own buffer as it parses lines).
const counted = (a) => { const c = { bytes: 0 }; a.child.stdout.on('data', (d) => { c.bytes += d.length; }); return c; };
const settle = (ms) => new Promise((r) => setTimeout(r, ms)); // a negative can only be watched for a while; the positive side waits on events

test('initialize that arrives while the claim is pending is not answered until the claim lands', { timeout: 60000 }, async (t) => {
  const data = sandboxDir('bind-order');
  const bind = controlledBind(data);
  await bind.listening;
  const a = launch({ role: 'worker', run: RUN, workerId: 'w-order', data, extra: ['--bind', bind.name] });
  try {
    const out = counted(a);
    const init = a.initialize(); // written to the adapter's stdin before it can have claimed anything
    await bind.connected; // the adapter is inside claimBind now
    await settle(600);
    assert.strictEqual(out.bytes, 0, 'the adapter answered while its claim was pending: it served MCP before the bind landed');
    assert.strictEqual(a.exitCode, undefined);
    bind.release({ role: 'worker', run_id: RUN, worker_id: 'w-order' });
    const r = await init;
    assert.ok(r.result && r.result.serverInfo, `no initialize result after the claim: ${JSON.stringify(r)}`);
  } finally { await a.close(1500); a.kill(); await bind.close(); t.after(() => { try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* temp sweep */ } }); }
});

test('initialize queued behind a claim that fails is never answered: exit 3 and no MCP byte', { timeout: 60000 }, async (t) => {
  const data = sandboxDir('bind-order');
  const bind = controlledBind(data);
  await bind.listening;
  const a = launch({ role: 'worker', run: RUN, workerId: 'w-order2', data, extra: ['--bind', bind.name] });
  try {
    const out = counted(a);
    a.initialize().catch(() => {}); // queued; the adapter dies before it can answer
    await bind.connected;
    await settle(300);
    assert.strictEqual(out.bytes, 0, 'answered before the claim failed');
    bind.refuse();
    const exit = await a.exited;
    assert.strictEqual(exit.code, 3);
    assert.strictEqual(out.bytes, 0, 'a byte of MCP was written by an adapter whose claim failed');
  } finally { await a.close(1500); a.kill(); await bind.close(); t.after(() => { try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* temp sweep */ } }); }
});

test('control: the same pending claim, released for the wrong identity, still ends the adapter before it answers', { timeout: 60000 }, async (t) => {
  const data = sandboxDir('bind-order');
  const bind = controlledBind(data);
  await bind.listening;
  const a = launch({ role: 'worker', run: RUN, workerId: 'w-order3', data, extra: ['--bind', bind.name] });
  try {
    const out = counted(a);
    a.initialize().catch(() => {});
    await bind.connected;
    bind.release({ role: 'worker', run_id: RUN, worker_id: 'someone-else' });
    const exit = await a.exited;
    assert.strictEqual(exit.code, 3);
    assert.strictEqual(out.bytes, 0);
  } finally { await a.close(1500); a.kill(); await bind.close(); t.after(() => { try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* temp sweep */ } }); }
});
