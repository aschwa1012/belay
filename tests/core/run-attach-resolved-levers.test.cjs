'use strict';
// run.attach stores the memory block as parseMemoryBlock resolves it, so the core readers (raw `notes === true`) and the run
// manager (which re-parses the row) cannot disagree on a partial block.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

test('a partial block with a project is stored resolved, notes true; a block with no project resolves notes false', async () => {
  for (const [run, block, notes] of [['pa1', { project: 'acme' }, true], ['pa2', {}, false], ['pa3', { project: 'acme', redact: false }, false]]) {
    const who = callerFor('orchestrator', { run_id: run });
    await T.call(who, 'run.attach', { adapter_pid: process.pid, memory_levers: JSON.stringify(block) });
    const { run: row } = await T.call(who, 'run.get', {});
    const stored = JSON.parse(row.memory_levers);
    assert.strictEqual(stored.notes, notes, JSON.stringify(block));
    assert.strictEqual(typeof stored.scrub_cost_cap_usd, 'number', 'every lever is stored, not the partial block');
    assert.strictEqual(require('../../src/run/memory-levers.cjs').leversOfRow(row).notes, stored.notes, 'run manager and core agree');
  }
});

test('run.attach records the launch notice code on the run row, refuses an unknown one, and a re-attach carries it', async () => {
  const who = callerFor('orchestrator', { run_id: 'pn1' });
  const attach = (extra) => T.call(who, 'run.attach', { adapter_pid: process.pid, ...extra });
  const noticeOf = async () => (await T.call(who, 'run.get', {})).run.memory_notice;
  await attach({ memory_levers: null, project: null, memory_notice: 'memory_project_unset' });
  assert.strictEqual(await noticeOf(), 'memory_project_unset');
  await attach({}); // the adapter's own attach: nothing stated, the unended epoch's answer carries
  assert.strictEqual(await noticeOf(), 'memory_project_unset');
  await attach({ memory_notice: null });
  assert.strictEqual(await noticeOf(), null, 'a launching attach that states null clears it');
  await assert.rejects(attach({ memory_notice: 'made-up' }), (e) => e.code === 'E_ARGS');
});
