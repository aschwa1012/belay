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

// The templates have been amended many times since 0.1.0 (the waiting text, the spawn lines, the role rule, the worktree rule, the
// hand-back and Review standard now added by belay, ...), so a line-for-line comparison with the 0.1.0 prompts needs a list of every
// changed line that goes stale with each amendment. What this test guards is narrower and does not drift: the {{memory_rules}} placeholder
// closes an existing line of the prompt and adds none, so a run with the rules off (the placeholder replaced by '') renders the prompt
// it always had on that line, and the placeholder is not a line of its own.
test('memory rules: the placeholder sits at the end of an existing line, and an empty substitution leaves that line as the base prompt had it', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const now = lf(fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8')).replace(/\{\{\/?memory_(use|outcome)\}\}/g, ''); // the notes markers: a run without notes drops them
    const base = lf(fs.readFileSync(path.join(BASE_PROMPTS, f), 'utf8'));
    assert.strictEqual(now.split('{{memory_rules}}').length, 2, `${f} carries the placeholder once`);
    assert.match(now, /\{\{memory_rules\}\}\n/, `${f}: the placeholder ends its line`);
    const at = now.split('\n').findIndex((l) => l.includes('{{memory_rules}}'));
    const line = now.split('\n')[at].replace('{{memory_rules}}', '');
    assert.ok(line.length > 0, `${f}: the placeholder is not a line of its own`);
    assert.ok(base.split('\n').includes(line), `${f}: substituting '' leaves line ${at + 1} as the 0.1.0 prompt had it`);
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
    assert.match(text, /Store a note only for what the code and the markdown of the project cannot tell[^\n]*memory_store[^\n]*namespace: "project"`\s+and `kind`/, `${f}: notes, held to the bar`);
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
      const expect = plain.split('{{memory_rules}}').join('').split('{{memory_queries_line}}').join('').split('{{memory_report_line}}').join('').split('{{permission_line}}').join('');
      assert.strictEqual(off.replace(/\n/g, ''), expect.split('{{fix_cutoff_rule}}').join(LV.cutoffRule('cap-only', 0, f === 'orchestrator.md' ? 'headless' : 'interactive')).replace(/\n/g, ''), `${f} ${JSON.stringify(lv)}`);
    }
    const withRules = render(f, { notes: false, rules: true }).text;
    assert.ok(withRules.includes('mcp__belay__memory_verify'), `${f}: a run without notes keeps the memory_verify rule`);
    assert.ok(!render(f, { notes: true, rules: true }).text.includes('memory_verify'), `${f}: a notes run drops it`);
  }
});

// The try-3 wording: the review is evaluated by belay at the reviewer's hand-back (the orchestrator does not call task_evaluate on it);
// integrate's end-of-run checks are the evaluation of the final head; the memory namespaces and the unverified status are explained.
test('both orchestrator prompts: the review step does not call task_evaluate, integrate evaluates the final head, memory names are explained', () => {
  for (const f of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const text = fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8').replace(/\r\n/g, '\n');
    const step4 = text.slice(text.indexOf('4. belay evaluates the review itself'), text.indexOf('5. Read the `kind: "verdict"`'));
    assert.ok(step4.length > 0, `${f}: step 4 is the release evaluation`);
    assert.match(step4, /do not call `mcp__belay__task_evaluate`\n\s+on it: read the result in the reviewer's wake/, `${f}: no task_evaluate on a review`);
    assert.match(step4, /not or could not be evaluated, or a stop, pause or park cut it short, call `mcp__belay__task_evaluate` on the review yourself with the reviewed task's worktree/, `${f}: the fallback when no release evaluation lands`);
    assert.doesNotMatch(text, /reviewer's (turn ends \(wait on its id\)|wake comes \(its turn ended\)), call/, `${f}: the stale instruction is gone`);
    assert.doesNotMatch(text, /evaluate again\. If the coder judged/, `${f}: no second evaluate after a late hand-back`);
    assert.match(text, /merges them and, unless you pass `evaluate: false`, re-runs their checks on the merged head; `checks` adds commands to run on that head only \(for example the full suite\)\. You choose when what runs: per merge, at the end, or both;/, `${f}: integrate re-runs checks unless evaluate is false, and takes checks`);
    assert.ok(!/files_within_owned is judged against the task's own base/.test(text), `${f}: why task_evaluate is not that check is the refusal's own text (task_evaluate against another tree, below)`);
    assert.ok(!/belay refuses it \(E_BUSY\)/.test(text), `${f}: a task_evaluate of the same task and tree joins the release evaluation; E_BUSY is only another tree or base`);
    assert.match(text, /`project` is stored as `project\/<name>` and `summary` \(a run outcome, with a `title`\) as `summary\/<name>`/, `${f}: the project suffix`);
    assert.match(text, /A row stays status unverified until a `mcp__belay__memory_verify` with a receipt; your summary is found by title and kept as it is./, `${f}: what unverified means`);
  }
});

test('task_evaluate against another tree refuses with the integrate pointer', () => {
  const W = require(path.join(ROOT, 'src/core/methods-worktree.cjs'));
  const task = { id: 't1', worktree: { path: 'C:/r.worktrees/t1', branch: 'belay/t1', base_sha: 'b' } };
  assert.throws(() => W.evaluateTarget(task, { worktree: 'C:/r.worktrees/integrate' }), (e) => e.code === 'E_PRECONDITION'
    && /the merged head is checked by integrate, whose checks run on its tree; task_evaluate judges a task against its own base/.test(e.message));
});
