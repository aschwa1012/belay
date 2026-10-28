'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-levers.test.cjs — ADR 0031 decisions 3 to 6: the spec's max_fix_rounds and fix_cutoff (validation,
// substitution into the orchestrator's prompt, pass-through), the receipt's levers and review_rounds, and the
// shipped template's placeholders and rubric. Sandboxed under the OS temp dir; the fake orchestrator.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const FAKE_TASKS = `${ROOT}/tests/cli/fakes/core-fake-tasks.cjs`;
const fwd = (p) => String(p).split(path.sep).join('/');
const { parseLevers, substituteLevers } = require('../../src/cli/run-levers.cjs');

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
}

// One run of the CLI against a sandbox. Returns { status, out, orchDir }.
function go(prompt, specExtra, envExtra = {}) {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-levers-')));
  fs.mkdirSync(`${dir}/wt`);
  fs.writeFileSync(`${dir}/prompt.txt`, prompt);
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify({
    worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, run_id: `levers-${Date.now()}`,
    orchestrator_dir: `${dir}/orch`, poll_ms: 300, startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...specExtra,
  }));
  const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-levers', ...envExtra };
  const r = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', `${dir}/.belay`, ...(envExtra.NO_JSON ? [] : ['--json'])], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  return { dir, status: r.status, stdout: r.stdout, stderr: r.stderr, orchDir: `${dir}/orch` };
}

test('levers: parseLevers defaults and validation', () => {
  assert.deepStrictEqual(parseLevers({}), { max_fix_rounds: 2, fix_cutoff: 'orchestrator', fix_hard_cap: 5, fix_hard_cap_source: 'default, no run timeout', on_embedder_failure: 'required' });
  assert.deepStrictEqual(parseLevers({ max_fix_rounds: 0, fix_cutoff: 'cap-only' }), { max_fix_rounds: 0, fix_cutoff: 'cap-only', fix_hard_cap: 5, fix_hard_cap_source: 'default, no run timeout', on_embedder_failure: 'required' });
  assert.deepStrictEqual(parseLevers({ max_fix_rounds: 5 }), { max_fix_rounds: 5, fix_cutoff: 'orchestrator', fix_hard_cap: 5, fix_hard_cap_source: 'default, no run timeout', on_embedder_failure: 'required' });
  for (const bad of [-1, 1.5, '2', null, NaN, Infinity, 2 ** 60, true, [], {}]) {
    assert.match(parseLevers({ max_fix_rounds: bad }).error, /max_fix_rounds must be a non-negative integer/, String(bad));
  }
  for (const bad of ['Orchestrator', '', 'both', 1, null, true]) {
    assert.match(parseLevers({ fix_cutoff: bad }).error, /fix_cutoff must be one of orchestrator, cap-only/, String(bad));
  }
});

test('levers: substituteLevers replaces every placeholder, counts them, and passes a plain prompt through', () => {
  const lv = { max_fix_rounds: 3, fix_cutoff: 'cap-only' };
  const out = substituteLevers('a {{max_fix_rounds}} b {{max_fix_rounds}} c {{fix_cutoff_rule}} d', lv, 0);
  assert.strictEqual(out.text, 'a 3 b 3 c Do not stop fix rounds before the fix-round limit. d');
  assert.deepStrictEqual(out.substituted, { max_fix_rounds: 2, fix_cutoff_rule: 1 });
  const plain = substituteLevers('no placeholders here\n', lv, 0);
  assert.strictEqual(plain.text, 'no placeholders here\n');
  assert.deepStrictEqual(plain.substituted, { max_fix_rounds: 0, fix_cutoff_rule: 0 });
  const orch = substituteLevers('{{fix_cutoff_rule}}', { max_fix_rounds: 2, fix_cutoff: 'orchestrator' }, 600000).text;
  for (const part of ['survived a fix round', 'new regression', 'outside the task', 'stop-and-surface', 'report a refuted step as passing',
    'the run\'s time bound (600000 ms from its start) is near, judged from the waited_ms your worker_wait answers report']) {
    assert.ok(orch.includes(part), `the orchestrator rule names "${part}"`);
  }
  const none = substituteLevers('{{fix_cutoff_rule}}', { max_fix_rounds: 2, fix_cutoff: 'orchestrator' }, 0).text;
  assert.ok(!none.includes('time bound (') && !none.includes('waited_ms'), 'timeout_ms 0: the time condition is dropped');
  assert.match(none, /The run has no time bound\./);
  assert.match(none, /owned set\. Name the condition/);
});

