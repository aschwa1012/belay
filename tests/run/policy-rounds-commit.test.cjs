'use strict';
require('../helpers/tmp.cjs');
// policy-rounds-commit.test.cjs — a hand-back belay could not commit for a Codex worker (handoff.commit.error) is never re-evaluated by the plan,
// which would judge uncommitted work: a failing commit hook is a fix round with the hook's output, every other cause is an E5 carrying the error.
// Pure: due() and the wake derivation are functions of the rows.

const test = require('node:test');
const assert = require('node:assert');
const { due } = require('../../src/run/policy-exec.cjs');
const PW = require('../../src/run/policy-wakes.cjs');

const T = (id, over = {}) => ({ id, seq: 100, run_id: 'r1', state: 'open', policy: null, policy_rev: null, depends_on: [], repairs: null, results: null, handoff: null, lease: null, review: null, integration: null, written_at: 50, ...over });
const PLAN = { review: { worker: 'rv' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };
const lost = { runId: 'r1', integrations: [], now: 100, rounds: { caps: { max: 2, hard: null } } };
const commitFail = (reason, error) => T('W', { state: 'released', policy: PLAN, policy_rev: 1, handoff: { by: 'b1', at: 10, commit: { made: false, head: 'a'.repeat(40), branch: 'belay/W', reason, error, at: 20 } } });
const eCommit = [{ id: 'f1', seq: 7, task_id: 'W', code: 'E_COMMIT', written_at: 30 }];

test('a commit a hook refused is a fix round to the same worker with the hook output, counted against the cap; it is never re-run', () => {
  const W = commitFail('hook', 'git commit failed: lint: no console.log in src/a.js');
  const out = due({ ...lost, tasks: [W], steps: [], failures: eCommit });
  assert.deepStrictEqual(out.map((c) => [c.step, c.worker]), [['fix_run', 'b1']], 'not rerun_eval');
  assert.match(out[0].prompt, /was not committed: a git hook refused it \(lint: no console\.log in src\/a\.js\)\. Fix what the hook reports.*Fix round 1 of 2\./);
  assert.deepStrictEqual(due({ ...lost, rounds: { caps: { max: 0, hard: null } }, tasks: [W], steps: [], failures: eCommit }), [], 'at the cap nothing is due (the wake is E2)');
});

for (const [reason, error] of [['secret', 'not committed: .env, cfg/a.pem look like a secret; remove them from the worktree or ignore them'], ['head', 'HEAD is detached in the worktree; nothing was committed'], ['add', 'git add failed: Unable to create index.lock'], ['bound', 'git commit failed: timed out; '], ['identity', 'git commit failed: Author identity unknown'], ['hook-msg', 'git commit failed: subject must start with feat:']]) {
  test(`a commit refused for ${reason} is no round and no re-run: it is an E5 carrying the error verbatim`, () => {
    const W = commitFail(reason, error);
    assert.deepStrictEqual(due({ ...lost, tasks: [W], steps: [], failures: eCommit }), [], 'nothing is due');
    const ex = PW.derive({ ...lost, tasks: [W], steps: [], failures: eCommit }).filter((x) => x.exception === 'E5');
    assert.strictEqual(ex.length, 1);
    assert.strictEqual(ex[0].detail.error, `E_COMMIT: ${error}`);
  });
}
