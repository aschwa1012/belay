'use strict';
// worker_spawn's harness-only fields are refused at the MCP boundary, in the orchestrator role, by name, before the run manager sees them.
// `tools` matters most: the built-in list may only be narrowed through allowed_tools (ADR 0024 amendment 4), never named directly.

const test = require('node:test');
const assert = require('node:assert');
const { validateArgs, HARNESS_ONLY } = require('../../src/mcp/tools.cjs');

const base = { substrate: 'claude-code', worktree: 'C:/w', prompt: 'hi' };

for (const field of ['native_memory', 'tools', 'sandbox', 'max_budget_usd']) {
  test(`worker_spawn refuses ${field} from the orchestrator role as a harness field`, () => {
    assert.ok(HARNESS_ONLY.worker_spawn.includes(field));
    assert.throws(() => validateArgs('worker_spawn', { ...base, [field]: field === 'tools' ? ['Read', 'Bash'] : 'x' }, { role: 'orchestrator' }),
      (e) => e.code === 'E_ARGS' && e.detail.reason === 'harness_only' && e.detail.field === field);
  });
}

test('worker_spawn still accepts allowed_tools, permission_prompt and permit_wait_ms (ADR 0020 makes the channel optional per spawn)', () => {
  const a = { ...base, allowed_tools: ['Read', 'mcp__belay'], permission_prompt: true, permit_wait_ms: 20000 };
  assert.deepStrictEqual(validateArgs('worker_spawn', a, { role: 'orchestrator' }), a);
});
