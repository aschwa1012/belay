'use strict';
// note-review-jobless.test.cjs — the short note-review job is gone, and belay's other jobs still get no notes contract, preface or
// review brief (isJob covers every reserved job id), and the receipts the removed job once wrote still list.

const { test } = require('node:test');
const assert = require('node:assert');
const { core: coreMod, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const NR = require('../../src/run/note-review.cjs');
const { teardown } = require('../helpers/teardown.cjs');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');

const { Store } = coreMod('store.cjs');
const { Engine } = coreMod('engine.cjs');

test('every reserved job id is a job; an ordinary worker id is not', () => {
  for (const id of ['notereview-t1', 'scrub-r1-abc', 'archreview-r1-abc']) assert.strictEqual(NR.isJob(id), true, id);
  for (const id of ['coder-1', 'rv-1', 'reviewer']) assert.strictEqual(NR.isJob(id), false, id);
});

test('the module exports no job runner: nothing can start a notereview worker', () => {
  for (const name of ['runJob', 'waitJob', 'expectsJobs', 'jobIdFor', 'taskOfJob', 'lastTextOf', 'JOB_PREFIX', 'drain']) assert.strictEqual(NR[name], undefined, name);
});

test('a job id gets no review brief even for a review task', async () => {
  const ctx = { memoryLevers: { ...DEFAULTS, notes: true, project: 'p' }, core: { memory: { reviewBrief: async () => { throw new Error('must not be asked'); } } } };
  for (const id of ['notereview-x', 'scrub-x', 'archreview-x']) assert.strictEqual(await NR.reviewTail(ctx, { id, taskId: 't' }), '');
});

test('old note_review and review_job receipts still list through memory.events', async () => {
  const dir = sandbox();
  const store = new Store(`${dir}/memory.db`, { stamp: true });
  const E = new Engine({ dataDir: dir, store, getEmbedder: async () => null, owner: null, establishedBy: 'test' });
  const harness = callerFor('orchestrator', { run_id: 'r-old', channel: 'harness' });
  const call = (m, caller, args = {}) => E.handle(m, { caller, ...args });
  let bodyError = null;
  try {
    await call('run.attach', callerFor('orchestrator', { run_id: 'r-old' }), { adapter_pid: process.pid });
    await call('memory.recordEvent', harness, { kind: 'review_job', ok: true, worker_id: 'notereview-t1', task_id: 't1', key: 'task:t1', message: 'applied 1' });
    await call('memory.recordEvent', harness, { kind: 'note_review', ok: true, worker_id: 'notereview-t1', task_id: 't1', key: 'review:notereview-t1:n1', message: 'confirmed: x' });
    const got = await call('memory.events', harness, { kinds: ['review_job', 'note_review'] });
    assert.deepStrictEqual(got.events.map((e) => e.kind).sort(), ['note_review', 'review_job']);
  } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; throw bodyError; } finally { await teardown(bodyError, [() => store.close(), () => cleanup(dir)]); }
});
