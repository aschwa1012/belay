'use strict';
// worker-write-run.test.cjs — an orchestrator writes the worker rows of its own run only (audit 0.3.1 P6). Before the fix
// worker.write merged over any row the orchestrator named, so the orchestrator of run A could rewrite (stop, kill, re-pid) a
// worker of a live run B, or move it with an explicit run_id. Adoption of a worker whose run has ended still works; the operator's harness channel keeps its own guard.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { openCore } = core('index.cjs');

let dir;
const cores = [];
const open = async (runId, role = 'orchestrator') => {
  const c = await openCore({ dataDir: dir, caller: callerFor(role, { run_id: runId }), embed: false });
  cores.push(c);
  return c;
};
const live = async (runId) => { const c = await open(runId); await c.run.attach({ adapter_pid: process.pid }); return c; };
const row = (id, extra = {}) => ({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now(), ...extra });
const code = (want) => (e) => { assert.strictEqual(e.code, want, e.message); return true; };

before(() => { dir = sandbox(); });
after(async () => {
  for (const c of cores.slice(1)) await c.close();
  await cores[0].shutdownOwner();
  await cores[0].close();
  cleanup(dir);
});

test('the orchestrator of one live run may not write a worker row of another live run', async () => {
  const a = await live('ww-a');
  const b = await live('ww-b');
  const mine = await b.worker.write(row('w-ww-b'));
  await assert.rejects(a.worker.write({ id: 'w-ww-b', state: 'dead' }), (e) => { code('E_ROLE')(e); assert.strictEqual(e.detail.worker_run_id, 'ww-b'); return true; });
  await assert.rejects(a.worker.write(row('w-ww-b', { run_id: 'ww-a' })), code('E_ROLE'));
  const now = await b.worker.get({ worker_id: 'w-ww-b' });
  assert.strictEqual(now.seq, mine.seq, 'nothing was written');
});

test('an orchestrator may not name another run on a row it writes', async () => {
  const a = await live('ww-c');
  await assert.rejects(a.worker.write(row('w-ww-new', { run_id: 'ww-elsewhere' })), (e) => { code('E_ROLE')(e); assert.strictEqual(e.detail.named_run_id, 'ww-elsewhere'); return true; });
  const own = await a.worker.write(row('w-ww-own', { run_id: 'ww-c' }));
  assert.strictEqual(own.run_id, 'ww-c', 'naming its own run is fine');
});

test('a worker whose run has ended is adopted into the writing orchestrator\'s run', async () => {
  const old = await live('ww-old');
  await old.worker.write(row('w-ww-adopt'));
  await old.run.end({ exit_reason: 'test' });
  const now = await live('ww-now');
  const adopted = await now.worker.write(row('w-ww-adopt', { run_id: 'ww-now' }));
  assert.strictEqual(adopted.run_id, 'ww-now');
});
