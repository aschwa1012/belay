'use strict';
// task.evaluate writes nothing over a task that was assigned again while its acceptance commands ran.
// The command connects to a server the test owns and exits 0 only when the test writes to it, so the
// re-assignment lands inside the run without a sleep.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { openCore } = core('index.cjs');

let dir, orch, w1, w2, server, port;
let onConn = null;
before(async () => {
  dir = sandbox();
  server = net.createServer((s) => { s.on('error', () => {}); if (onConn) onConn(s); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  for (const id of ['w1', 'w2']) await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now() });
  w1 = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w1' }), embed: false });
  w2 = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: 'w2' }), embed: false });
});
after(async () => {
  server.close();
  await w1.close(); await w2.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

test('a re-assign during the acceptance run is not overwritten by done; the new holder can hand back', async () => {
  const script = "const s=require('net').connect(Number(process.argv[1]),'127.0.0.1');s.on('data',()=>process.exit(0));";
  const t = await orch.task.create({ spec: 'reassign', acceptance: { commands: [{ argv: [process.execPath, '-e', script, String(port)], timeout_ms: 60000 }] } });
  const a1 = await orch.task.assign({ task_id: t.id, worker_id: 'w1' });
  await w1.lease.release({ lease_id: a1.new_lease.id, reason: 'done', result: { summary: 'first hand-back' } });
  const connected = new Promise((r) => { onConn = r; });
  const ev = orch.task.evaluate({ task_id: t.id, worktree: dir });
  const evOutcome = ev.then((row) => ({ row }), (e) => ({ e }));
  const sock = await connected; // the command is running
  const a2 = await orch.task.assign({ task_id: t.id, worker_id: 'w2' });
  sock.write('go');
  const out = await evOutcome;
  assert.ok(out.e, 'the evaluation is refused');
  assert.strictEqual(out.e.code, 'E_BUSY');
  const after = await orch.task.get({ task_id: t.id });
  assert.strictEqual(after.state, 'assigned');
  await w2.lease.release({ lease_id: a2.new_lease.id, reason: 'done', result: { summary: 'second hand-back' } });
});
