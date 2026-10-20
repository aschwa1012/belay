'use strict';
// review-stage-write-time-hold.test.cjs — a hold written at write time (a refine of a review-verified note) records no head commit, so a
// file cite could not be read for it: the archive reviewer is given the run's head, and its verdict on that hold is applied.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { env, fakeManager, json, LV, RUN } = require('./close-stages-env.cjs');
const { PROJECT, A, A_NEAR } = require('../core/lifecycle-env.cjs');
const { runReview } = require('../../src/run/review-stage.cjs');

let X, T;
before(async () => { X = await env(); T = X.T; await X.worker('apply', 'w-head'); });
after(() => T.close());

async function writeTimeHold(title) {
  const v = T.note(`${title} verified`, { vec: A, created_at: 100, status: 'verified' });
  const p = T.note(`${title} refinement`, { ns: `pending/${PROJECT}`, state: 'pending', vec: A_NEAR, matches: [{ id: v, title: 'x', kind: 'lesson', basis: 'observed', similarity: 0.99 }] });
  await T.call(T.who.tool('apply'), 'memory.noteResolve', { resolutions: [{ id: p, resolve: 'refines', of: v, evidence: [{ where: 'loader.js', saw: 'the caveat' }] }] });
  assert.ok(T.body(v).held, 'held for the reviewer');
  assert.strictEqual(JSON.parse(T.row(T.body(v).held.row).body).head_sha, null, 'a write-time hold has no head of its own');
  return v;
}

test('the archive reviewer is given the run\'s head, so it can archive a write-time hold on a file cite', async () => {
  const v = await writeTimeHold('head given');
  const verdict = { id: v, verdict: 'archive', reason: 'the code shows the refinement covers it', cites: [T.cite] };
  const mgr = fakeManager(T, 'apply', json('verdicts', [verdict]));
  const out = await runReview({ core: X.coreFor('apply'), runId: RUN.apply, lv: { ...LV.apply }, dataDir: T.dir, getManager: async () => mgr, worktree: T.repo, force: true });
  assert.strictEqual(out.ran, true);
  assert.deepStrictEqual([out.result.counts.applied, out.result.counts.refused], [1, 0], JSON.stringify(out.result));
  assert.strictEqual(T.row(v).namespace, `archive/${PROJECT}`);
});

test('the head the stage passes is the newest worker\'s of the run, and none is invented when no worker has one', async () => {
  const v = await writeTimeHold('head from worker');
  const seen = [];
  const core = X.coreFor('apply');
  const spy = new Proxy({}, { get: (_, g) => (g === 'caller' ? core.caller : new Proxy({}, { get: (__, n) => (args) => { if (g === 'memory' && n === 'reviewApply') seen.push(args); return core[g][n](args); } })) });
  const verdict = { id: v, verdict: 'release', reason: 'the code supports the note' };
  await runReview({ core: spy, runId: RUN.apply, lv: { ...LV.apply }, dataDir: T.dir, getManager: async () => fakeManager(T, 'apply', json('verdicts', [verdict])), worktree: T.repo, force: true });
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].head_sha, T.head);
});
