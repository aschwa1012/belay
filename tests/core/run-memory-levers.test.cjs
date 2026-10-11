'use strict';
// run-memory-levers.test.cjs — ADR 0041 decision 1: run.attach records the memory levers (JSON text) and the
// project on the run row, refuses bad values, and carries both forward across a reattach.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');

let dir, orch;

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
});

after(async () => {
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

test('run.attach without the keys leaves both columns null', async () => {
  const { run } = await orch.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(run.memory_levers, null);
  assert.strictEqual(run.project, null);
});

test('run.attach refuses bad memory_levers and project with E_ARGS and writes nothing', async () => {
  const count = (await orch.run.get()).epochs.length;
  for (const args of [{ memory_levers: 'not json' }, { memory_levers: '[1]' }, { memory_levers: 'null' }, { memory_levers: { a: 1 } },
    { memory_levers: '{"bogus":1}' }, { memory_levers: '{"alpha":5}' }, { memory_levers: '{"observations":true}' },
    { memory_levers: '{"project":"acme","project_writes":true,"redact":false}', project: 'acme' },
    { project: 'Upper' }, { project: '' }, { project: 7 }, { project: 'x'.repeat(65) }]) {
    await assert.rejects(orch.run.attach({ adapter_pid: process.pid, ...args }), (e) => e.code === 'E_ARGS', JSON.stringify(args));
  }
  assert.strictEqual((await orch.run.get()).epochs.length, count, 'no row was written');
});

test('run.attach records the levers and project, and a later attach without the keys inherits them', async () => {
  const text = JSON.stringify({ capture: true, project: 'acme' });
  const { run } = await orch.run.attach({ adapter_pid: process.pid, memory_levers: text, project: 'acme' });
  assert.strictEqual(run.memory_levers, text);
  assert.strictEqual(run.project, 'acme');
  const read = (await orch.run.get()).run;
  assert.strictEqual(read.memory_levers, text);
  assert.strictEqual(read.project, 'acme');

  const again = (await orch.run.attach({ adapter_pid: process.pid })).run;
  assert.strictEqual(again.memory_levers, text, 'carried forward');
  assert.strictEqual(again.project, 'acme');
  const paused = await orch.run.setPaused({ paused: true });
  assert.strictEqual(paused.memory_levers, text, 'a pause row keeps them');
  await orch.run.setPaused({ paused: false });

  const cleared = (await orch.run.attach({ adapter_pid: process.pid, memory_levers: null, project: null })).run;
  assert.strictEqual(cleared.memory_levers, null, 'an explicit null clears');
  assert.strictEqual(cleared.project, null);
});