test('run: bad max_fix_rounds and fix_cutoff exit 2 before anything is created; good values run', () => {
  for (const extra of [{ max_fix_rounds: -1 }, { max_fix_rounds: 1.5 }, { max_fix_rounds: '2' }, { fix_cutoff: 'sometimes' }]) {
    const r = go('hi\n', extra);
    try {
      assert.strictEqual(r.status, 2, `${JSON.stringify(extra)}: exit ${r.status}: ${r.stderr}`);
      assert.match(r.stderr + r.stdout, /max_fix_rounds must be a non-negative integer|fix_cutoff must be one of/);
      assert.ok(!fs.existsSync(`${r.dir}/.belay`), 'no data dir was created');
    } finally { cleanup(r.dir); }
  }
  const ok = go('hi\n', { max_fix_rounds: 0, fix_cutoff: 'cap-only' });
  try {
    assert.strictEqual(ok.status, 0, ok.stderr.slice(-600));
    assert.deepStrictEqual(JSON.parse(ok.stdout).levers, { max_fix_rounds: 0, fix_cutoff: 'cap-only', fix_hard_cap: 5, fix_hard_cap_source: 'default, no run timeout', on_embedder_failure: 'keyword', substituted: { max_fix_rounds: 0, fix_cutoff_rule: 0 } });
  } finally { cleanup(ok.dir); }
});

test('run: the orchestrator receives the prompt with both placeholders substituted; a plain prompt is unchanged; defaults apply', () => {
  const tpl = 'cap {{max_fix_rounds}} rounds. {{fix_cutoff_rule}} again {{max_fix_rounds}}\n';
  const a = go(tpl, { max_fix_rounds: 4, fix_cutoff: 'cap-only' });
  try {
    assert.strictEqual(a.status, 0, a.stderr.slice(-600));
    assert.strictEqual(fs.readFileSync(`${a.orchDir}/prompt.txt`, 'utf8'), 'cap 4 rounds. Do not stop fix rounds before the fix-round limit. again 4\n');
  } finally { cleanup(a.dir); }

  const b = go(tpl, {});
  try {
    assert.strictEqual(b.status, 0, b.stderr.slice(-600));
    const text = fs.readFileSync(`${b.orchDir}/prompt.txt`, 'utf8');
    assert.ok(text.startsWith('cap 2 rounds. You may stop fix rounds before the fix-round limit'), text);
    assert.ok(!text.includes('{{'), 'no placeholder is left');
    assert.deepStrictEqual(JSON.parse(b.stdout).levers, { max_fix_rounds: 2, fix_cutoff: 'orchestrator', fix_hard_cap: 5, fix_hard_cap_source: 'default, no run timeout', on_embedder_failure: 'keyword', substituted: { max_fix_rounds: 2, fix_cutoff_rule: 1 } });
    assert.match(text, /The run has no time bound\./, 'timeout_ms defaults to 0');
  } finally { cleanup(b.dir); }

  const plain = 'line one {not a placeholder}\nline two\n';
  const c = go(plain, {});
  try {
    assert.strictEqual(c.status, 0, c.stderr.slice(-600));
    assert.strictEqual(fs.readFileSync(`${c.orchDir}/prompt.txt`, 'utf8'), plain);
  } finally { cleanup(c.dir); }
});

