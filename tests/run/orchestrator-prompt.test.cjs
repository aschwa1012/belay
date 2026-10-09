'use strict';
// The orchestrator prompt template (build step S7) names tools by their exact MCP names; an invented
// name would send a real Opus 5.5 orchestrator at a tool that does not exist.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = path.join(ROOT, 'src/run/prompts/orchestrator.md');

test('orchestrator prompt: every mcp__belay__ tool name the template mentions is one tools.cjs lists', () => {
  const text = fs.readFileSync(TEMPLATE, 'utf8');
  assert.ok(text.split('\n').length < 120, 'the template stays under 120 lines');
  const T = require(path.join(ROOT, 'src/mcp/tools.cjs'));
  const listed = new Set();
  for (const role of T.ROLES) for (const t of T.toolsFor(role)) listed.add(t.name);
  assert.ok(listed.has('task_create') && listed.has('lease_release'), 'tools.cjs lists task_create and lease_release');
  const named = [...new Set([...text.matchAll(/mcp__belay__([a-z_]+)/g)].map((m) => m[1]))];
  for (const n of named) assert.ok(listed.has(n), `mcp__belay__${n} is not a tool tools.cjs lists`);
  for (const must of ['task_create', 'task_assign', 'worker_spawn', 'worker_wait', 'task_evaluate', 'task_list']) {
    assert.ok(named.includes(must), `the template names mcp__belay__${must}`);
  }
  // ADR 0028 amendment 1 (operator, 2026-10-02): reviewers are spawned at effort high.
  assert.match(text, /reviewers `"high"`/, 'the template says reviewers are spawned at effort high');
  assert.match(text, /spawned with `effort: "high"`/, 'the review steps spawn the reviewer at effort high');
  // H4 (operator): the orchestrator itself searches memory before creating tasks and stores at decision points.
  assert.match(text, /always with `namespace: "project"`/, 'a namespace that outlives the run');
  assert.match(text, /Before you create any task, call `mcp__belay__memory_search` with a `query` on the brief's subject/);
  assert.match(text, /store the outcome in memory, say why, then end a turn/);
  assert.match(text, /`mcp__belay__memory_store` with `text`[\s\S]*after each review verdict[\s\S]*when you end the run[\s\S]*open findings/);
  assert.ok(named.includes('memory_search') && named.includes('memory_store'), 'the template names both memory tools');
  assert.ok(text.indexOf('memory_search') < text.indexOf('mcp__belay__task_create'), 'the search instruction precedes task creation');
  assert.match(text, /You use no Bash, Edit, Write or NotebookEdit at all/, 'the no-work rule stays');
  // The orchestrator's own listing is the one the template addresses.
  const orch = new Set(T.toolsFor('orchestrator').map((t) => t.name));
  for (const n of named) assert.ok(orch.has(n), `mcp__belay__${n} is not on the orchestrator's listing`);
});
