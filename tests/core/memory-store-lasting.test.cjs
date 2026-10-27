'use strict';
// memory-store-lasting.test.cjs — ADR 0057 decision 8 (C8): a model's write to the default namespace, the run's scratch, in a run with a project
// whose rows are not promoted, is told it does not last and how to keep a lesson. A run with project_writes, a run with no project, a named
// namespace and the harness channel answer the row alone, as before. Real Engine over a stamped store, embed: false, so no model is loaded.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const RUNS = { notes: 'ls-notes', plain: 'ls-plain', promoted: 'ls-promoted', bare: 'ls-bare' };
const who = (k, role = 'orchestrator') => callerFor(role, { run_id: RUNS[k], ...(role === 'worker' ? { worker_id: 'w1' } : {}) });
const store1 = (k, args = {}, role) => E.handle('memory.store', { caller: who(k, role), text: `a finding ${Math.random()}`, embed: false, ...args });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  const attach = (k, block, project) => E.handle('run.attach', { caller: who(k), adapter_pid: process.pid, ...(project ? { project } : {}), memory_levers: JSON.stringify(block) });
  await attach('notes', { project: 'acme', notes: true }, 'acme');
  await attach('plain', { project: 'acme', notes: false }, 'acme');
  await attach('promoted', { project: 'acme', notes: false, project_writes: true }, 'acme');
  await attach('bare', {});
});
after(() => { store.close(); cleanup(dir); });

test('a scratch write in a notes run says it does not last and names the project note', async () => {
  const r = await store1('notes');
  assert.ok(r.id, 'the row was written');
  assert.strictEqual(r.lasting, false);
  assert.match(r.note, /^run\/ls-notes is this run's scratch and later runs do not read it; to keep a lesson for later runs, write it to namespace project as a note/);
});

test('a scratch write in a run with a project and notes off says it does not last, and names no note', async () => {
  const r = await store1('plain');
  assert.strictEqual(r.lasting, false);
  assert.strictEqual(r.note, "run/ls-plain is this run's scratch and later runs do not read it");
});

test('promoted rows, runs with no project, named namespaces and the harness channel answer the row alone', async () => {
  for (const r of [await store1('promoted'), await store1('bare'), await store1('plain', { namespace: 'scratch/x' })]) {
    assert.strictEqual(r.lasting, undefined);
    assert.strictEqual(r.note, undefined);
  }
  const harness = await E.handle('memory.store', { caller: { ...who('plain'), channel: 'harness' }, text: 'harness row', embed: false });
  assert.strictEqual(harness.lasting, undefined);
});
