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
