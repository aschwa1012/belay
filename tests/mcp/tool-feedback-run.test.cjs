// tool-feedback-run.test.cjs — ADR 0058 through the adapter, against the real core and run manager with the fake Claude Code
// substrate: what the orchestrator prompt used to ask the orchestrator to remember, the tool now does.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { launch, sandboxDir, ROOT } = require('./rpc.cjs');

const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;

function realRun(data, env = {}) {
  return launch({
    role: 'orchestrator', data, fake: false, noEmbed: true,
    env: { BELAY_FAKE_PATHS: JSON.stringify({ claudeExe: FAKE_CLAUDE, codexExe: FAKE_CLAUDE, userSettings: USER_SETTINGS }), ...env },
  });
}

async function started(t, tag, env) {
  const data = sandboxDir(tag);
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const a = realRun(data, env);
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  return { a, data, worktree };
}

const ok = (r, what) => { assert.strictEqual(r.isError, false, `${what} refused: ${JSON.stringify(r.structuredContent)}`); return r.structuredContent; };
const userTexts = (data, id) => fs.readFileSync(`${data}/workers/${id}/stream.jsonl`, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((j) => j && j.type === 'result').map((j) => j.result);

test('task_assign sends the running worker its task, lease id and hand-back rule, or the prompt given; deliver false assigns only', { timeout: 90000 }, async (t) => {
  const { a, data, worktree } = await started(t, 'fb-assign');
  const w = ok(await a.call('worker_spawn', { substrate: 'claude-code', worktree, prompt: 'stand by', worker_id: 'wk-a' }), 'worker_spawn');
  ok(await a.call('worker_wait', { worker_ids: [w.id], timeout_ms: 20000 }), 'worker_wait');

  const task = ok(await a.call('task_create', { spec: 'rename the frobnicator', acceptance: { files_within_owned: true }, files_owned: [] }), 'task_create');
  const asg = ok(await a.call('task_assign', { task_id: task.id, worker_id: w.id }), 'task_assign');
  assert.strictEqual(asg.delivered.sent, true, JSON.stringify(asg.delivered));
  assert.strictEqual(asg.delivered.channel, 'stdin');
  const turn = ok(await a.call('worker_wait', { worker_ids: [w.id], timeout_ms: 20000 }), 'worker_wait');
  assert.strictEqual(turn.event, 'turn_end');
  const said = userTexts(data, w.id).find((x) => x.includes('rename the frobnicator'));
  assert.ok(said, 'the worker received the task spec');
  assert.ok(said.includes(`lease=${asg.new_lease.id}`) && said.includes(`lease_release with lease_id ${asg.new_lease.id}`), `the worker was told its lease: ${said}`);

  // An explicit prompt replaces the spec; deliver false assigns only.
  const t2 = ok(await a.call('task_create', { spec: 'second', acceptance: { files_within_owned: true }, files_owned: [] }), 'task_create');
  const quiet = ok(await a.call('task_assign', { task_id: t2.id, worker_id: w.id, deliver: false }), 'task_assign');
  assert.deepStrictEqual([quiet.delivered.sent, quiet.task.state], [false, 'assigned']);
  const loud = ok(await a.call('task_assign', { task_id: t2.id, worker_id: w.id, prompt: 'do the second thing now' }), 'task_assign');
  assert.strictEqual(loud.delivered.sent, true);
  ok(await a.call('worker_wait', { worker_ids: [w.id], timeout_ms: 20000 }), 'worker_wait');
  assert.ok(userTexts(data, w.id).some((x) => x.includes('do the second thing now') && !x.includes('Task: second')), 'the prompt is sent in place of the spec');
});
