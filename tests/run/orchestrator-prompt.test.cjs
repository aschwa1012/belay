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

// ADR 0040 section 6: the memory rules text is substituted at {{memory_rules}}, only when the lever is on.
const { execFileSync } = require('node:child_process');
const BASE_SHA = '93b1a0b';
const RULES = path.join(ROOT, 'src/run/prompts/memory-rules.md');
const lf = (s) => s.replace(/\r\n/g, '\n');

test('memory rules: the placeholder sits at the end of an existing line, and an empty substitution is the base prompt byte for byte', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const now = lf(fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8'));
    const base = lf(execFileSync('git', ['show', `${BASE_SHA}:src/run/prompts/${f}`], { cwd: ROOT, encoding: 'utf8' }));
    assert.strictEqual(now.split('{{memory_rules}}').length, 2, `${f} carries the placeholder once`);
    assert.match(now, /\{\{memory_rules\}\}\n/, `${f}: the placeholder ends its line`);
    assert.strictEqual(now.split('\n').length, base.split('\n').length, `${f}: no line added`);
    assert.strictEqual(Buffer.compare(Buffer.from(now.split('{{memory_rules}}').join('')), Buffer.from(base)), 0,
      `${f}: substituting '' gives the base prompt byte for byte`);
  }
});

test('memory rules: the text stays within 1,200 bytes and carries each rule the ADR names', () => {
  const text = fs.readFileSync(RULES, 'utf8');
  assert.ok(Buffer.byteLength(text) <= 1200, `rules are ${Buffer.byteLength(text)} bytes`);
  assert.ok(text.startsWith('\n'), 'the text opens on a new line, so the placeholder needs no space before it');
  assert.match(text, /view: "index"/, 'index first');
  assert.match(text, /memory_timeline/, 'a timeline');
  assert.match(text, /memory_retrieve[^\n]*`ids`[^\n]*only/, 'full rows only for what matters');
  assert.match(text, /memory_ids/, 'cite ids');
  assert.match(text, /absence_established: false[^\n]*not searched properly yet/, 'absence is not established');
  assert.match(text, /`unverified` row as a claim/, 'an unverified row is never presented as fact');
  assert.match(text, /`refuted`/, 'refuted rows');
  const named = [...text.matchAll(/mcp__belay__([a-z_]+)/g)].map((m) => m[1]);
  const T = require(path.join(ROOT, 'src/mcp/tools.cjs'));
  const orch = new Set(T.toolsFor('orchestrator').map((t) => t.name));
  // memory_timeline and memory_verify arrive with the tool surface (ADR 0040 section 4).
  for (const n of ['memory_timeline', 'memory_verify']) orch.add(n);
  for (const n of named) assert.ok(orch.has(n), `mcp__belay__${n} is not an orchestrator tool`);
  assert.ok(!/\r/.test(text), 'LF only');
});
