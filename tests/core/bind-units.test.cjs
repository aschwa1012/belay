'use strict';
// bind-units.test.cjs — ADR 0045 decision 2, the small rules each on its own so a one-line change to any of them fails fast:
// the identity a bind may carry, the claim line the adapter accepts, the cross-check against its argv, and a bind that does not
// expire (the interactive orchestrator's, whose MCP server starts only after the trust dialog is answered).

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Owner } = core('owner.cjs');
const { claimBind, identityOf, identityMatchesArgv } = core('bind.cjs');
const { bindPipeName } = core('lock.cjs');

const RUN = 'run-units';
const UNITS_DIR = require('node:path').join(require('node:os').tmpdir(), 'belay-bind-units-pipes'); // only hashed into a pipe name; nothing is created there
const operatorCaller = { role: 'operator', run_id: RUN, pid: process.pid };
const orchestratorCaller = { role: 'orchestrator', run_id: RUN, pid: process.pid };

test('identityOf: a worker bind needs a worker id, an orchestrator bind refuses one, and role and run id are each required', () => {
  const code = (raw) => { try { identityOf(raw); return null; } catch (e) { return e.code + ':' + e.detail.field; } };
  assert.deepStrictEqual(identityOf({ role: 'worker', run_id: 'r', worker_id: 'w' }), { role: 'worker', run_id: 'r', worker_id: 'w' });
  assert.deepStrictEqual(identityOf({ role: 'orchestrator', run_id: 'r' }), { role: 'orchestrator', run_id: 'r' });
  assert.strictEqual(code({ role: 'operator', run_id: 'r' }), 'E_ARGS:role');
  assert.strictEqual(code({ run_id: 'r', worker_id: 'w' }), 'E_ARGS:role');
  assert.strictEqual(code({ role: 'worker', worker_id: 'w' }), 'E_ARGS:run_id');
  assert.strictEqual(code({ role: 'orchestrator', run_id: '' }), 'E_ARGS:run_id');
  assert.strictEqual(code({ role: 'worker', run_id: 'r' }), 'E_ARGS:worker_id');
  assert.strictEqual(code({ role: 'orchestrator', run_id: 'r', worker_id: 'w' }), 'E_ARGS:worker_id', 'a worker id on an orchestrator bind');
  assert.strictEqual(code(null), 'E_ARGS:role');
});

test('identityMatchesArgv: role, run id and worker id each have to agree', () => {
  const argv = { role: 'worker', runId: 'r', workerId: 'w' };
  assert.strictEqual(identityMatchesArgv({ role: 'worker', run_id: 'r', worker_id: 'w' }, argv), true);
  assert.strictEqual(identityMatchesArgv({ role: 'orchestrator', run_id: 'r', worker_id: 'w' }, argv), false, 'role alone');
  assert.strictEqual(identityMatchesArgv({ role: 'worker', run_id: 'other', worker_id: 'w' }, argv), false, 'run id alone');
  assert.strictEqual(identityMatchesArgv({ role: 'worker', run_id: 'r', worker_id: 'x' }, argv), false, 'worker id alone');
  assert.strictEqual(identityMatchesArgv({ role: 'worker', run_id: 'r' }, argv), false, 'no worker id on a worker adapter');
  assert.strictEqual(identityMatchesArgv({ role: 'orchestrator', run_id: 'r' }, { role: 'orchestrator', runId: 'r' }), true);
  assert.strictEqual(identityMatchesArgv({ role: 'orchestrator', run_id: 'r', worker_id: 'w' }, { role: 'orchestrator', runId: 'r' }), false, 'a worker id on an orchestrator adapter');
  assert.strictEqual(identityMatchesArgv(null, argv), false);
});

// A listener that answers a claim with one chosen line, then ends.
function lineServer(line) {
  const name = bindPipeName(UNITS_DIR, 'units-' + Math.random().toString(16).slice(2));
  return new Promise((resolve) => {
    const server = net.createServer((s) => { s.end(line); server.close(); });
    server.listen(name, () => resolve(name));
  });
}

test('claimBind: a line with no key, a key that is not a string, no caller or no JSON is E_BIND; a whole line resolves', async () => {
  const bad = [JSON.stringify({ bind_id: 'b', caller: { role: 'worker' } }) + '\n', JSON.stringify({ key: 7, caller: { role: 'worker' } }) + '\n', JSON.stringify({ key: 'k' }) + '\n', 'not json\n'];
  for (const line of bad) {
    await assert.rejects(claimBind(await lineServer(line), { timeoutMs: 3000 }), (e) => e.code === 'E_BIND', `refused: ${line.trim()}`);
  }
  const ok = await claimBind(await lineServer(JSON.stringify({ bind_id: 'b', key: 'k'.repeat(64), caller: { role: 'worker', run_id: 'r', worker_id: 'w' } }) + '\n'), { timeoutMs: 3000 });
  assert.strictEqual(ok.key, 'k'.repeat(64));
});

test('an unclaimed bind expires at its ttl, bounded; one opened with no_expiry outlives it, is operator-only, and is revoked when the owner stops', async () => {
  const dir = sandbox();
  const o = new Owner(dir, { embed: false, bindTtlMs: 120 });
  await o.start();
  try {
    const ident = { role: 'orchestrator', run_id: RUN };
    const timed = await o.bindCall('bind.open', { identity: ident }, operatorCaller);
    const lasting = await o.bindCall('bind.open', { identity: ident, no_expiry: true }, operatorCaller);
    assert.strictEqual(timed.expires_in_ms, 120);
    assert.strictEqual(lasting.expires_in_ms, null);
    let state = null;
    for (let i = 0; i < 100 && state !== 'expired'; i++) { await new Promise((r) => setTimeout(r, 50)); state = (await o.bindCall('bind.status', { bind_id: timed.bind_id }, operatorCaller)).state; }
    assert.strictEqual(state, 'expired', 'the timed bind expired within 5 s');
    assert.strictEqual((await o.bindCall('bind.status', { bind_id: lasting.bind_id }, operatorCaller)).state, 'open', 'the lasting bind is still open well past the ttl');
    const claimed = await claimBind(lasting.pipe, { timeoutMs: 3000 });
    assert.strictEqual(claimed.caller.role, 'orchestrator', 'and still claimable');
    const forged = await o.bindCall('bind.open', { identity: { role: 'worker', run_id: RUN, worker_id: 'w1' }, no_expiry: true }, orchestratorCaller).then(() => null, (e) => e);
    assert.strictEqual(forged && forged.code, 'E_ROLE', 'an orchestrator cannot open a bind that never expires');
    const bad = await o.bindCall('bind.open', { identity: ident, no_expiry: 'yes' }, operatorCaller).then(() => null, (e) => e);
    assert.strictEqual(bad && bad.code, 'E_ARGS');
    await o.stop();
    assert.strictEqual(o.binds.lookup(claimed.key), null, 'stopping the owner revoked it');
  } finally { await o.stop().catch(() => {}); cleanup(dir); }
});
