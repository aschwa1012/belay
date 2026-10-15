'use strict';
// note-review-surface.test.cjs — wave 4: the small surfaces around the review job: its levers, its launch budget argument, its empty
// belay tool listing and its reserved worker id.

const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../../src/run/launch.cjs');
const tools = require('../../src/mcp/tools.cjs');
const { parseMemoryBlock, DEFAULTS, TYPES } = require('../../src/core/memory-levers.cjs');

test('S1: the review levers have defaults, types and validation; note_review needs notes', () => {
  assert.deepStrictEqual([DEFAULTS.note_review, DEFAULTS.note_review_model, DEFAULTS.note_review_cost_cap_usd], [false, 'claude-haiku-5-5', 0.05]);
  assert.strictEqual(TYPES.note_review_cost_cap_usd.type, 'number');
  assert.strictEqual(TYPES.note_review_model.type, 'string');
  assert.ok(parseMemoryBlock({ project: 'p', notes: true, note_review: true, note_review_model: 'claude-sonnet-5-5', note_review_cost_cap_usd: 0.25 }).value);
  for (const bad of [{ note_review: true }, { project: 'p', notes: true, note_review_cost_cap_usd: 0 }, { project: 'p', notes: true, note_review_cost_cap_usd: 9 }, { project: 'p', notes: true, note_review_model: 'bad model' }]) {
    assert.ok(parseMemoryBlock(bad).error, JSON.stringify(bad));
  }
});

test('S2: --max-budget-usd is on the launch argv only when a budget is given', () => {
  const base = { workerId: 'w', mcpJsonPath: 'a', settingsPath: 'b' };
  assert.ok(!L.claudeLaunchArgv(base).includes('--max-budget-usd'));
  const argv = L.claudeLaunchArgv({ ...base, maxBudgetUsd: 0.05 });
  assert.strictEqual(argv[argv.indexOf('--max-budget-usd') + 1], '0.05');
});

test('S3: the review job\'s adapter lists no tool and allows none; the id prefix cannot be chosen by the orchestrator', () => {
  assert.deepStrictEqual(tools.toolsFor('worker', { workerId: 'notereview-t1' }), []);
  assert.strictEqual(tools.allows('worker', 'memory_search', 'notereview-t1'), false);
  assert.ok(tools.toolsFor('worker', { workerId: 'w1' }).length > 0);
  assert.throws(() => tools.validateArgs('worker_spawn', { worker_id: 'notereview-x', substrate: 'claude-code', prompt: 'p' }), (e) => e.code === 'E_ARGS' && /reserved/.test(e.message));
});
