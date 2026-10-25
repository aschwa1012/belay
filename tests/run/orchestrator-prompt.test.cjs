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
  const raw = fs.readFileSync(TEMPLATE, 'utf8');
  const text = raw.replace(/\{\{\/?memory_(use|outcome)\}\}/g, ''); // as a run without notes renders it
  assert.ok(raw.split('\n').length < 120, 'the template stays under 120 lines');
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
  // ADR 0054 (the operator, 2026-10-24): the rule is one line, backed by the launch surface (Edit and Write, no Bash), and git reads go through belay.
  assert.match(text, /^- You may edit files for records and trivial fixes; delegate real code work to a worker; you have no shell\.$/m, 'the edit rule, on one line');
  assert.match(text, /Read git state with `mcp__belay__git_read`/, 'the git reads are belay\'s');
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
// ADR 0054 rewrote the role rule (orchestrator.md 8-10, the twin 10-12) to name the surface and git_read, and line 4 (the
// twin's 6) to say the code work is not the orchestrator's (the operator, 2026-10-24: it may edit records and trivial fixes).
const AMD6_LINES = {
  // ADR 0053: the worktree rule of thumb (orchestrator.md 116, the interactive twin 120 once its pause paragraph is taken out).
  // ADR 0054 amendment 1: the Review standard's first two lines (orchestrator.md 107-108, the twin 111-112) say the tree is read-only.
  'orchestrator.md': [4, 8, 9, 10, 24, 32, 33, 35, 36, 37, 60, 61, 67, 71, 75, 81, 82, 83, 97, 98, 99, 100, 101, 107, 108, 116, 118],
  'orchestrator-interactive.md': [6, 10, 11, 12, 26, 34, 35, 37, 38, 39, 52, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 71, 75, 78, 79, 85, 86, 87, 92, 98, 101, 102, 103, 104, 105, 111, 112, 120, 122],
};

