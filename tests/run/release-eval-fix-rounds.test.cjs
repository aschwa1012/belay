'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// release-eval-fix-rounds.test.cjs — a refuted review's wake data names the work task a chain of fixes began from.

const test = require('node:test');
const assert = require('node:assert');
const RE = require('../../src/run/release-eval.cjs');

const review = { used: 2, max: 2, fix_hard_cap: null };
const task = (id, extra = {}) => ({ id, repairs: null, ...extra });

test('fix_rounds.work is the root work task for a chain of fixes, with the count unchanged', () => {
  const root = task('work');
  const fix1 = task('fix-1', { repairs: 'work' });
  const fix2 = task('fix-2', { repairs: 'fix-1', review: { fix_rounds_used: review.used, max_fix_rounds: review.max, fix_hard_cap: null } });
  const refuted = { id: 'rev-2', state: 'open', depends_on: ['fix-2'], results: { passed: false, executable: true, checks: [{ kind: 'verdict', passed: false }] } };
  const byId = new Map([root, fix1, fix2, refuted].map((t) => [t.id, t]));
  const s = RE.summaryOf(refuted, byId);
  assert.deepStrictEqual(s.fix_rounds, { work: 'work', used: 2, max: 2, hard: null });
});

test('a first-round fix and the work itself name the work', () => {
  const root = task('work', { review: { fix_rounds_used: 1, max_fix_rounds: 2, fix_hard_cap: 5 } });
  const refuted = { id: 'rev-1', state: 'open', depends_on: ['work'], results: { passed: false, executable: true, checks: [{ kind: 'verdict', passed: false }] } };
  const s = RE.summaryOf(refuted, new Map([root, refuted].map((t) => [t.id, t])));
  assert.deepStrictEqual(s.fix_rounds, { work: 'work', used: 1, max: 2, hard: 5 });
});

test('the release evaluation of a hand-back reaches the root through the repairs chain, not just the judged fix', async () => {
  const tasks = new Map([
    ['work', task('work')],
    ['fix-1', task('fix-1', { repairs: 'work' })],
    ['fix-2', task('fix-2', { repairs: 'fix-1', review: { fix_rounds_used: 2, max_fix_rounds: 2, fix_hard_cap: null } })],
  ]);
  const gets = [];
  const core = { task: { get: async ({ task_id }) => { gets.push(task_id); const t = tasks.get(task_id); if (!t) throw new Error('none'); return t; } } };
  const row = { id: 'rev-2', state: 'open', depends_on: ['fix-2'], results: { passed: false, executable: true, checks: [{ kind: 'verdict', passed: false }] } };
  const byId = await RE.workOf(core, row);
  assert.deepStrictEqual([...byId.keys()], ['fix-2', 'fix-1', 'work']);
  assert.strictEqual(RE.summaryOf(row, byId).fix_rounds.work, 'work');
});
