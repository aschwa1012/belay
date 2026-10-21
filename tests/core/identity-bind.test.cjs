'use strict';
// identity-bind.test.cjs — ADR 0045 decisions 2 and 3 (proposed): a spawned adapter is bound, not believed. The owner takes the
// caller of a keyed request from the bind, never from the request, so a worker that sends `role: operator` over the pipe is still
// the worker; an owner serving `bound` refuses an unkeyed write. A real Owner over a real pipe in a sandbox, a raw socket as the
// forger. The forgery each test attempts is the one the audit reproduced (D06): a request that names a role it was not given.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Owner } = core('owner.cjs');
const { claimBind } = core('bind.cjs');

const RUN = 'run-bind';

// One request/response over a fresh connection to the owner's pipe, the way a hostile same-user process would send it.
function rawCall(pipe, method, params, key) {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`no answer to ${method}`)); }, 8000);
    s.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.indexOf('\n') < 0) return;
      clearTimeout(timer); s.destroy();
      const m = JSON.parse(buf.split('\n')[0]);
      resolve(m);
    });
    s.on('error', (e) => { clearTimeout(timer); reject(e); });
    s.on('connect', () => s.write(JSON.stringify({ id: 1, method, params, ...(key ? { key } : {}) }) + '\n'));
  });
}

async function withOwner(opts, fn) {
  const dir = sandbox();
  const o = new Owner(dir, { embed: false, ...opts });
  await o.start();
  try { return await fn(o, dir); } finally { await o.stop().catch(() => {}); cleanup(dir); }
}

const operatorCaller = { role: 'operator', run_id: RUN, pid: process.pid };
const workerBind = async (o, id = 'w1') => {
  const opened = await o.bindCall('bind.open', { identity: { role: 'worker', run_id: RUN, worker_id: id } }, operatorCaller);
  return { opened, claimed: await claimBind(opened.pipe) };
};

test('a keyed request runs as the bound identity: a worker that claims the operator is still a worker', async () => {
  await withOwner({}, async (o) => {
    const { claimed } = await workerBind(o);
    const forged = { role: 'operator', run_id: RUN, pid: process.pid };
    // the privileged verbs a forging worker wants: refused by role, with the owner still serving afterwards
    for (const [method, params] of [['worker.forget', { worker_id: 'w1' }], ['run.end', {}], ['shutdown', {}]]) {
      const r = await rawCall(o.pipe, method, { ...params, caller: forged }, claimed.key);
      assert.strictEqual(r.error && r.error.code, 'E_ROLE', `${method}: ${JSON.stringify(r)}`);
    }
    assert.strictEqual((await rawCall(o.pipe, 'ping', {})).result.pid, process.pid, 'the forged shutdown did not stop the owner');
    // a memory row it writes records the worker, not the operator or the harness
    const w = await rawCall(o.pipe, 'memory.store', { text: 'forged provenance', embed: false, caller: { ...forged, channel: 'tool' } }, claimed.key);
    assert.strictEqual(w.result.written_by, 'worker:w1');
  });
});

test('mutation guard: the same forgery WITHOUT a key on a claimed owner is believed (the limit ADR 0012 decision 3 states)', async () => {
  await withOwner({}, async (o) => {
    const forged = { role: 'operator', run_id: RUN, pid: process.pid, channel: 'harness' };
    const w = await rawCall(o.pipe, 'memory.store', { text: 'forged without a key', embed: false, caller: forged });
    assert.strictEqual(w.result.written_by, 'harness', 'a claimed owner believes an unkeyed caller; only a bind or bound mode changes that');
  });
});

