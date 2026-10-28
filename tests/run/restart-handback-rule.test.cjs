'use strict';
// restart-handback-rule.test.cjs — a fresh session's first text after a restart carries the hand-back rule of the task the worker holds
// now (its current lease and required fields), rebuilt from the core, and nothing when it holds no unreleased lease or lost it.

const test = require('node:test');
const assert = require('node:assert');
const { restartFirstText } = require('../../src/run/restart.cjs');

const REQ = { handoff: { required: ['head', 'summary'] } };
const task = (id, lease, acceptance = REQ) => ({ id, state: 'assigned', acceptance, lease });
const mine = (id) => ({ id, holder: 'w1', holder_role: 'worker' });
const coreOf = (tasks) => ({
  continuity: { resumeLine: async () => ({ text: 'task line.' }), resumeDoc: async () => null },
  task: { list: async () => ({ tasks }), get: async ({ task_id }) => tasks.find((t) => t.id === task_id) },
});
const text = (tasks, hold, w = { id: 'w1', taskId: 't1', dir: require('node:os').tmpdir(), handbackRule: '\n\nSTALE spawn rule L0' }) => restartFirstText(w, 'replace', { core: coreOf(tasks), ctx: null, hold });

test('a normal fresh restart carries the rule with the current lease and the required fields', async () => {
  const out = await text([task('t1', mine('L2'))], {});
  assert.match(out, /call lease_release with lease_id L2 /);
  assert.match(out, /must carry head, summary/);
  assert.ok(!out.includes('STALE') && !out.includes('L0'));
});

test('a lost lease gets no rule, so nothing contradicts the lost-lease note', async () => {
  assert.ok(!(await text([task('t1', mine('L2'))], { reason: 'lease_lost' })).includes('lease_release'));
});

test('a task already released, or held by someone else, gets no rule', async () => {
  assert.ok(!(await text([task('t1', null)], {})).includes('lease_release'));
  assert.ok(!(await text([task('t1', { id: 'L3', holder: 'w2', holder_role: 'worker' })], {})).includes('lease_release'));
});

test('a worker reassigned to another task gets that task\'s rule and fields', async () => {
  const out = await text([task('t1', null), task('t2', mine('L9'), { handoff: { required: ['tests'] } })], {});
  assert.match(out, /lease_id L9 /);
  assert.match(out, /must carry tests, each/);
  assert.ok(!out.includes('head, summary'));
});
