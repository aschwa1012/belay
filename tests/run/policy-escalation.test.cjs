'use strict';
require('../helpers/tmp.cjs');
// policy-escalation.test.cjs — ADR 0074 amendment 4: a worker or reviewer that needs the orchestrator says so in its hand-back
// (`result.escalate: { kind, reason }`), and that always wakes the orchestrator, planned task or not, with its own kind (not an E-code). The
// task's planned steps wait until the orchestrator acts on it or amends its plan. The REAL core, executor and watcher.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { guarded, makeRepo, write, commit } = require('../core/worktree-helpers.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const HB = require('../../src/run/handback.cjs');
const { env, stepRows, RUN, REST, PASS } = require('./policy-review-env.cjs');

const test = guarded(nodeTest);

test('the hand-back rule tells every worker how to escalate, in one line', () => {
  assert.match(HB.ESCALATE_LINE, /^ If you need the orchestrator \(a question, blocked, a scope or plan change, a conflict, an unclear spec\), add "escalate": \{ "kind": "question\|blocked\|scope\|conflict\|spec", "reason": "\.\.\." \} to the result: it is woken with your reason\.$/);
  assert.ok(HB.rule({ new_lease: { id: 'L' }, task: { id: 't' } }).includes(HB.ESCALATE_LINE));
  assert.ok(HB.rule({ new_lease: { id: 'L' }, task: { id: 'r', acceptance: { verdict: true } } }).includes(HB.ESCALATE_LINE), 'a reviewer too');
});

test('a planned task whose builder escalates: one escalation wake with the reason, no review until the orchestrator acts', async () => {
  const e = await env('escalate');
  try {
    const repo = makeRepo(e.dir);
    const t = await e.orch.task.create({ spec: 'write a.txt', acceptance: PASS, policy: { review: { worker: 'rv' }, ...REST } });
    const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree;
    write(wt.path, 'a.txt', 'a\n'); commit(wt.path, `task ${t.id}`);
    const w = await e.worker('builder-1', wt.path);
    await e.worker('rv');
    const a = await e.orch.task.assign({ task_id: t.id, worker_id: 'builder-1' });
    await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h', escalate: { kind: 'question', reason: 'Should the "retry" keep the old timeout?' } } });
    assert.strictEqual((await e.h.task.evaluate({ task_id: t.id, trigger: 'release' })).state, 'done', 'the work passes its checks');
    const watcher = PW.createPolicyWatcher({ core: e.h, runId: RUN, enabled: true });
    const wakes = (await watcher.poll()).filter((x) => x.exception === 'escalation');
    assert.strictEqual(wakes.length, 1, 'one escalation wake');
    assert.strictEqual(wakes[0].task_id, t.id);
    assert.match(wakes[0].text, /^belay: escalation \(question\) from builder-1 on task .*, its words: "Should the 'retry' keep the old timeout\?"\. Its planned steps wait until you act on it or amend its plan\.$/);
    assert.ok(Buffer.byteLength(wakes[0].text) <= PW.WAKE_TEXT_MAX);
    assert.deepStrictEqual(await watcher.poll(), [], 'once');
    assert.deepStrictEqual((await e.exec().tick()).steps, [], 'no review step: the task waits for the orchestrator');
    assert.deepStrictEqual(stepRows(e), []);
    assert.ok(require('../../src/run/digest-wake.cjs').ridesDigest(wakes[0]), 'the digest follows it');
    // The orchestrator answers by amending the plan: the halt lifts and the review goes ahead.
    await e.orch.task.create({ id: t.id, amend: true, policy: { review: { worker: 'rv' }, ...REST } });
    const after = (await e.exec().tick()).steps;
    assert.deepStrictEqual(after.map((s) => [s.step, s.outcome]), [['review', 'done']], 'acted on: the plan goes on');
  } finally { await e.close(); }
});