test('a keyed worker cannot claim the harness channel; an orchestrator bind can, a worker bind carries no other role', async () => {
  await withOwner({}, async (o) => {
    const { claimed } = await workerBind(o);
    const r = await rawCall(o.pipe, 'memory.store', { text: 'x', embed: false, caller: { role: 'worker', worker_id: 'w1', run_id: RUN, channel: 'harness' } }, claimed.key);
    assert.strictEqual(r.error && r.error.code, 'E_UNBOUND');
    assert.strictEqual(r.error.detail.reason, 'channel');
    const ob = await claimBind((await o.bindCall('bind.open', { identity: { role: 'orchestrator', run_id: RUN } }, operatorCaller)).pipe);
    const h = await rawCall(o.pipe, 'memory.store', { text: 'run manager row', embed: false, caller: { role: 'worker', worker_id: 'w1', run_id: RUN, channel: 'harness' } }, ob.key);
    assert.strictEqual(h.result.written_by, 'harness', 'the orchestrator bind admits the channel, and the role it runs as is the bind\'s, not the request\'s');
  });
});

test('a bind is claimed exactly once, and a key this owner does not hold is refused E_UNBOUND', async () => {
  await withOwner({}, async (o) => {
    const { opened } = await workerBind(o);
    await assert.rejects(claimBind(opened.pipe, { timeoutMs: 3000 }), (e) => e.code === 'E_BIND', 'a second dial finds no listener');
    const r = await rawCall(o.pipe, 'memory.store', { text: 'x', embed: false, caller: operatorCaller }, 'f'.repeat(64));
    assert.strictEqual(r.error && r.error.code, 'E_UNBOUND');
    assert.strictEqual(r.error.detail.reason, 'key');
  });
});

test('revoking a bind ends its key at once, and an owner that stops takes every key with it', async () => {
  await withOwner({}, async (o) => {
    const { opened, claimed } = await workerBind(o);
    const live = await rawCall(o.pipe, 'memory.store', { text: 'before', embed: false, caller: { role: 'worker', run_id: RUN, worker_id: 'w1' } }, claimed.key);
    assert.ok(live.result.id);
    const st = await o.bindCall('bind.status', { bind_id: opened.bind_id }, operatorCaller);
    assert.strictEqual(st.claimed, true);
    const rv = await o.bindCall('bind.revoke', { bind_id: opened.bind_id }, operatorCaller);
    assert.deepStrictEqual([rv.was, rv.state], ['claimed', 'revoked']);
    const after = await rawCall(o.pipe, 'memory.store', { text: 'after', embed: false, caller: operatorCaller }, claimed.key);
    assert.strictEqual(after.error && after.error.code, 'E_UNBOUND');
    const { claimed: second } = await workerBind(o, 'w2');
    await o.stop();
    assert.strictEqual(o.binds.lookup(second.key), null, 'stopping the owner closed its binds');
  });
});

test('an unclaimed bind expires, and its pipe stops listening', async () => {
  await withOwner({ bindTtlMs: 150 }, async (o) => {
    const { opened } = await workerBind(o).then(() => o.bindCall('bind.open', { identity: { role: 'worker', run_id: RUN, worker_id: 'w9' } }, operatorCaller)).then((opened) => ({ opened }));
    await new Promise((r) => setTimeout(r, 400));
    const st = await o.bindCall('bind.status', { bind_id: opened.bind_id }, operatorCaller);
    assert.strictEqual(st.state, 'expired');
    await assert.rejects(claimBind(opened.pipe, { timeoutMs: 2000 }), (e) => e.code === 'E_BIND');
  });
});

