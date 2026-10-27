'use strict';
// ticket-bound.test.cjs — ADR 0045 decision 5 on a bound owner: ticket.issue is served only to a keyless operator claim that the operator
// check vouches for, never to a bound worker that claims the operator; ticket.redeem is served to the bound orchestrator of the run the
// ticket names. A real Owner over a real pipe in a sandbox, an injected operator check, a raw socket as the caller.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { core, sandbox, cleanup } = require('./helpers.cjs');

const { Owner } = core('owner.cjs');
const { claimBind } = core('bind.cjs');

const RUN = 'run-ticket';
const operatorCaller = { role: 'operator', run_id: RUN, pid: process.pid };

function rawCall(pipe, method, params, key) {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`no answer to ${method}`)); }, 8000);
    s.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.indexOf('\n') < 0) return;
      clearTimeout(timer); s.destroy();
      resolve(JSON.parse(buf.split('\n')[0]));
    });
    s.on('error', (e) => { clearTimeout(timer); reject(e); });
    s.on('connect', () => s.write(JSON.stringify({ id: 1, method, params, ...(key ? { key } : {}) }) + '\n'));
  });
}

test('bound owner: issue needs the operator check, redeem needs the run\'s bound orchestrator', async () => {
  const dir = sandbox();
  let verdict = { ok: false, reason: 'chain not intact' };
  const o = new Owner(dir, { embed: false, mode: 'bound', operatorCheck: async () => verdict });
  await o.start();
  try {
    const want = { run_id: RUN, worker_id: 'w1', verb: 'stop' };
    const refused = await rawCall(o.pipe, 'ticket.issue', { ...want, caller: operatorCaller });
    assert.strictEqual(refused.error && refused.error.code, 'E_UNBOUND', JSON.stringify(refused));
    assert.strictEqual(o.tickets.size(), 0);

    const worker = await claimBind((await o.bindCall('bind.open', { identity: { role: 'worker', run_id: RUN, worker_id: 'w1' } }, operatorCaller)).pipe);
    const forged = await rawCall(o.pipe, 'ticket.issue', { ...want, caller: operatorCaller }, worker.key);
    assert.strictEqual(forged.error && forged.error.code, 'E_ROLE', 'a bound worker is a worker, whatever it claims');

    verdict = { ok: true, via: 'peer' };
    const issued = await rawCall(o.pipe, 'ticket.issue', { ...want, caller: operatorCaller });
    assert.match(issued.result && issued.result.ticket, /^[0-9a-f]{48}$/, JSON.stringify(issued));

    const byWorker = await rawCall(o.pipe, 'ticket.redeem', { ticket: issued.result.ticket, worker_id: 'w1', verb: 'stop', caller: { role: 'orchestrator', run_id: RUN } }, worker.key);
    assert.strictEqual(byWorker.error && byWorker.error.code, 'E_ROLE');
    assert.notStrictEqual(byWorker.error.detail.reason, 'ticket', 'refused by role, so the ticket is still live');

    const orch = await claimBind((await o.bindCall('bind.open', { identity: { role: 'orchestrator', run_id: RUN } }, operatorCaller)).pipe);
    const ok = await rawCall(o.pipe, 'ticket.redeem', { ticket: issued.result.ticket, worker_id: 'w1', verb: 'stop', caller: {} }, orch.key);
    assert.strictEqual(ok.result && ok.result.redeemed, true, JSON.stringify(ok));
    const again = await rawCall(o.pipe, 'ticket.redeem', { ticket: issued.result.ticket, worker_id: 'w1', verb: 'stop', caller: {} }, orch.key);
    assert.strictEqual(again.error && again.error.detail.reason, 'ticket');
  } finally { await o.stop().catch(() => {}); cleanup(dir); }
});
