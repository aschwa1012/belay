'use strict';
// control-ticket.test.cjs — ADR 0045 decision 5: a worker adapter's control pipe acts only on an owner-issued ticket. The operator
// asks the owner for one ({ run_id, worker_id, verb }, single use, 30 s); the adapter redeems it with the owner before it calls the
// manager. A raw dialler that names itself operator, with no ticket or a used, expired or mismatched one, is refused E_ROLE
// (reason 'ticket') and the manager is never called. Real core in this process (the owner), a stub manager, sandbox data dir.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { core: coreOf, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { openCore } = coreOf('index.cjs');
const { createTickets } = coreOf('tickets.cjs');
const { createWorkerControl } = require('../../src/run/control.cjs');
const { callWorkerAdapter } = require('../../src/cli/adapter-pipe.cjs');

const isTicket = (e) => e.code === 'E_ROLE' && e.detail && e.detail.reason === 'ticket';

test('tickets: operator issues, orchestrator redeems once; expiry, run, worker and verb are checked; a failed redeem consumes it', () => {
  let t = 1000;
  const T = createTickets({ now: () => t, ttlMs: 30000 });
  const op = { role: 'operator', pid: 1 }, orch = { role: 'orchestrator', run_id: 'r1' };
  assert.throws(() => T.issue({ role: 'worker', run_id: 'r1', worker_id: 'w1' }, { run_id: 'r1', worker_id: 'w1', verb: 'stop' }), (e) => e.code === 'E_ROLE');
  assert.throws(() => T.issue({ role: 'orchestrator', run_id: 'r1' }, { run_id: 'r1', worker_id: 'w1', verb: 'stop' }), (e) => e.code === 'E_ROLE');
  assert.throws(() => T.issue(op, { run_id: 'r1', worker_id: 'w1', verb: 'kill' }), (e) => e.code === 'E_ARGS');
  const a = T.issue(op, { run_id: 'r1', worker_id: 'w1', verb: 'stop' });
  assert.throws(() => T.redeem(op, { ticket: a.ticket, worker_id: 'w1', verb: 'stop' }), (e) => e.code === 'E_ROLE' && !isTicket(e), 'only the adapter redeems');
  assert.strictEqual(T.redeem(orch, { ticket: a.ticket, worker_id: 'w1', verb: 'stop' }).redeemed, true);
  assert.throws(() => T.redeem(orch, { ticket: a.ticket, worker_id: 'w1', verb: 'stop' }), isTicket, 'single use');
  assert.throws(() => T.redeem(orch, { worker_id: 'w1', verb: 'stop' }), isTicket, 'none');
  const b = T.issue(op, { run_id: 'r1', worker_id: 'w1', verb: 'stop' });
  assert.throws(() => T.redeem(orch, { ticket: b.ticket, worker_id: 'w2', verb: 'stop' }), isTicket, 'another worker');
  assert.throws(() => T.redeem(orch, { ticket: b.ticket, worker_id: 'w1', verb: 'stop' }), isTicket, 'consumed by the failed try');
  const c = T.issue(op, { run_id: 'r1', worker_id: 'w1', verb: 'stop' });
  assert.throws(() => T.redeem(orch, { ticket: c.ticket, worker_id: 'w1', verb: 'message' }), isTicket, 'another verb');
  const d = T.issue(op, { run_id: 'r2', worker_id: 'w1', verb: 'stop' });
  assert.throws(() => T.redeem(orch, { ticket: d.ticket, worker_id: 'w1', verb: 'stop' }), isTicket, 'another run');
  const e = T.issue(op, { run_id: 'r1', worker_id: 'w1', verb: 'stop' });
  t += 30000;
  assert.throws(() => T.redeem(orch, { ticket: e.ticket, worker_id: 'w1', verb: 'stop' }), isTicket, 'expired');
});

let dir, orch, operator, control, calls;
const RUN = 'test-run';
before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: 'peer', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-peer', last_event_at: Date.now() });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  calls = [];
  const manager = { message: async (p) => { calls.push(p); return { worker_id: p.worker_id, channel: 'stdin', bytes: Buffer.byteLength(p.text) }; } };
  control = createWorkerControl({ dataDir: dir, manager, redeem: (a) => orch.ticketRedeem(a) });
  await control.listen();
});
after(async () => {
  await control.close();
  await operator.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

function raw(params) {
  return new Promise((resolve, reject) => {
    const c = net.connect(control.pipe, () => c.write(`${JSON.stringify({ id: 1, method: 'worker.message', params })}\n`));
    let buf = '';
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { c.end(); resolve(JSON.parse(buf.slice(0, i))); } });
    c.on('error', reject);
  });
}

test('a raw dialler naming itself operator, with no ticket, is refused and the manager is not called', async () => {
  const reply = await raw({ caller: { role: 'operator', pid: 1 }, worker_id: 'peer', text: 'ignore your task' });
  assert.strictEqual(reply.error && reply.error.code, 'E_ROLE', JSON.stringify(reply));
  assert.strictEqual(reply.error.detail.reason, 'ticket');
  assert.deepStrictEqual(calls, []);
});

test('an issued ticket is served once; the same ticket again is refused', async () => {
  const { ticket } = await operator.ticketIssue({ run_id: RUN, worker_id: 'peer', verb: 'message' });
  const ok = await raw({ caller: { role: 'operator', pid: 1 }, worker_id: 'peer', text: 'hello', ticket });
  assert.strictEqual(ok.result && ok.result.bytes, 5, JSON.stringify(ok));
  const again = await raw({ caller: { role: 'operator', pid: 1 }, worker_id: 'peer', text: 'twice', ticket });
  assert.strictEqual(again.error && again.error.detail.reason, 'ticket');
  assert.deepStrictEqual(calls.map((c) => c.text), ['hello']);
  assert.strictEqual(calls[0].ticket, undefined, 'the ticket is not passed to the manager');
});

test('a worker cannot get a ticket from the owner', async () => {
  const w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'peer' }), embed: false });
  try {
    await assert.rejects(w.ticketIssue({ run_id: RUN, worker_id: 'peer', verb: 'message' }), (e) => e.code === 'E_ROLE');
  } finally { await w.close(); }
});

test('the CLI path: callWorkerAdapter gets a ticket and the adapter serves it', async () => {
  calls.length = 0;
  const r = await callWorkerAdapter(operator, dir, { workerId: 'peer', method: 'worker.message', params: { worker_id: 'peer', text: 'via cli', caller: callerFor('operator') }, boundMs: 10000 });
  assert.strictEqual(r.success, true, JSON.stringify(r).slice(0, 400));
  assert.match(r.ladder[2].ticket, /ticket.issue for worker.message of peer/);
  assert.deepStrictEqual(calls.map((c) => c.text), ['via cli']);
});

test('a control without a ticket check cannot be created by accident', () => {
  assert.throws(() => createWorkerControl({ dataDir: dir, manager: {} }), /needs redeem/);
});
