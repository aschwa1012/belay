'use strict';
require('../helpers/tmp.cjs');
// policy-rounds-lines.test.cjs — the search lines of a work ride to its fix and to the re-review the plan makes. They reach a worker through its
// first-message index, built when a worker is spawned or relaunched; a fix or review handed to a live worker by task.assign gets no index.
// Real core, real executor (policy-matrix-env.cjs).

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { guarded } = require('../core/worktree-helpers.cjs');
const M = require('./policy-matrix-env.cjs');

const test = guarded(nodeTest);
const names = (out) => out.steps.map((s) => [s.step, s.task_id, s.outcome]);

test('the re-review the plan makes carries the lines of the work: they ride from the work to its fix and to the review of the fix', async () => {
  const LINES = ['stop --at just after midnight', 'lib/timer.js start and stop'];
  const e = await M.env({ label: 'round-lines', attach: { max_fix_rounds: 2 } });
  try {
    const { task } = await M.workDone(e, 'm', { create: { memory_queries: LINES } });
    await M.reviewed(e, task, 'm', 'refuted', { judge: 'rv' });
    assert.deepStrictEqual(names(await e.tick()).map((s) => s[0]), ['fix']);
    const fix = M.fixesOf(e, task.id)[0].id;
    assert.deepStrictEqual(JSON.parse(e.raw('SELECT memory_queries FROM task WHERE id = ? ORDER BY seq DESC LIMIT 1', fix)[0].memory_queries), LINES, 'the fix');
    assert.strictEqual((await M.handBackLeased(e, fix)).state, 'done');
    assert.deepStrictEqual(names(await e.tick()).map((s) => s[0]), ['re_review']);
    const rr = e.raw('SELECT id FROM task WHERE depends_on LIKE ? AND acceptance LIKE ?', `%${fix}%`, '%verdict%')[0].id;
    assert.deepStrictEqual(JSON.parse(e.raw('SELECT memory_queries FROM task WHERE id = ? ORDER BY seq DESC LIMIT 1', rr)[0].memory_queries), LINES, 'the re-review');
  } finally { await e.close(); }
});
