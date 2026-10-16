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
  // Operator 2026-10-15: the orchestrator passes agent_type; a reviewer's effort high is the built-in default for that type.
  assert.match(text, /`agent_type`, always \(`coder\|tester\|reviewer\|researcher`/, 'the template always passes agent_type');
  assert.match(text, /only when your plan needs another/, 'model and effort only to override');
  assert.match(text, /spawned with `agent_type: "reviewer"`/, 'the review steps spawn the reviewer by type');
  assert.ok(!/reviewers `"high"`/.test(text), 'no instruction to pass effort high by hand');
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
// The 0.1.0 prompts, kept as a fixture so the test needs no git history.
const BASE_PROMPTS = path.join(__dirname, '..', 'fixtures', 'v0.1.0', 'src', 'run', 'prompts');
const RULES = path.join(ROOT, 'src/run/prompts/memory-rules.md');
const lf = (s) => s.replace(/\r\n/g, '\n');

// ADR 0037 amendment 6 rewrote these 1-based lines of the interactive twin after 0.1.0 (the waiting text);
// interactive-prompt.test.cjs pins their new wording, so here they are taken from the base before comparing.
// The operator's 2026-10-15 ruling rewrote the two spawn lines of each prompt (agent_type always; no hand-passed effort); same treatment.
const AMD6_LINES = {
  'orchestrator.md': [32, 33, 81],
  'orchestrator-interactive.md': [34, 35, 52, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 78, 79, 85, 92, 98],
};

test('memory rules: the placeholder sits at the end of an existing line, and an empty substitution is the base prompt byte for byte', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    let now = lf(fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8'));
    const base = lf(fs.readFileSync(path.join(BASE_PROMPTS, f), 'utf8'));
    // ADR 0034 amendment 2: the interactive twin adds one paragraph (and its blank line) on the embedder-failure pause.
    if (f === 'orchestrator-interactive.md') {
      const n = now.split('\n');
      const at = n.findIndex((l) => l.startsWith('If a memory call or a worker tool fails saying the run is paused for an embedder failure'));
      assert.ok(at > 0 && n[at - 1] === '' && n[at + 1] === '', 'the embedder-failure pause paragraph is in the interactive twin');
      n.splice(at, 2);
      now = n.join('\n');
    }
    if (AMD6_LINES[f]) {
      const n = now.split('\n'); const b = base.split('\n');
      for (const i of AMD6_LINES[f]) { assert.notStrictEqual(n[i - 1], b[i - 1], `${f}:${i} is an amendment 6 line`); n[i - 1] = b[i - 1]; }
      now = n.join('\n');
    }
    assert.strictEqual(now.split('{{memory_rules}}').length, 2, `${f} carries the placeholder once`);
    assert.match(now, /\{\{memory_rules\}\}\n/, `${f}: the placeholder ends its line`);
    assert.strictEqual(now.split('\n').length, base.split('\n').length, `${f}: no line added`);
    assert.strictEqual(Buffer.compare(Buffer.from(now.split('{{memory_rules}}').join('')), Buffer.from(base)), 0,
      `${f}: substituting '' gives the base prompt byte for byte`);
  }
});

test('memory rules: the text stays within 1,200 bytes and carries each rule the ADR names', () => {
  const text = lf(fs.readFileSync(RULES, 'utf8')); // the checkout may be CRLF; substitution matches the prompt's endings
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

// The paired write/search contract: the orchestrator names the situations a worker will be in as task lines, so the worker's
// first-message index is searched by situation and not only by the spec's own words.
test('both orchestrator prompts ask for 1 to 3 memory_queries, and worker_spawn lists the field', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const text = fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8');
    assert.match(text, /give 1 to 3 `memory_queries`: task lines/, `${f} asks for memory_queries`);
    assert.match(text, /not the finding you expect it to make/, `${f}: situations, not findings`);
  }
  const T = require(path.join(ROOT, 'src/mcp/tools.cjs'));
  const spawn = T.toolsFor('orchestrator').find((t) => t.name === 'worker_spawn');
  assert.ok(spawn.inputSchema.properties.memory_queries, 'worker_spawn lists memory_queries');
  assert.strictEqual(spawn.inputSchema.properties.memory_queries.type, 'array');
});
