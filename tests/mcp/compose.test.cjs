// compose.test.cjs — ADR 0058 decisions 9 and 10 as pure functions: the compact spawn answer, and `seq` named `rev` in answers.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { revOf, compactSpawn } = require('../../src/mcp/compose.cjs');

test('revOf renames seq to rev at every depth, leaves everything else, and never overwrites a rev', () => {
  const row = { seq: 4, id: 't', lease: { seq: 9, id: 'l' }, list: [{ seq: 1 }, 'x', null], text: 'seq stays in text' };
  assert.deepStrictEqual(revOf(row), { rev: 4, id: 't', lease: { rev: 9, id: 'l' }, list: [{ rev: 1 }, 'x', null], text: 'seq stays in text' });
  assert.deepStrictEqual(revOf({ seq: 1, rev: 2 }), { seq: 1, rev: 2 });
  assert.strictEqual(revOf(null), null);
  assert.strictEqual(revOf(3), 3);
});

test('compactSpawn keeps what the orchestrator acts on and leaves the launch receipt out', () => {
  const full = {
    id: 'w', substrate: 'claude-code', pid: 7, state: 'running', session_id: 's', adapter_pid: 1, worktree: '/w', task_id: null, started_at: 5, ready_ms: 9,
    model: 'claude-sonnet-5-5', argv_hash: 'abc', pid_created: 1, surface: { builtins: ['Read'], plugins: [] }, instructions: { sha: 'x' },
    agent: { effort: { value: 'high', source: 'agent_type' } }, input_tokens: 0, permission_mode_effective: 'auto',
  };
  const c = compactSpawn(full);
  assert.deepStrictEqual(c, { id: 'w', substrate: 'claude-code', pid: 7, state: 'running', session_id: 's', adapter_pid: 1, worktree: '/w', task_id: null, started_at: 5, ready_ms: 9, model: 'claude-sonnet-5-5', permission_mode_effective: 'auto', model_source: 'reported', effort: 'high', tools: ['Read'] });
  // Codex reports no model: the requested one is named as requested (B5).
  const codex = compactSpawn({ id: 'c', substrate: 'codex', model: null, agent: { model: { value: 'gpt-6.1-sol', source: 'agent_type' } } });
  assert.deepStrictEqual([codex.model, codex.model_source], ['gpt-6.1-sol', 'requested']);
  assert.deepStrictEqual([compactSpawn({ id: 'c', model: null }, 'm-1').model, compactSpawn({ id: 'c', model: null }).model_source], ['m-1', undefined]);
  assert.deepStrictEqual(compactSpawn({ id: 'w', effort_requested: 'low', tools: ['Bash'], permission_mode_degraded: true }), { id: 'w', effort: 'low', tools: ['Bash'], permission_mode_degraded: true });
});

test('task_assign reports a message held for a compaction as queued, not sent', async () => {
  const { createCompose } = require('../../src/mcp/compose.cjs');
  const calls = [];
  const callCore = async (m, a) => (m === 'task.assign' ? { task: { id: a.task_id, spec: 'do it', state: 'assigned' }, new_lease: { id: 'L1' } } : { text: `task ${a.task_id} state=assigned lease=L1.` });
  const reply = (queued) => ({ _worker: () => ({}), message: async (a) => { calls.push(a); return queued ? { worker_id: a.worker_id, channel: 'queued', queued: true, position: 1, bytes: 9 } : { worker_id: a.worker_id, channel: 'stdin', bytes: 9 }; } });
  const held = await createCompose({ callCore, manager: () => reply(true) }).assign({ task_id: 't1', worker_id: 'w1' });
  assert.deepStrictEqual([held.delivered.sent, held.delivered.queued, held.delivered.channel], [false, true, 'queued']);
  const now = await createCompose({ callCore, manager: () => reply(false) }).assign({ task_id: 't1', worker_id: 'w1' });
  assert.deepStrictEqual([now.delivered.sent, now.delivered.queued, now.delivered.channel], [true, false, 'stdin']);
  assert.match(calls[0].text, /lease_release with lease_id L1/);
});

test('task_cancel tells the worker whose lease it ended, once, naming the task and the lease; a stranger is reported, not messaged', async () => {
  const { createCompose } = require('../../src/mcp/compose.cjs');
  const calls = [];
  const out = (holder) => ({ task: { id: 't9', state: 'cancelled' }, released_lease: holder ? { id: 'L9', holder, holder_role: 'worker' } : null, files_released: [] });
  const mgr = { _worker: (id) => (id === 'w9' ? {} : null), message: async (a) => { calls.push(a); return { worker_id: a.worker_id, channel: 'stdin', bytes: 1 }; } };
  const c = (holder) => createCompose({ callCore: async () => out(holder), manager: () => mgr });
  const told = await c('w9').cancel({ task_id: 't9', reason: 'the plan changed' });
  assert.deepStrictEqual([told.task.state, told.notified.sent, calls.length], ['cancelled', true, 1]);
  assert.match(calls[0].text, /task t9 was cancelled \(the plan changed\), and your lease L9 on it has ended/);
  const stranger = await c('w-other').cancel({ task_id: 't9' });
  assert.deepStrictEqual([stranger.notified.sent, calls.length], [false, 1]);
  assert.match(stranger.notified.reason, /not launched by this session/);
  assert.strictEqual((await c(null).cancel({ task_id: 't9' })).notified, null, 'no lease, nobody to tell');
});

test('M24: task_assign to a worker this session did not launch assigns, sends nothing, and says why', async () => {
  const { createCompose } = require('../../src/mcp/compose.cjs');
  const sent = [];
  const callCore = async (m, a) => (m === 'task.assign' ? { task: { id: a.task_id, spec: 'x', state: 'assigned' }, new_lease: { id: 'L2' } } : { text: 'line' });
  const mgr = { _worker: (id) => (id === 'mine' ? {} : null), message: async (a) => { sent.push(a); return { channel: 'stdin', bytes: 1 }; } };
  const out = await createCompose({ callCore, manager: () => mgr }).assign({ task_id: 't2', worker_id: 'adopted' });
  assert.deepStrictEqual([out.task.state, out.delivered.sent, sent.length], ['assigned', false, 0]);
  assert.match(out.delivered.reason, /not launched by this session/);
  const none = await createCompose({ callCore, manager: () => null }).assign({ task_id: 't2', worker_id: 'mine' });
  assert.deepStrictEqual([none.delivered.sent, sent.length], [false, 0], 'no run manager open: no channel either');
});
