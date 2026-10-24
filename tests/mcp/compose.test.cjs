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
