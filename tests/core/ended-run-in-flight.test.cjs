'use strict';
// ended-run-in-flight.test.cjs — a write already in flight when its run ends is refused too (audit D42). Dispatch checks
// the ended run once, before the method; task.evaluate (acceptance commands), lease.release with notes (embedding) and
// memory.store with an embedding await before they write, so each checks again in the same tick as its write. Every wait
// is a gate the test opens, never a clock: the embedder waits on a promise, the acceptance command on a file.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E, gate, openGate, waiting;
const RUN = 'r-flight';
const orch = callerFor('orchestrator', { run_id: RUN });
const operator = callerFor('operator', { run_id: RUN });
const worker = callerFor('worker', { run_id: RUN, worker_id: 'w1' });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const DIM = 4;
const embed = async () => { if (waiting) waiting(); if (gate) await gate; return { embedding: [1, 0, 0, 0], embedding_model: 'fake', embedding_revision: 'r', dim: DIM }; };
const hold = () => { gate = new Promise((r) => { openGate = r; }); return new Promise((r) => { waiting = r; }); };
const ended = (p) => assert.rejects(p, (e) => { assert.strictEqual(e.code, 'E_ARGS', e.message); assert.match(e.message, /has already ended/); return true; });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  await call('worker.write', orch, { id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now(), model: 'm' });
});
after(() => { store.close(); cleanup(dir); });

test('a memory.store waiting on its embedding is refused when the run ends meanwhile, and writes no row', async () => {
  const before = store.count();
  const waited = hold();
  const p = call('memory.store', worker, { text: 'late note about the loader' });
  const settled = ended(p);
  await waited;
  await call('run.end', operator, { exit_reason: 'test' });
  openGate();
  await settled;
  assert.strictEqual(store.count(), before, 'no memory row was written');
});

test('a task.evaluate whose commands outlast run.end is refused, and the task stays as it was', async () => {
  // a second run: the first has ended
  const R2 = 'r-flight-2', o2 = callerFor('orchestrator', { run_id: R2 }), op2 = callerFor('operator', { run_id: R2 });
  await call('run.attach', o2, { adapter_pid: process.pid });
  const flag = path.join(dir, 'go.flag');
  const script = path.join(dir, 'wait.cjs');
  fs.writeFileSync(script, `const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(flag)})){clearInterval(t);process.exit(0);}},20);`);
  const t = await call('task.create', o2, { spec: 'slow', acceptance: { commands: [{ argv: [process.execPath, script], timeout_ms: 60000 }] } });
  const p = call('task.evaluate', o2, { task_id: t.id, worktree: dir });
  const settled = ended(p);
  await call('run.end', op2, { exit_reason: 'test' });
  fs.writeFileSync(flag, '1');
  await settled;
  const after = (await call('task.get', o2, { task_id: t.id }));
  assert.strictEqual(after.state, 'open');
  assert.strictEqual(after.results, null);
});

test('a lease.release whose notes were being embedded is refused when the run ends meanwhile, and the lease stays held', async () => {
  const R3 = 'r-flight-3', o3 = callerFor('orchestrator', { run_id: R3 }), op3 = callerFor('operator', { run_id: R3 }), w3 = callerFor('worker', { run_id: R3, worker_id: 'w3' });
  await call('run.attach', o3, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  await call('worker.write', o3, { id: 'w3', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's3', last_event_at: Date.now(), model: 'm' });
  const t = await call('task.create', o3, { spec: 'job' });
  const l = (await call('task.assign', o3, { task_id: t.id, worker_id: 'w3' })).new_lease;
  const before = store.count();
  const waited = hold();
  const note = { kind: 'lesson', title: 'the loader skips unlisted fixtures', when: 'add a test fixture', basis: 'observed', evidence: [{ where: 'src/x.js', saw: 'never read' }], applies_to: ['src/x.js'], subjects: ['loader'] };
  const settled = ended(call('lease.release', w3, { lease_id: l.id, notes: [note], memory_ids: [] }));
  await waited;
  await call('run.end', op3, { exit_reason: 'test' });
  openGate();
  await settled;
  assert.strictEqual((await call('task.get', o3, { task_id: t.id })).state, 'assigned', 'the release did not land');
  assert.strictEqual(store.count(), before, 'no note was written');
});
