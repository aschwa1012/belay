'use strict';
// stage-attempt-limit.test.cjs — the halving after a cost overrun counts only the project's own runs. Before, one project's overrun
// halved the next attempt of every other project's scrub or review.

const { test } = require('node:test');
const assert = require('node:assert');
const J = require('../../src/run/stage-job.cjs');

const events = [
  { kind: 'scrub_job', ok: 1, run_id: 'a-1', key: 'run:a-1' },
  { kind: 'stage_overrun', key: 'scrub', run_id: 'b-1', row_ids: ['n1', 'n2', 'n3', 'n4'] },
];
const core = {
  memory: { events: async () => ({ events }) },
  run: { list: async () => ({ runs: [{ id: 'a-1', project: 'a' }, { id: 'b-1', project: 'b' }] }) },
};

test('another project\'s overrun does not halve this project\'s attempt', async () => {
  assert.strictEqual(await J.attemptLimit(core, 'scrub', 'scrub_job', 10, 'a'), 10);
  assert.strictEqual(await J.attemptLimit(core, 'scrub', 'scrub_job', 10, 'b'), 2, 'the project that overran takes half of what it tried');
});

test('a success in another project does not end this project\'s halving', async () => {
  const mixed = { ...core, memory: { events: async () => ({ events: [
    { kind: 'stage_overrun', key: 'scrub', run_id: 'b-1', row_ids: ['n1', 'n2', 'n3', 'n4'] },
    { kind: 'scrub_job', ok: 1, run_id: 'a-1', key: 'run:a-1' },
  ] }) } };
  assert.strictEqual(await J.attemptLimit(mixed, 'scrub', 'scrub_job', 10, 'b'), 2);
});

test('without a project the ledger is read whole, as before; an unreadable run list falls back to the full count', async () => {
  assert.strictEqual(await J.attemptLimit(core, 'scrub', 'scrub_job', 10), 2);
  const broken = { ...core, run: { list: async () => { throw new Error('no run table'); } } };
  assert.strictEqual(await J.attemptLimit(broken, 'scrub', 'scrub_job', 10, 'b'), 10);
});