test('run: the receipt carries levers and review_rounds (this run\'s verdict tasks only); a failed read is null with its reason', () => {
  const a = go('hi\n', { max_fix_rounds: 1 }, { BELAY_FAKE_CORE: FAKE_TASKS, FAKE_TASKS_MODE: 'reviews' });
  try {
    assert.strictEqual(a.status, 0, a.stderr.slice(-600));
    const rc = JSON.parse(a.stdout);
    assert.deepStrictEqual(rc.levers, { max_fix_rounds: 1, fix_cutoff: 'orchestrator', fix_hard_cap: 5, fix_hard_cap_source: 'default, no run timeout', on_embedder_failure: 'keyword', substituted: { max_fix_rounds: 0, fix_cutoff_rule: 0 } });
    assert.strictEqual(rc.review_rounds, 2, 'two review tasks of this run; the work task and the other run\'s review are not counted');
    assert.strictEqual(rc.review_rounds_reason, null);
    assert.strictEqual(JSON.parse(fs.readFileSync(`${a.orchDir}/run.json`, 'utf8')).review_rounds, 2, 'run.json agrees');
  } finally { cleanup(a.dir); }

  const t = go('hi\n', {}, { BELAY_FAKE_CORE: FAKE_TASKS, FAKE_TASKS_MODE: 'reject', NO_JSON: '1' });
  try {
    assert.strictEqual(t.status, 0, t.stderr.slice(-600));
    assert.match(t.stdout, /levers: max_fix_rounds 2, fix_hard_cap 5 \(default, no run timeout\), fix_cutoff orchestrator, on_embedder_failure keyword; review_rounds: unknown \(task\.list failed: .*PROBE/);
  } finally { cleanup(t.dir); }

  const r = go('hi\n', {}, { BELAY_FAKE_CORE: FAKE_TASKS, FAKE_TASKS_MODE: 'reject' });
  try {
    const rc = JSON.parse(r.stdout);
    assert.strictEqual(rc.review_rounds, null);
    assert.match(rc.review_rounds_reason, /task\.list failed/);
  } finally { cleanup(r.dir); }

  const z = go('hi\n', {}); // the real store, no tasks
  try {
    assert.strictEqual(JSON.parse(z.stdout).review_rounds, 0);
    assert.match(fs.readFileSync(`${z.orchDir}/run.json`, 'utf8'), /"review_rounds": 0/);
  } finally { cleanup(z.dir); }
});

test('template: the shipped orchestrator prompt has both placeholders and the four rubric clauses', () => {
  const text = fs.readFileSync(`${ROOT}/src/run/prompts/orchestrator.md`, 'utf8');
  assert.strictEqual((text.match(/\{\{max_fix_rounds\}\}/g) || []).length, 2);
  assert.strictEqual((text.match(/\{\{fix_cutoff_rule\}\}/g) || []).length, 1);
  // Wording audit: the Review standard is one source file that belay appends to a reviewer's first message (handback.cjs); the
  // orchestrator prompt no longer carries it and the orchestrator no longer copies it into a prompt.
  assert.ok(!/## Review standard/.test(text), 'the prompt does not carry the standard');
  const standard = fs.readFileSync(`${ROOT}/src/run/prompts/review-standard.md`, 'utf8').replace(/\r\n/g, '\n');
  assert.match(standard, /^## Review standard\n/);
  for (const c of ['(a) breaks one of the brief\'s stated acceptance criteria', '(b) breaks an invariant in the repository\'s `CLAUDE.md`', '(c) is a regression', '(d) causes a hang, data loss, an orphaned process or a security hole']) {
    assert.ok(standard.includes(c), c);
  }
  assert.match(standard, /an ordering or input the brief admits makes a\s+stated assertion fail\. Forcing a reachable ordering is evidence; passing when run does not clear it;/, 'ADR 0031 amendment 1: clause (a)');
  assert.match(standard, /names its\s+clause/);
  assert.match(standard, /^## Review standard\nThe tree under review is read-only: run its tests, but edit, write, commit or stash nothing in it; write probes and scratch files only in the scratch folder your task names/, 'ADR 0054 amendment 1: inside the section a reviewer receives');
  assert.match(text, /One with `detail.tree_changed: true` is suspect, holds or refuted/, 'ADR 0054 amendment 1: a flagged review is suspect');
  assert.match(standard, /only if it has at least\s+one blocking finding/);
  assert.match(text, /belay appends the Review standard and the verdict hand-back rule to the reviewer's first message; do not repeat them/);
  assert.ok(!/verbatim, in the reviewer's prompt/.test(text), 'the orchestrator is not asked to copy it');
  assert.match(text, /answer carries a\s+`fix_notice` with the count/);
  assert.match(text, /A failed acceptance check is not a fix round/); // ADR 0058: worded beside fix_from_review
  assert.ok(!/\bland\b/.test(text), 'no "land" wording');
  const done = substituteLevers(text, { max_fix_rounds: 2, fix_cutoff: 'orchestrator' }, 0);
  assert.ok(!done.text.includes('{{'), 'substitution leaves no placeholder');
  assert.deepStrictEqual(done.substituted, { max_fix_rounds: 2, fix_cutoff_rule: 1 });
});

// ---- ADR 0041 decision 1 and ADR 0040 decision 6: the spec's `memory` block and the {{memory_rules}} placeholder ----

test('memory levers: parseLevers omits the block when absent or all-default, and refuses each bad key and each missing prerequisite', () => {
  assert.deepStrictEqual(parseLevers({ memory: {} }), parseLevers({}));
  assert.deepStrictEqual(parseLevers({ memory: { redact: true, alpha: 0.3, summaries: 'off' } }), parseLevers({}));
  const ok = parseLevers({ memory: { capture: true, observations: true, project: 'acme', notes: false, project_writes: true, summaries: 'mechanical', index_bytes: 4096 } });
  assert.strictEqual(ok.memory_levers.project, 'acme');
  assert.strictEqual(ok.memory_levers.summaries, 'mechanical');
  assert.strictEqual(ok.memory_levers.redact, true, 'defaults are filled in');
  const bad = [
    [{ colour: 1 }, /memory\.colour is not a known memory lever/],
    [{ redact: 'yes' }, /memory\.redact must be true or false/],
    [{ alpha: 1.5 }, /memory\.alpha/], [{ alpha: '0.5' }, /memory\.alpha/],
    [{ summaries: 'full' }, /memory\.summaries must be one of off, mechanical/],
    [{ project: 'Bad Name' }, /memory\.project/], [{ project: '' }, /memory\.project/], [{ project: 'x'.repeat(65) }, /memory\.project/],
    [{ index_bytes: 4097 }, /memory\.index_bytes/], [{ index_bytes: 0 }, /memory\.index_bytes/], [{ index_bytes: 1.5 }, /memory\.index_bytes/],
    [{ bottle_bytes: 262145 }, /memory\.bottle_bytes/],
    [{ observations: true }, /memory\.observations needs memory\.capture/],
    [{ project_writes: true }, /memory\.project_writes needs memory\.project/],
    [{ project: 'acme', project_writes: true, redact: false }, /memory\.redact false cannot be combined with memory\.project_writes true/],
    [{ project: 'acme', project_writes: true }, /memory\.project_writes cannot be combined with memory\.notes.*notes: false/],
    [{ project: 'acme', notes: true, project_writes: true }, /memory\.project_writes cannot be combined with memory\.notes/],
    [{ held_visibility: 'hide' }, /memory\.held_visibility must be one of withhold, warn/],
    [{ held_breaker_count: 0 }, /memory\.held_breaker_count/], [{ held_breaker_count: 501 }, /memory\.held_breaker_count/], [{ held_breaker_count: 1.5 }, /memory\.held_breaker_count/],
    [{ held_breaker_share: 0 }, /memory\.held_breaker_share/], [{ held_breaker_share: 1.01 }, /memory\.held_breaker_share/], [{ held_breaker_share: '0.2' }, /memory\.held_breaker_share/],
    [{ capture: true, summaries: 'mechanical' }, /memory\.summaries "mechanical" needs memory\.observations/],
  ];
  for (const [block, re] of bad) assert.match(parseLevers({ memory: block }).error, re, JSON.stringify(block));
  assert.match(parseLevers({ memory: [] }).error, /memory must be an object/);
  // the held-note levers: defaults, accepted bounds, and no prerequisite (inert without notes)
  const dflt = parseLevers({ memory: { project: 'acme' } }).memory_levers;
  assert.deepStrictEqual([dflt.held_visibility, dflt.held_breaker_count, dflt.held_breaker_share], ['withhold', 5, 0.2]);
  const held = parseLevers({ memory: { notes: false, held_visibility: 'warn', held_breaker_count: 500, held_breaker_share: 1 } }).memory_levers;
  assert.deepStrictEqual([held.held_visibility, held.held_breaker_count, held.held_breaker_share], ['warn', 500, 1]);
  for (const k of ['capture', 'cost_ledger', 'first_message_index', 'bottle', 'wrapup', 'knowledge_agent']) {
    assert.strictEqual(parseLevers({ memory: { [k]: true } }).memory_levers[k], true, k);
  }
});

test('memory levers: the rules placeholder is empty with rules off (byte-identical) and holds the trimmed rules text with rules on', () => {
  const rulesFile = `${fwd(os.tmpdir())}/belay-rules-${process.pid}.md`;
  fs.writeFileSync(rulesFile, '\n  Memory rules:\n  - one\n');
  try {
    const prompt = 'line 16\nline 17 end.{{memory_rules}}\nline 18\n';
    const off = substituteLevers(prompt, parseLevers({ memory: { capture: true } }), 0);
    assert.strictEqual(off.text, 'line 16\nline 17 end.\nline 18\n');
    assert.deepStrictEqual(off.substituted, { max_fix_rounds: 0, fix_cutoff_rule: 0 }, 'no memory_rules count with rules off');
    assert.strictEqual(substituteLevers(prompt, parseLevers({}), 0).text, off.text, 'the same as a run with no block');

    const on = parseLevers({ memory: { rules: true } }, { rulesFile });
    assert.ok(!('rules_text' in JSON.parse(JSON.stringify(on))), 'the rules text is not part of the receipt');
    const sub = substituteLevers(prompt, on, 0);
    assert.strictEqual(sub.text, 'line 16\nline 17 end.\n  Memory rules:\n  - one\nline 18\n');
    assert.strictEqual(sub.substituted.memory_rules, 1);
    const crlf = substituteLevers(prompt.replace(/\n/g, '\r\n'), on, 0).text;
    assert.ok(!/[^\r]\n/.test(crlf), 'a CRLF prompt gets CRLF rules');
    assert.ok(crlf.includes('end.\r\n  Memory rules:\r\n  - one\r\nline 18'));

    const missing = parseLevers({ memory: { rules: true } }, { rulesFile: `${rulesFile}.absent` });
    assert.match(missing.error, /memory\.rules is true but the rules text could not be read/);
  } finally { fs.rmSync(rulesFile, { force: true }); }
});

test('memory levers: the shipped prompts take the shipped rules text, and off is the placeholder-free prompt', () => {
  const real = `${ROOT}/src/run/prompts/memory-rules.md`;
  for (const name of ['orchestrator.md', 'orchestrator-interactive.md']) {
    const text = fs.readFileSync(`${ROOT}/src/run/prompts/${name}`, 'utf8');
    const off = substituteLevers(text, parseLevers({}), 600000).text;
    assert.ok(!off.includes('{{'), `${name}: no placeholder left`);
    if (!fs.existsSync(real)) continue;
    const lv = parseLevers({ memory: { rules: true } });
    assert.ok(!lv.error, lv.error);
    const on = substituteLevers(text, lv, 600000).text;
    assert.ok(on.length > off.length && on.includes('Memory rules'), name);
    assert.ok(!on.includes('{{'), `${name}: no placeholder left with rules on`);
  }
  if (!fs.existsSync(real)) assert.match(parseLevers({ memory: { rules: true } }).error, /could not be read/);
});

// The last run row of a finished run, read from a copy of the store (reading never writes to the live file).
function runRow(r) {
  const tmp = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-levers-copy-')));
  try {
    for (const x of ['', '-wal', '-shm']) if (fs.existsSync(`${r.dir}/.belay/memory.db${x}`)) fs.copyFileSync(`${r.dir}/.belay/memory.db${x}`, `${tmp}/memory.db${x}`);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(`${tmp}/memory.db`);
    try { return db.prepare('SELECT memory_levers, project FROM run ORDER BY seq DESC LIMIT 1').get(); } finally { db.close(); }
  } finally { cleanup(tmp); }
}

test('run: a bad memory block exits 2 before anything is created; a good one runs, is recorded on the run row and printed in the receipt', () => {
  const bad = go('hi\n', { memory: { observations: true } });
  try {
    assert.strictEqual(bad.status, 2, bad.stderr);
    assert.match(bad.stderr + bad.stdout, /memory\.observations needs memory\.capture/);
    assert.ok(!fs.existsSync(`${bad.dir}/.belay`));
  } finally { cleanup(bad.dir); }
  const raw = go('hi\n', { memory: { project: 'acme', project_writes: true, redact: false } });
  try {
    assert.strictEqual(raw.status, 2, raw.stderr);
    assert.match(raw.stderr + raw.stdout, /memory\.redact false cannot be combined with memory\.project_writes true/);
    assert.ok(!fs.existsSync(`${raw.dir}/.belay`));
  } finally { cleanup(raw.dir); }
  const ok = go('hi\n', { memory: { capture: true, project: 'acme' } });
  try {
    assert.strictEqual(ok.status, 0, ok.stderr.slice(-600));
    const rc = JSON.parse(ok.stdout);
    assert.strictEqual(rc.levers.memory_levers.capture, true);
    const row = runRow(ok);
    assert.strictEqual(row.project, 'acme');
    assert.strictEqual(JSON.parse(row.memory_levers).capture, true);
    // ADR 0054 decision 2 (intended): the adapter is always told the run's worktree, git_read's default, knowledge agent or not.
    assert.strictEqual(adapterArgs(ok)[adapterArgs(ok).indexOf('--worktree') + 1], `${ok.dir}/wt`, 'the knowledge agent is off, and the adapter still gets the worktree');
  } finally { cleanup(ok.dir); }
  const plain = go('hi\n', {});
  try {
    assert.strictEqual(plain.status, 0, plain.stderr.slice(-600));
    const rc = JSON.parse(plain.stdout);
    assert.ok(!('memory_levers' in rc.levers), 'a default block leaves the receipt as it was');
    const row = runRow(plain);
    assert.strictEqual(row.memory_levers, null);
    assert.strictEqual(row.project, null);
    assert.strictEqual(adapterArgs(plain)[adapterArgs(plain).indexOf('--worktree') + 1], `${plain.dir}/wt`, 'with every lever off the adapter still gets the worktree (ADR 0054)');
  } finally { cleanup(plain.dir); }
  const ka = go('hi\n', { memory: { knowledge_agent: true } });
  try {
    assert.strictEqual(ka.status, 0, ka.stderr.slice(-600));
    const a = adapterArgs(ka);
    assert.strictEqual(a[a.indexOf('--worktree') + 1], `${ka.dir}/wt`, 'with the knowledge agent on, the adapter gets the worktree');
  } finally { cleanup(ka.dir); }
});

// The belay adapter's argv in the orchestrator's mcp.json.
function adapterArgs(r) {
  return JSON.parse(fs.readFileSync(`${r.orchDir}/mcp.json`, 'utf8')).mcpServers.belay.args;
}

test('levers: fix_hard_cap defaults to 5 without a run timeout and to none with one; an explicit value (or null) always wins', () => {
  const src = 'default, no run timeout';
  assert.deepStrictEqual([parseLevers({}).fix_hard_cap, parseLevers({}).fix_hard_cap_source], [5, src]);
  assert.deepStrictEqual([parseLevers({ timeout_ms: 0 }).fix_hard_cap, parseLevers({ timeout_ms: 0 }).fix_hard_cap_source], [5, src]);
  assert.deepStrictEqual([parseLevers({ timeout_ms: 600000 }).fix_hard_cap, parseLevers({ timeout_ms: 600000 }).fix_hard_cap_source], [null, null]);
  for (const t of [0, 600000]) {
    assert.deepStrictEqual([parseLevers({ timeout_ms: t, fix_hard_cap: 4 }).fix_hard_cap, parseLevers({ timeout_ms: t, fix_hard_cap: 4 }).fix_hard_cap_source], [4, 'run spec']);
    assert.deepStrictEqual([parseLevers({ timeout_ms: t, fix_hard_cap: null }).fix_hard_cap, parseLevers({ timeout_ms: t, fix_hard_cap: null }).fix_hard_cap_source], [null, 'run spec'], 'null says no cap');
  }
  assert.strictEqual(parseLevers({ fix_hard_cap: 0 }).fix_hard_cap, 0);
  for (const bad of [-1, 1.5, '3']) assert.match(parseLevers({ fix_hard_cap: bad }).error, /fix_hard_cap must be a non-negative integer, or null/);
});

test('levers: the default hard cap decides from the parsed timeout, so a numeric string counts like the number', () => {
  const { parseSpec } = require('../../src/cli/run-spec.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-levers-ts-'));
  try {
    fs.writeFileSync(`${dir}/p.txt`, 'hi\n');
    const levers = (t) => {
      fs.writeFileSync(`${dir}/spec.json`, JSON.stringify({ worktree: dir, prompt_file: `${dir}/p.txt`, timeout_ms: t }));
      const r = parseSpec(`${dir}/spec.json`, dir);
      assert.ok(!r.error, r.error);
      return [r.levers.fix_hard_cap, r.levers.fix_hard_cap_source];
    };
    assert.deepStrictEqual(levers('0'), [5, 'default, no run timeout']);
    assert.deepStrictEqual(levers(0), [5, 'default, no run timeout']);
    assert.deepStrictEqual(levers('21600000'), [null, null]);
    assert.deepStrictEqual(levers(21600000), [null, null]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