test('memory rules: the placeholder sits at the end of an existing line, and an empty substitution is the base prompt byte for byte', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    let now = lf(fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8')).replace(/\{\{\/?memory_(use|outcome)\}\}/g, '').replace(/ <!-- belay-prompt \d[\d.]* -->/, ''); // the 0.3.0 version marker is not base text; the notes markers (ADR 0047 amendment of 2026-10-22): a run without notes drops them
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
  assert.match(text, /`absence_established` is true only when both modes ran and no row reached the relevance floor[^\n]*`false` is normal on a populated scope[^\n]*`low_relevance`[^\n]*modes_failed/, 'false is not read as not searched; a low_relevance row is likely unrelated (ADR 0057)');
  assert.doesNotMatch(text, /not searched properly yet/, 'the old, untrue reading is gone');
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
test('both orchestrator prompts ask for 1 to 3 memory_queries only when the first-message index is on, and worker_spawn lists the field', () => {
  const { substituteLevers, parseLevers } = require(path.join(ROOT, 'src/cli/run-levers.cjs'));
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const text = fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8');
    assert.strictEqual(text.split('{{memory_queries_line}}').length, 2, `${f} carries the placeholder once`);
    assert.ok(!/memory_queries/.test(text.replace('{{memory_queries_line}}', '')), `${f}: the sentence lives only behind the placeholder`);
    const on = substituteLevers(text, parseLevers({ memory: { first_message_index: true } }), 0);
    assert.match(on.text, /give 1 to 3 `memory_queries`: task lines/, `${f} asks for memory_queries with the index on`);
    assert.match(on.text, /not the finding you expect it to make/, `${f}: situations, not findings`);
    assert.strictEqual(on.substituted.memory_queries_line, 1);
    // D58: with every lever off the prompt asks for nothing the run never reads.
    for (const lv of [parseLevers({}), parseLevers({ memory: { capture: true, rules: true } })]) {
      const off = substituteLevers(text, lv, 0);
      assert.ok(!/memory_queries/.test(off.text) && !off.text.includes('{{'), `${f}: off asks for no memory_queries`);
      assert.ok(!('memory_queries_line' in off.substituted));
    }
  }
  const T = require(path.join(ROOT, 'src/mcp/tools.cjs'));
  const spawn = T.toolsFor('orchestrator', { queries: true }).find((t) => t.name === 'worker_spawn');
  assert.ok(spawn.inputSchema.properties.memory_queries, 'worker_spawn lists memory_queries');
  assert.strictEqual(spawn.inputSchema.properties.memory_queries.type, 'array');
});

// ADR 0047 amendment of 2026-10-22, decision 7: a notes run renders the memory bullet as four points; a run without notes renders what it always did.
const MARKERS = /\{\{\/?memory_(use|outcome)\}\}/g;
const LV = require(path.join(ROOT, 'src/cli/run-levers.cjs'));
const render = (f, memory_levers) => LV.substituteLevers(fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8').replace(/\r\n/g, '\n'), { max_fix_rounds: 2, fix_cutoff: 'cap-only', memory_levers, rules_text: fs.readFileSync(RULES, 'utf8') }, 0);

test('notes render: the memory bullet is the four points, a run outcome is a summary, and every tool it names is on the notes listing', () => {
  const T = require(path.join(ROOT, 'src/mcp/tools.cjs'));
  const listed = new Set(T.toolsFor('orchestrator', { notes: true }).map((t) => t.name));
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const on = render(f, { notes: true, rules: true });
    const text = on.text;
    assert.ok(!MARKERS.test(text) && !/\{\{/.test(text), `${f}: no marker or placeholder is left`);
    assert.match(text, /Search before you plan[^\n]*memory_search[^\n]*no namespace/, `${f}: search with no namespace`);
    assert.match(text, /Store a lesson a later run would trip on as a note[^\n]*memory_store[^\n]*namespace: "project"[^\n]*kind/, `${f}: lessons as notes`);
    assert.match(text, /Record your decisions and the outcome with \`namespace: "summary"\`/, `${f}: outcomes to summary`);
    assert.match(text, /Never tell a worker to write memory with \`memory_store\`[^\n]*notes[^\n]*lease_release/, `${f}: no worker memory_store`);
    assert.ok(!/always with \`namespace: "project"\`/.test(text), `${f}: the always-project instruction is gone`);
    assert.ok(!/store the outcome in memory/.test(text), `${f}: the outcome is recorded as a summary everywhere`);
    assert.ok(!text.includes('mcp__belay__memory_verify') && !/memory_verify/.test(text), `${f}: memory_verify is not named`);
    for (const n of new Set([...text.matchAll(/mcp__belay__([a-z_]+)/g)].map((m) => m[1]))) assert.ok(listed.has(n), `${f}: mcp__belay__${n} is not on the notes listing`);
    assert.deepStrictEqual([on.substituted.memory_use, on.substituted.memory_outcome > 0], [1, true]);
  }
});

test('notes off: the render is the template with only its markers dropped, byte for byte, with or without the rules', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const raw = fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8').replace(/\r\n/g, '\n');
    const plain = raw.replace(MARKERS, '').split('{{max_fix_rounds}}').join('2');
    for (const lv of [undefined, { notes: false }, { notes: false, project: 'acme' }]) {
      const off = LV.substituteLevers(raw, { max_fix_rounds: 2, fix_cutoff: 'cap-only', memory_levers: lv }, 0).text;
      assert.strictEqual(off.includes('{{'), false, f);
      const expect = plain.split('{{memory_rules}}').join('').split('{{memory_queries_line}}').join('').split('{{memory_report_line}}').join('');
      assert.strictEqual(off.replace(/\n/g, ''), expect.split('{{fix_cutoff_rule}}').join(LV.cutoffRule('cap-only', 0, f === 'orchestrator.md' ? 'headless' : 'interactive')).replace(/\n/g, ''), `${f} ${JSON.stringify(lv)}`);
    }
    const withRules = render(f, { notes: false, rules: true }).text;
    assert.ok(withRules.includes('mcp__belay__memory_verify'), `${f}: a run without notes keeps the memory_verify rule`);
    assert.ok(!render(f, { notes: true, rules: true }).text.includes('memory_verify'), `${f}: a notes run drops it`);
  }
});
