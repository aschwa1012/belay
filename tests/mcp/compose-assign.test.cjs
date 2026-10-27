'use strict';
// compose-assign.test.cjs — what task_assign sends the worker (wording audit): the first assignment's line carries only the task and
// the lease; the hand-back rule is belay's, shaped for the task (a verdict task's has the verdict shape and the Review standard);
// and a verdict task assigned to a live reviewer carries the note-review brief, as it does at a spawn.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCompose } = require('../../src/mcp/compose.cjs');

const STANDARD = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'run', 'prompts', 'review-standard.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
const TREE = { path: 'C:/r.worktrees/t1', branch: 'belay/t1' };

// A core whose resumeLine honours `first`, as the real one does, and whose assign answers with this task.
function harness(task, manager = {}) {
  const sent = [];
  const calls = [];
  const callCore = async (m, a) => {
    calls.push([m, a]);
    if (m === 'task.assign') return { task: { id: a.task_id, spec: 'do it', state: 'assigned', ...task }, new_lease: { id: 'L1' } };
    if (m === 'continuity.resumeLine') return { text: a.first === true ? `task ${a.task_id} lease=L1.` : `task ${a.task_id} state=assigned lease=L1. Recover context: briefing task_id=${a.task_id}.` };
    throw new Error(`unexpected ${m}`);
  };
  const mgr = { _worker: () => ({}), message: async (a) => { sent.push(a.text); return { worker_id: a.worker_id, channel: 'stdin', bytes: 1 }; }, ...manager };
  return { c: createCompose({ callCore, manager: () => mgr }), sent, calls };
}

test('a first assignment sends only the task and its lease, then the task, then the hand-back rule', async () => {
  const h = harness({ acceptance: { commands: [{ argv: ['x'] }] } });
  const out = await h.c.assign({ task_id: 't1', worker_id: 'w1' });
  assert.strictEqual(out.delivered.sent, true);
  assert.deepStrictEqual(h.calls.find(([m]) => m === 'continuity.resumeLine')[1], { task_id: 't1', first: true });
  assert.strictEqual(h.sent[0], 'task t1 lease=L1.\n\nTask: do it\n\nWhen you are finished, call lease_release with lease_id L1 and a result object (branch, head, tests, findings).');
});

test('a coder in its own tree is told to commit first; the orchestrator\'s prompt is added after the spec', async () => {
  const h = harness({ worktree: TREE });
  await h.c.assign({ task_id: 't1', worker_id: 'w1', prompt: 'rebase it' });
  assert.ok(h.sent[0].startsWith('task t1 lease=L1.\n\nTask: do it\n\nrebase it\n\nWhen you are finished, commit your work in your worktree, then call lease_release'));
});

test('a verdict task gets the verdict-shaped rule and the Review standard, and never the work shape', async () => {
  const h = harness({ acceptance: { verdict: true }, worktree: TREE });
  await h.c.assign({ task_id: 'r1', worker_id: 'rv' });
  const text = h.sent[0];
  assert.ok(text.includes('call lease_release with lease_id L1 and result: { "verdict": "holds" | "refuted", "summary": "...", "findings": [...] }.'));
  assert.ok(text.endsWith(STANDARD));
  assert.ok(!text.includes('(branch, head, tests, findings)') && !text.includes('commit your work'));
});

test('a verdict task assigned to a live reviewer carries the note-review brief last; a work task asks for none', async () => {
  const asked = [];
  const manager = { reviewTail: async (a) => { asked.push(a); return '\n\nNOTES TO JUDGE\n'; } };
  const v = harness({ acceptance: { verdict: true } }, manager);
  await v.c.assign({ task_id: 'r1', worker_id: 'rv' });
  assert.deepStrictEqual(asked, [{ worker_id: 'rv', task_id: 'r1' }]);
  assert.ok(v.sent[0].endsWith(`${STANDARD}\n\nNOTES TO JUDGE\n`), 'after the rule and the standard, as at a spawn');
  const w = harness({ acceptance: { commands: [{ argv: ['x'] }] } }, manager);
  await w.c.assign({ task_id: 't1', worker_id: 'w1' });
  assert.strictEqual(asked.length, 1, 'not asked for a work task');
  assert.ok(!w.sent[0].includes('NOTES TO JUDGE'));
});

test('a brief that cannot be built never stops the assign', async () => {
  const h = harness({ acceptance: { verdict: true } }, { reviewTail: async () => { throw new Error('no brief'); } });
  const out = await h.c.assign({ task_id: 'r1', worker_id: 'rv' });
  assert.strictEqual(out.delivered.sent, true);
  assert.ok(h.sent[0].endsWith(STANDARD));
});
