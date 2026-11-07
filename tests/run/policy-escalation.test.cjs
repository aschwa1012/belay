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
    assert.match(wakes[0].text, /^belay: escalation \(question\) from builder-1, task [0-9a-f-]+: "Should the 'retry' keep the old timeout\?"\. Halted until you re-assign, cancel or amend it; a message alone lifts nothing\.$/, 'the text says how to lift it');
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

// Escalation reach: from ANY hand-back. A task under no plan, and a run with no plan at all, are woken by the run's own turn-end path
// (release-eval enrichWakes), the escalation its own wake beside the turn's; there is nothing planned to halt.
test('an unplanned task\'s escalation wakes too, with its own kind and no halt; in a run with no plan as well', async () => {
  for (const label of ['escalate-unplanned', 'escalate-policy-null']) {
    const e = await env(label);
    try {
      const t = await e.orch.task.create({ spec: 'write b.txt', acceptance: PASS, policy: null });
      const w = await e.worker('w-plain');
      const a = await e.orch.task.assign({ task_id: t.id, worker_id: 'w-plain' });
      await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h', escalate: { kind: 'blocked', reason: 'the API key is missing' } } });
      await e.h.task.evaluate({ task_id: t.id, worktree: e.dir, trigger: 'release' });
      const RE = require('../../src/run/release-eval.cjs');
      const seen = new Map();
      const out = await RE.enrichWakes(e.h, RUN, [{ event: 'turn_end', worker_id: 'w-plain', turn: 1, seq: 1 }], seen);
      const esc = out.filter((x) => x.exception === 'escalation');
      assert.strictEqual(esc.length, 1, `${label}: one escalation wake`);
      assert.strictEqual(esc[0].task_id, t.id);
      assert.match(esc[0].text, /^belay: escalation \(blocked\) from w-plain, task [0-9a-f-]+: "the API key is missing"\. No plan: answer as you see fit\.$/);
      assert.ok(out.some((x) => x.event === 'turn_end'), 'the turn end still wakes as it always did for a task with no plan');
      const again = await RE.enrichWakes(e.h, RUN, [{ event: 'turn_end', worker_id: 'w-plain', turn: 1, seq: 1 }], seen);
      assert.deepStrictEqual(again.filter((x) => x.exception === 'escalation'), [], 'once');
      const tasks = (await e.h.task.list({})).tasks;
      assert.ok(!PW.haltedIds(PW.derive({ runId: RUN, tasks, integrations: [], steps: [], failures: [] }), tasks).has(t.id), 'nothing to halt');
      assert.strictEqual(require('../../src/run/run-digest.cjs').wakeUid(esc[0]), `${esc[0].worker_id}:${esc[0].key}`, 'one claim key: the wait and the wake deliver it once');
    } finally { await e.close(); }
  }
});

test('a planned escalation is not lifted by a message alone: only a re-assign, a cancel or an amend', async () => {
  const e = await env('escalate-message');
  try {
    // A check that fails leaves the task released, so the orchestrator can re-assign it (a done task cannot be).
    const t = await e.orch.task.create({ spec: 'x', acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(1)'], timeout_ms: 20000 }] }, policy: { review: { worker: 'rv' }, ...REST } });
    const w = await e.worker('b1');
    await e.worker('rv');
    const a = await e.orch.task.assign({ task_id: t.id, worker_id: 'b1' });
    await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h', escalate: { kind: 'scope', reason: 'needs a second file' } } });
    await e.h.task.evaluate({ task_id: t.id, worktree: e.dir, trigger: 'release' });
    // A worker_message writes no task row: the halt stands.
    assert.deepStrictEqual((await e.exec().tick()).steps, [], 'still halted');
    // A re-assign by the orchestrator after the hand-back lifts it.
    await e.orch.task.assign({ task_id: t.id, worker_id: 'b1' });
    const tasks = (await e.h.task.list({})).tasks;
    const ex = PW.derive({ runId: RUN, tasks, integrations: [], steps: [], failures: [] }).filter((x) => x.exception === 'escalation');
    assert.ok(ex.length && ex.every((x) => x.lifted), 're-assigned: lifted');
  } finally { await e.close(); }
});
