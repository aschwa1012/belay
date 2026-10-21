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
