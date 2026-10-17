'use strict';
// memory-held-kinds.test.cjs — the held count and the review queue cover EVERY held kind (wrong, duplicate), so a hold the scrubber or an
// older store left is counted for the operator and reviewed by the on-demand archive reviewer; none is stranded.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./lifecycle-env.cjs');
const { cleanup } = require('./helpers.cjs');

let T;
before(async () => { T = await setup(); });
after(() => { try { T.store.close(); } catch { /* closed */ } cleanup(T.dir); });

test('a duplicate hold is counted by memory.held and offered by memory.reviewQueue beside a wrong hold', async () => {
  const wrong = T.note('held as wrong', { reported_wrong: [T.report()] });
  const keep = T.note('the kept note', {});
  const dupe = T.note('a duplicate of the kept note', { reported_wrong: [T.report('worker:w2', keep)] });
  await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: wrong, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'the loader throws', cites: [T.cite] }], scope: [wrong], ...T.evidence });
  await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: dupe, action: 'hold', kind: 'duplicate', of: keep, ground: 'same_claim', reason: 'same claim' }], scope: [dupe, keep], ...T.evidence });
  const held = await T.call(T.who.tool('apply'), 'memory.held', {});
  assert.deepStrictEqual([held.total, held.by_project.lc], [2, 2]);
  const q = await T.call(T.who.tool('apply'), 'memory.reviewQueue', {});
  assert.deepStrictEqual(q.held.map((h) => h.kind).sort(), ['duplicate', 'wrong']);
});