test('bind.open is gated: a bound worker is refused, an orchestrator binds only a worker of its own run, the pipe carries the same gate', async () => {
  await withOwner({}, async (o) => {
    const { claimed } = await workerBind(o);
    const ask = (key, identity, caller) => rawCall(o.pipe, 'bind.open', { identity, caller }, key);
    // a worker, even one claiming the operator, is the worker: E_ROLE
    const asWorker = await ask(claimed.key, { role: 'orchestrator', run_id: RUN }, { role: 'operator', run_id: RUN });
    assert.strictEqual(asWorker.error && asWorker.error.code, 'E_ROLE');
    const ob = await claimBind((await o.bindCall('bind.open', { identity: { role: 'orchestrator', run_id: RUN } }, operatorCaller)).pipe);
    const okay = await ask(ob.key, { role: 'worker', run_id: RUN, worker_id: 'w5' }, {});
    assert.ok(okay.result && okay.result.pipe, JSON.stringify(okay));
    for (const identity of [{ role: 'worker', run_id: 'another-run', worker_id: 'w6' }, { role: 'orchestrator', run_id: RUN }]) {
      const bad = await ask(ob.key, identity, {});
      assert.strictEqual(bad.error && bad.error.code, 'E_ROLE', JSON.stringify(identity));
    }
    // and it cannot read or revoke a bind of another run
    const other = await o.bindCall('bind.open', { identity: { role: 'worker', run_id: 'another-run', worker_id: 'w7' } }, operatorCaller);
    const peek = await rawCall(o.pipe, 'bind.revoke', { bind_id: other.bind_id, caller: {} }, ob.key);
    assert.strictEqual(peek.error && peek.error.code, 'E_ROLE');
  });
});

test('bound mode: an unkeyed write is refused E_UNBOUND, an unkeyed read is served as anonymous, a bound caller works', async () => {
  await withOwner({ mode: 'bound' }, async (o) => {
    const forged = { role: 'operator', run_id: RUN, pid: process.pid };
    for (const [method, params] of [['memory.store', { text: 'x', embed: false }], ['shutdown', {}], ['run.stop', {}], ['bind.open', { identity: { role: 'worker', run_id: RUN, worker_id: 'w1' } }]]) {
      const r = await rawCall(o.pipe, method, { ...params, caller: forged });
      assert.strictEqual(r.error && r.error.code, 'E_UNBOUND', `${method}: ${JSON.stringify(r)}`);
    }
    const asOrch = await rawCall(o.pipe, 'memory.store', { text: 'x', embed: false, caller: { role: 'orchestrator', run_id: RUN } });
    assert.strictEqual(asOrch.error && asOrch.error.code, 'E_UNBOUND');
    assert.strictEqual((await rawCall(o.pipe, 'ping', {})).result.pid, process.pid);
    const read = await rawCall(o.pipe, 'status.get', { caller: forged });
    assert.ok(read.result, `an unkeyed read answers: ${JSON.stringify(read)}`);
    const { claimed } = await workerBind(o);
    const w = await rawCall(o.pipe, 'memory.store', { text: 'bound write', embed: false, caller: forged }, claimed.key);
    assert.strictEqual(w.result.written_by, 'worker:w1');
    assert.strictEqual((await rawCall(o.pipe, 'ping', {})).result.pid, process.pid, 'no forged shutdown stopped it');
  });
});

test('bound mode with an operator check: the check vouches for the connection or the claim is refused; it never runs for a keyed call', async () => {
  const seen = [];
  let verdict = { ok: true, via: 'peer' };
  await withOwner({ mode: 'bound', operatorCheck: async (info) => { seen.push(info.method); return verdict; } }, async (o) => {
    const claim = { role: 'operator', run_id: RUN, pid: process.pid };
    const ok = await rawCall(o.pipe, 'memory.store', { text: 'operator typed', embed: false, caller: claim });
    assert.strictEqual(ok.result.written_by, 'operator');
    verdict = { ok: false, reason: 'chain not intact' };
    const no = await rawCall(o.pipe, 'memory.store', { text: 'refused', embed: false, caller: claim });
    assert.strictEqual(no.error && no.error.code, 'E_UNBOUND');
    assert.match(no.error.message, /chain not intact/);
    verdict = { ok: true };
    const { claimed } = await workerBind(o);
    await rawCall(o.pipe, 'memory.store', { text: 'keyed', embed: false, caller: claim }, claimed.key);
    assert.deepStrictEqual(seen, ['memory.store', 'memory.store'], 'the check ran for the two unkeyed claims only');
  });
  // an owner left to its own check (a Windows owner builds one) refuses an operator claim that arrives on the pipe: the pipe cannot
  // show who dialled, so the claim has to come in on the loopback port (tests/core/operator-check.test.cjs drives that path)
  await withOwner({ mode: 'bound' }, async (o) => {
    const r = await rawCall(o.pipe, 'memory.store', { text: 'x', embed: false, caller: { role: 'operator', run_id: RUN } });
    assert.strictEqual(r.error && r.error.code, 'E_UNBOUND');
    assert.match(r.error.detail.reason, /^(operator_check|unverifiable)$/);
    assert.match(r.error.message, /loopback port|no check/);
  });
});

