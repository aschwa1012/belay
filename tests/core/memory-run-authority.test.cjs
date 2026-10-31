'use strict';
// memory-run-authority.test.cjs — the orchestrator's memory writes are bound to its own run and project, and a worker's briefing
// reads only what a memory read may. Two live runs: ra (project pa, project_writes) and rb (project pb), neither a notes run.
// Each refusal has its control: the same call inside the caller's own run still works.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.cjs');
const { Store } = H.core('store.cjs');
const { Engine } = H.core('engine.cjs');
const tools = require('../../src/mcp/tools.cjs');

const O = (run) => ({ role: 'orchestrator', run_id: run, pid: process.pid });
const Wk = (run, id) => ({ role: 'worker', run_id: run, worker_id: id, pid: process.pid });
const OP = { role: 'operator', run_id: 'cli', pid: process.pid };
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

let dir, store, E;
const call = (caller, m, args = {}) => E.handle(m, { caller, ...args });
const code = async (p) => { try { await p; return null; } catch (e) { return e.code || String(e); } };

before(async () => {
  dir = H.sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  await call(O('ra'), 'run.attach', { adapter_pid: process.pid, project: 'pa', memory_levers: JSON.stringify({ project: 'pa', notes: false, project_writes: true }) });
  await call(O('rb'), 'run.attach', { adapter_pid: process.pid, project: 'pb', memory_levers: JSON.stringify({ project: 'pb', notes: false }) });
});
after(() => { try { store.close(); } catch { /* closed */ } H.cleanup(dir); });

const exists = (id) => !!store.p('SELECT id FROM memory_entries WHERE id = ?').get(id);

test('store: an orchestrator writes its own run namespace, not another run\'s', async () => {
  const own = await call(O('rb'), 'memory.store', { namespace: 'run/rb', text: 'rb scratch', embed: false });
  assert.strictEqual(own.namespace, 'run/rb');
  assert.strictEqual(await code(call(O('rb'), 'memory.store', { namespace: 'run/ra', text: 'planted by rb', embed: false })), 'E_ROLE');
  assert.strictEqual(store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE namespace = 'run/ra'").get().n, 0);
});

test('delete: an orchestrator deletes its own run\'s rows, not another project\'s verified row or another run\'s row', async () => {
  const w = await call(OP, 'memory.store', { namespace: 'project/pa', text: 'operator verified lesson in pa', embed: false });
  await call(OP, 'memory.setStatus', { id: w.id, status: 'verified', receipt: 'test:op-check' });
  assert.strictEqual(await code(call(O('rb'), 'memory.delete', { id: w.id })), 'E_ROLE');
  assert.ok(exists(w.id), 'the other project\'s row is still there');
  const ra = await call(Wk('ra', 'wa'), 'memory.store', { text: 'ra worker scratch row', embed: false });
  assert.strictEqual(await code(call(O('rb'), 'memory.delete', { id: ra.id })), 'E_ROLE');
  assert.ok(exists(ra.id));
  const mine = await call(O('rb'), 'memory.store', { namespace: 'run/rb', text: 'rb row to delete', embed: false });
  assert.strictEqual((await call(O('rb'), 'memory.delete', { id: mine.id })).deleted, true);
  assert.ok(!exists(mine.id));
});

test('verify: an orchestrator cannot set the status of another run\'s row, so no copy lands in that run\'s project', async () => {
  const w = await call(Wk('ra', 'wa'), 'memory.store', { text: 'ra worker finding to verify', embed: false });
  assert.strictEqual(await code(call(O('rb'), 'memory.setStatus', { id: w.id, status: 'verified', receipt: 'test:t' })), 'E_ROLE');
  assert.strictEqual(store.p('SELECT status FROM memory_entries WHERE id = ?').get(w.id).status || 'unverified', 'unverified');
  assert.strictEqual(store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE provenance = ?").get(`copy-of:${w.id}`).n, 0);
  // control: ra's own orchestrator verifies it, and the project copy is made
  const ok = await call(O('ra'), 'memory.setStatus', { id: w.id, status: 'verified', receipt: 'test:t' });
  assert.strictEqual(ok.project_copy && ok.project_copy.namespace, 'project/pa');
});

test('briefing: a worker\'s resumeDoc reads its own run, and refuses another run, another project and a lifecycle namespace', async () => {
  const t = await call(O('ra'), 'task.create', { spec: 'ra task for briefing', acceptance: PASS });
  await call(Wk('ra', 'wa'), 'memory.store', { text: 'SECRET-ra-row tagged to the task', tags: [t.id], embed: false });
  const wb = Wk('rb', 'wb');
  assert.strictEqual(await code(call(wb, 'memory.list', { namespace: 'run/ra' })), 'E_ROLE'); // the control: a memory read is refused
  for (const ns of ['run/ra', 'project/pa', 'held/pb']) {
    assert.strictEqual(await code(call(wb, 'continuity.resumeDoc', { task_id: t.id, namespace: ns })), 'E_ROLE', ns);
  }
  const own = await call(Wk('ra', 'wa'), 'continuity.resumeDoc', { task_id: t.id });
  assert.ok(own.text.includes('SECRET-ra-row'));
  const viaProject = await call(Wk('ra', 'wa'), 'continuity.resumeDoc', { task_id: t.id, namespace: 'project' });
  assert.ok(viaProject.text.includes('(none)'));
});

test('briefing tool: the schema is closed, so a model cannot pass namespace', () => {
  assert.doesNotThrow(() => tools.validateArgs('briefing', { task_id: 't' }, { role: 'worker' }));
  assert.throws(() => tools.validateArgs('briefing', { task_id: 't', namespace: 'run/ra' }, { role: 'worker' }), (e) => e.code === 'E_ARGS' && e.detail && e.detail.field === 'namespace');
});
