'use strict';
require('../helpers/tmp.cjs');
// policy-rounds-codex-words.test.cjs — a round's text to a Codex worker does not ask it to commit (belay commits its worktree at hand-back),
// and the same text to a Claude Code worker is as it was. Stubbed core around the real step runners.

const test = require('node:test');
const assert = require('node:assert');
const RR = require('../../src/run/policy-rounds-run.cjs');

const RUN = 'r1';
const SENT = {
  fix_eval: "belay: your hand-back of task T1 failed belay's own evaluation (x). Fix it in your worktree, commit, and release the task again.",
  fix_run: 'belay: belay could not evaluate your hand-back of task T1 (E_X), here or on a second try. Make sure your work is committed, and release the task again.',
};

function stubEnv(substrate, sent) {
  const task = { id: 'T1', run_id: RUN, state: 'released', handoff: { by: 'bld' }, lease: null };
  return {
    runId: RUN,
    core: {
      task: { get: async () => task, list: async () => ({ tasks: [task] }) },
      worker: { list: async () => ({ workers: [{ id: 'bld', substrate, state: 'idle', pid_alive: true }] }) },
      run: { get: async () => ({ run: { paused_at: null } }) },
    },
    assign: async (a) => { sent.push(a); return { delivered: { sent: true }, new_lease: { id: 'L1' } }; },
  };
}

for (const [step, text] of Object.entries(SENT)) {
  test(`${step}: the text sent to a Codex worker asks for no commit; to a Claude Code worker it is unchanged`, async () => {
    const codexSent = [], claudeSent = [];
    await RR.RUNNERS[step]({ step, task_id: 'T1', worker: 'bld', prompt: text, build: null }, stubEnv('codex', codexSent));
    await RR.RUNNERS[step]({ step, task_id: 'T1', worker: 'bld', prompt: text, build: null }, stubEnv('claude-code', claudeSent));
    assert.strictEqual(claudeSent[0].prompt, text);
    assert.ok(!/commit/.test(codexSent[0].prompt.replace(/hand-back|commits/g, '')), codexSent[0].prompt);
    assert.match(codexSent[0].prompt, /release the task again\.$/);
  });
}

// A conflict or checks fix needs git writes a Codex sandbox denies: it goes to a fresh Claude Code coder in the same tree, recorded as the step's worker_id.
function mergeEnv(substrate, { spawn = true } = {}) {
  const calls = [];
  const work = { id: 'W', state: 'done', acceptance: { commands: [] }, files_owned: [], worktree: { path: 'C:/wt/W' } };
  let made = null;
  const e = {
    runId: RUN, calls,
    core: {
      task: {
        get: async ({ task_id }) => (task_id === 'W' ? work : task_id === 'F1' ? { id: 'F1', lease: made ? { id: 'L9', holder: made } : null } : { id: task_id, lease: null }),
        list: async () => ({ tasks: [] }),
        create: async (a) => { calls.push({ create: a }); return { id: 'F1' }; },
      },
      worker: { list: async () => ({ workers: [{ id: 'cx1', substrate, state: 'idle', pid_alive: substrate !== 'codex' }] }) },
      run: { get: async () => ({ run: { paused_at: null } }) },
    },
    assign: async (a) => { calls.push({ assign: a }); return { delivered: { sent: true } }; },
  };
  if (spawn) e.spawn = async (a) => { calls.push({ spawn: a }); made = a.worker_id; return { id: a.worker_id }; };
  return e;
}
const SPEC = 'Integrate conflict: task W conflicts with belay/integrate/r1. In your worktree, merge or rebase belay/integrate/r1 into your branch and resolve the conflicts, run your checks, commit, and release.';

for (const step of ['fix_conflict', 'fix_checks']) {
  test(`${step} whose builder is Codex goes to a fresh Claude Code coder in the same tree, recorded as worker_id`, async () => {
    const e = mergeEnv('codex');
    const res = await RR.RUNNERS[step]({ step, task_id: 'W', conflict_task: 'W', worker: 'cx1', spec: SPEC }, e);
    assert.strictEqual(res.outcome, 'done', JSON.stringify(res));
    const sp = e.calls.find((x) => x.spawn).spawn;
    assert.deepStrictEqual([sp.substrate, sp.agent_type, sp.worktree], ['claude-code', 'coder', 'C:/wt/W']);
    assert.match(res.worker_id, /^bld-/);
    assert.strictEqual(res.spawned, res.worker_id);
    assert.ok(!e.calls.some((x) => x.assign), 'Codex was sent nothing');
    assert.strictEqual(e.calls.find((x) => x.create).create.spec, SPEC, 'the text to a Claude Code coder is unchanged');
  });
}

test('a conflict fix for a Codex builder with no way to start a Claude Code coder is an exception: nothing is written or sent', async () => {
  const e = mergeEnv('codex', { spawn: false });
  const res = await RR.RUNNERS.fix_conflict({ step: 'fix_conflict', task_id: 'W', conflict_task: 'W', worker: 'cx1', spec: SPEC }, e);
  assert.strictEqual(res.outcome, 'exception');
  assert.match(res.error, /Codex worker, whose sandbox cannot merge or rebase.*no spawn path.*not sent/);
  assert.deepStrictEqual(e.calls, []);
});

test('a conflict fix for a Claude Code builder still goes back to that builder', async () => {
  const e = mergeEnv('claude-code');
  const res = await RR.RUNNERS.fix_conflict({ step: 'fix_conflict', task_id: 'W', conflict_task: 'W', worker: 'cx1', spec: SPEC }, e);
  assert.strictEqual(res.outcome, 'done', JSON.stringify(res));
  assert.deepStrictEqual(e.calls.map((x) => Object.keys(x)[0]), ['create', 'assign']);
});