test('Core: the run process binds in process, a keyed orchestrator Core binds only its own run\'s workers over the pipe, and a keyed Core never elects', async () => {
  const { openCore } = core('index.cjs');
  const dir = sandbox();
  const op = await openCore({ dataDir: dir, caller: operatorCaller, embed: false });
  const cleanupAll = [];
  try {
    await op.becomeOwner();
    assert.ok(op.isOwner());
    const ob = await op.bindOpen({ role: 'orchestrator', run_id: RUN });
    const claimedOrch = await claimBind(ob.pipe);
    const orch = await openCore({ dataDir: dir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, key: claimedOrch.key, embed: false });
    cleanupAll.push(orch);
    const wb = await orch.bindOpen({ role: 'worker', run_id: RUN, worker_id: 'w1' });
    assert.deepStrictEqual(wb.caller, { role: 'worker', run_id: RUN, worker_id: 'w1' });
    await assert.rejects(orch.bindOpen({ role: 'worker', run_id: 'someone-else', worker_id: 'w1' }), (e) => e.code === 'E_ROLE');
    assert.strictEqual((await orch.bindStatus(wb.bind_id)).claimed, false);
    assert.strictEqual((await orch.bindRevoke(wb.bind_id)).state, 'revoked');

    // a keyed worker Core is the worker, so it cannot ask for a bind at all
    const w2 = await op.bindOpen({ role: 'worker', run_id: RUN, worker_id: 'w2' });
    const worker = await openCore({ dataDir: dir, caller: { role: 'worker', run_id: RUN, worker_id: 'w2', pid: process.pid }, key: (await claimBind(w2.pipe)).key, embed: false });
    cleanupAll.push(worker);
    await assert.rejects(worker.bindOpen({ role: 'worker', run_id: RUN, worker_id: 'w3' }), (e) => e.code === 'E_ROLE');

    // the owner goes away: a keyed Core does not elect a stray owner to carry on, it fails
    await op.shutdownOwner();
    await assert.rejects(orch.task.create({ spec: 'the call the owner was lost on' }), (e) => e.code === 'E_OWNER_LOST' || e.code === 'E_NO_OWNER');
    await assert.rejects(orch.task.create({ spec: 'after the owner is gone' }), (e) => e.code === 'E_NO_OWNER');
    assert.ok(!orch.isOwner(), 'the unbound-by-election path did not make this adapter a stray owner');
  } finally {
    for (const c of cleanupAll) await c.close().catch(() => {});
    await op.shutdownOwner().catch(() => {}); await op.close().catch(() => {});
    cleanup(dir);
  }
});

test('two processes dialling one bind at the same moment: exactly one is handed the key', async () => {
  await withOwner({}, async (o) => {
    for (let round = 0; round < 5; round++) {
      const opened = await o.bindCall('bind.open', { identity: { role: 'worker', run_id: RUN, worker_id: `race-${round}` } }, operatorCaller);
      const results = await Promise.allSettled([claimBind(opened.pipe, { timeoutMs: 3000 }), claimBind(opened.pipe, { timeoutMs: 3000 }), claimBind(opened.pipe, { timeoutMs: 3000 })]);
      const won = results.filter((r) => r.status === 'fulfilled');
      assert.strictEqual(won.length, 1, `round ${round}: ${results.map((r) => r.status).join(',')}`);
    }
  });
});
