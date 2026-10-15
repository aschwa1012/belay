'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// settings-levers.test.cjs — `belay settings` for the memory levers and the per-agent-type defaults: the keys
// derived from src/core/memory-levers.cjs, a refused write that leaves the file unchanged, the config's memory
// block merged under the run spec's with a source per lever, and the orchestrator's model and effort resolved from
// agents.orchestrator. Sandboxed under the OS temp dir; the fake orchestrator for the end-to-end rows.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const fwd = (p) => String(p).split(path.sep).join('/');
const ML = require('../../src/core/memory-levers.cjs');
const { parseSpec } = require('../../src/cli/run-spec.cjs');

function project() {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-settings-lv-')));
  fs.mkdirSync(`${dir}/.git`);
  return dir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });
function cli(cwd, args, { json = true } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, ...(json ? ['--json'] : [])], { cwd, windowsHide: true, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout || r.stderr); } catch { /* text */ }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
}
const writeConfig = (dir, obj) => fs.writeFileSync(`${dir}/belay.config.json`, JSON.stringify(obj, null, 2));
const readConfig = (dir) => JSON.parse(fs.readFileSync(`${dir}/belay.config.json`, 'utf8'));

test('settings: every memory lever is listed as memory.<key> with its default, derived from the core module', () => {
  const dir = project();
  try {
    const r = cli(dir, ['settings']);
    assert.strictEqual(r.code, 0);
    const mem = r.out.settings.filter((s) => s.key.startsWith('memory.'));
    assert.deepStrictEqual(mem.map((s) => s.key), Object.keys(ML.DEFAULTS).map((k) => `memory.${k}`));
    for (const s of mem) {
      assert.strictEqual(s.value, ML.DEFAULTS[s.key.slice(7)], s.key);
      assert.deepStrictEqual(s.default, ML.DEFAULTS[s.key.slice(7)], s.key);
      assert.strictEqual(s.source, 'default');
      assert.ok(s.type, `${s.key} names its type`);
    }
    const agents = r.out.settings.filter((s) => s.key.startsWith('agents.'));
    assert.deepStrictEqual(agents.map((s) => s.key).slice(0, 4), ['agents.coder.model', 'agents.coder.effort', 'agents.tester.model', 'agents.tester.effort']);
    assert.strictEqual(agents.length, 10);
    assert.ok(agents.every((s) => s.source === 'default'));
    const by = Object.fromEntries(agents.map((s) => [s.key, s.value]));
    assert.deepStrictEqual([by['agents.coder.model'], by['agents.coder.effort'], by['agents.reviewer.model'], by['agents.reviewer.effort'], by['agents.orchestrator.model']],
      ['claude-sonnet-5-5', null, 'claude-opus-5-5', 'high', 'claude-opus-5-5'], 'the roster is the built-in default');
    assert.strictEqual(by['agents.orchestrator.effort'], null, 'the orchestrator has no built-in effort');
    const text = cli(dir, ['settings'], { json: false });
    assert.match(text.stdout, /memory\.index_bytes\s+1200\s+\(from default\)\s+\[integer 1\.\.4096\]/);
    assert.match(text.stdout, /agents\.reviewer\.effort\s+"high"\s+\(from default\)\s+\[low \| medium \| high \| xhigh \| max \| null\]/);
  } finally { cleanup(dir); }
});

test('settings: a memory write returns old and new, writes only the memory block, and a read shows the file as the source', () => {
  const dir = project();
  try {
    writeConfig(dir, { data_dir: '.belay', mod: { pane: 'docked' } });
    const w = cli(dir, ['settings', 'memory.project', 'acme']);
    assert.strictEqual(w.code, 0, w.stderr);
    assert.deepStrictEqual([w.out.key, w.out.old.value, w.out.new.value, w.out.new.source], ['memory.project', null, 'acme', `${dir}/belay.config.json`]);
    const n = cli(dir, ['settings', 'memory.notes', 'true']);
    assert.strictEqual(n.code, 0, `notes after project: ${n.stderr}${n.stdout}`);
    const i = cli(dir, ['settings', 'memory.index_bytes', '2048']);
    assert.strictEqual(i.out.new.value, 2048);
    const a = cli(dir, ['settings', 'memory.alpha', '0.5']);
    assert.strictEqual(a.out.new.value, 0.5);
    assert.deepStrictEqual(readConfig(dir), { data_dir: '.belay', mod: { pane: 'docked' }, memory: { project: 'acme', notes: true, index_bytes: 2048, alpha: 0.5 } });
    const one = cli(dir, ['settings', 'memory.notes']);
    assert.deepStrictEqual([one.out.value, one.out.source], [true, `${dir}/belay.config.json`]);
    const nul = cli(dir, ['settings', 'memory.notes', 'false']);
    assert.strictEqual(nul.code, 0);
    assert.strictEqual(cli(dir, ['settings', 'memory.project', 'null']).code, 0);
    assert.strictEqual(readConfig(dir).memory.project, null);
  } finally { cleanup(dir); }
});

test('settings: a refused memory write exits 2, quotes the message and leaves the file byte-identical', () => {
  const dir = project();
  try {
    writeConfig(dir, { memory: { capture: true } });
    const before = fs.readFileSync(`${dir}/belay.config.json`, 'utf8');
    const refusals = [
      [['memory.notes', 'true'], /memory\.notes needs memory\.project/],
      [['memory.observations', 'maybe'], /not true or false/],
      [['memory.index_bytes', '99999'], /memory\.index_bytes must be an integer from 1 to 4096/],
      [['memory.index_bytes', '1.5'], /not an integer/],
      [['memory.alpha', '2'], /memory\.alpha must be a number from 0 to 1/],
      [['memory.summaries', 'mechanical'], /memory\.summaries "mechanical" needs memory\.observations/],
      [['memory.summaries', 'verbose'], /not a value of memory\.summaries/],
      [['memory.project', 'Bad Name'], /memory\.project must be null or match/],
      [['memory.nope', 'true'], /unknown key memory\.nope/],
    ];
    for (const [args, re] of refusals) {
      const r = cli(dir, ['settings', ...args]);
      assert.strictEqual(r.code, 2, args.join(' '));
      assert.match(r.out.error, re, args.join(' '));
      assert.strictEqual(fs.readFileSync(`${dir}/belay.config.json`, 'utf8'), before, `${args.join(' ')} left the file alone`);
    }
    // No config at all: a refused write creates none.
    const empty = project();
    try {
      assert.strictEqual(cli(empty, ['settings', 'memory.notes', 'true']).code, 2);
      assert.strictEqual(fs.existsSync(`${empty}/belay.config.json`), false);
    } finally { cleanup(empty); }
  } finally { cleanup(dir); }
});

test('settings: agents.<type>.model and .effort are written, refused when wrong, and unset by null', () => {
  const dir = project();
  try {
    const m = cli(dir, ['settings', 'agents.coder.model', 'claude-sonnet-5-5']);
    assert.strictEqual(m.code, 0, m.stderr);
    assert.deepStrictEqual([m.out.old.value, m.out.new.value], ['claude-sonnet-5-5', 'claude-sonnet-5-5']);
    assert.strictEqual(cli(dir, ['settings', 'agents.reviewer.effort', 'high']).code, 0);
    const bad = cli(dir, ['settings', 'agents.reviewer.effort', 'ultra']);
    assert.strictEqual(bad.code, 2);
    assert.match(bad.out.error, /allowed values are low, medium, high, xhigh, max/);
    assert.strictEqual(cli(dir, ['settings', 'agents.janitor.model', 'x']).code, 2);
    assert.deepStrictEqual(readConfig(dir), { agents: { coder: { model: 'claude-sonnet-5-5' }, reviewer: { effort: 'high' } } });
    const unset = cli(dir, ['settings', 'agents.coder.model', 'null']);
    assert.strictEqual(unset.code, 0, unset.stderr);
    assert.deepStrictEqual([unset.out.new.value, unset.out.new.source], ['claude-sonnet-5-5', 'default'], 'unset falls back to the built-in roster');
    assert.strictEqual(cli(dir, ['settings', 'agents.reviewer.effort']).out.value, 'high');
  } finally { cleanup(dir); }
});

// ---- the run side: merge, sources, orchestrator defaults

function runSandbox(config, specExtra = {}) {
  const dir = project();
  fs.mkdirSync(`${dir}/wt`);
  fs.writeFileSync(`${dir}/prompt.txt`, 'do the thing');
  if (config) writeConfig(dir, config);
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify({ worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, run_id: 'lv-run', orchestrator_dir: `${dir}/orch`, ...specExtra }));
  return { dir, specPath };
}

test('run spec: the config memory block is the default and the spec overrides it key by key, each lever naming its source', () => {
  const sb = runSandbox({ memory: { project: 'acme', capture: true, alpha: 0.5, index_bytes: 900 } }, { memory: { alpha: 0.7, rules: true } });
  try {
    const cfg = `${sb.dir}/belay.config.json`;
    const p = parseSpec(sb.specPath, sb.dir);
    assert.ifError(p.error);
    const m = p.levers.memory_levers;
    assert.deepStrictEqual([m.project, m.capture, m.alpha, m.rules, m.index_bytes, m.notes], ['acme', true, 0.7, true, 900, false]);
    const s = p.levers.memory_sources;
    assert.deepStrictEqual(Object.keys(s), Object.keys(ML.DEFAULTS));
    assert.deepStrictEqual([s.alpha, s.rules, s.project, s.capture, s.index_bytes, s.notes], ['spec', 'spec', cfg, cfg, cfg, 'default']);
  } finally { cleanup(sb.dir); }
});

test('run spec: with no config memory block nothing changes; a block that fails validation is refused naming the file', () => {
  const none = runSandbox(null, {});
  const noMem = runSandbox({ mod: { pane: 'docked' } }, {});
  const bad = runSandbox({ memory: { notes: true } }, {});
  const rescued = runSandbox({ memory: { notes: true } }, { memory: { project: 'acme' } });
  try {
    for (const sb of [none, noMem]) {
      const p = parseSpec(sb.specPath, sb.dir);
      assert.strictEqual(p.levers.memory_levers, undefined);
      assert.strictEqual(p.levers.memory_sources, undefined);
    }
    const b = parseSpec(bad.specPath, bad.dir);
    assert.match(b.error, /memory\.notes needs memory\.project/);
    assert.ok(b.error.includes(`${bad.dir}/belay.config.json`), b.error);
    // The prerequisite may come from the spec: the merged block is validated once.
    const r = parseSpec(rescued.specPath, rescued.dir);
    assert.ifError(r.error);
    assert.strictEqual(r.levers.memory_levers.notes, true);
    assert.strictEqual(r.levers.memory_sources.project, 'spec');
  } finally { for (const sb of [none, noMem, bad, rescued]) cleanup(sb.dir); }
});

test('run spec: the orchestrator model and effort default from agents.orchestrator; the spec model and --effort win', () => {
  const sb = runSandbox({ agents: { orchestrator: { model: 'cfg-model', effort: 'low' } } }, {});
  const spec = runSandbox({ agents: { orchestrator: { model: 'cfg-model', effort: 'low' } } }, { model: 'spec-model' });
  const plain = runSandbox(null, {});
  try {
    const cfg = `${sb.dir}/belay.config.json`;
    const d = parseSpec(sb.specPath, sb.dir);
    assert.deepStrictEqual([d.model, d.effort], ['cfg-model', 'low']);
    assert.deepStrictEqual(d.agentSettings.orchestrator.model, { value: 'cfg-model', source: `${cfg} agents.orchestrator.model` });
    assert.deepStrictEqual(d.agentSettings.orchestrator.effort, { value: 'low', source: `${cfg} agents.orchestrator.effort` });
    const w = parseSpec(spec.specPath, spec.dir, { effort: 'max' });
    assert.deepStrictEqual([w.model, w.effort], ['spec-model', 'max']);
    assert.deepStrictEqual(w.agentSettings.orchestrator.model, { value: 'spec-model', source: 'run spec model' });
    assert.deepStrictEqual(w.agentSettings.orchestrator.effort, { value: 'max', source: '--effort' });
    const n = parseSpec(plain.specPath, plain.dir);
    assert.strictEqual(n.model, require('../../src/run/launch.cjs').DEFAULT_ORCHESTRATOR_MODEL);
    assert.strictEqual(n.effort, null);
    assert.deepStrictEqual(n.agentSettings.orchestrator.model.source, 'default');
  } finally { for (const x of [sb, spec, plain]) cleanup(x.dir); }
});

test('run spec: an agents block the run cannot use is refused before anything starts', () => {
  const sb = runSandbox({ agents: { coder: { effort: 'ultra' } } }, {});
  const typo = runSandbox({ agents: { coders: { model: 'x' } } }, {});
  try {
    assert.match(parseSpec(sb.specPath, sb.dir).error, /agents\.coder\.effort must be one of low, medium, high, xhigh, max/);
    assert.match(parseSpec(typo.specPath, typo.dir).error, /agents\.coders is not an agent type/);
  } finally { cleanup(sb.dir); cleanup(typo.dir); }
});

test('belay run end to end: the receipt carries memory_sources and agent_settings, and the orchestrator is launched with the configured model and effort', () => {
  const sb = runSandbox({
    memory: { rules: true, alpha: 0.5 },
    agents: { orchestrator: { model: 'cfg-orch', effort: 'low' }, coder: { model: 'cfg-coder', effort: 'medium' } },
  }, { memory: { alpha: 0.7 }, startup_timeout_ms: 20000, poll_ms: 300, on_embedder_failure: 'continue' });
  try {
    const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-lv' };
    const r = spawnSync(process.execPath, [CLI, 'run', sb.specPath, '--data', `${sb.dir}/.belay`, '--json'], { cwd: sb.dir, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
    const receipt = JSON.parse(r.stdout);
    const cfg = `${sb.dir}/belay.config.json`;
    assert.deepStrictEqual([receipt.levers.memory_levers.alpha, receipt.levers.memory_levers.rules], [0.7, true]);
    assert.deepStrictEqual([receipt.levers.memory_sources.alpha, receipt.levers.memory_sources.rules, receipt.levers.memory_sources.capture], ['spec', cfg, 'default']);
    assert.strictEqual(receipt.orch_effort_requested, 'low');
    assert.strictEqual(receipt.agent_settings.orchestrator.model.source, `${cfg} agents.orchestrator.model`);
    const args = JSON.parse(fs.readFileSync(`${sb.dir}/orch/argv.json`, 'utf8')).spec.args;
    assert.strictEqual(args[args.indexOf('--model') + 1], 'cfg-orch');
    assert.strictEqual(args[args.indexOf('--effort') + 1], 'low');
    // The adapter learns the worker-type defaults from a file beside its mcp.json; the file is the config's resolved agents block, orchestrator entry included (the adapter ignores it).
    const mcp = JSON.parse(fs.readFileSync(`${sb.dir}/orch/mcp.json`, 'utf8'));
    const adapterArgs = Object.values(mcp.mcpServers)[0].args;
    const file = adapterArgs[adapterArgs.indexOf('--agent-defaults') + 1];
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { path: cfg, types: { orchestrator: { model: 'cfg-orch', effort: 'low' }, coder: { model: 'cfg-coder', effort: 'medium' } } });
  } finally { cleanup(sb.dir); }
});

test('writeSetting: the exported writer takes a typed value, validates the whole block and writes atomically', () => {
  const { writeSetting } = require('../../src/cli/cmd-settings.cjs');
  const C = require('../../src/cli/config.cjs');
  const dir = project();
  try {
    const refused = writeSetting(C.discover(dir), 'memory.notes', true, { cwd: dir });
    assert.strictEqual(refused.code, 2);
    assert.strictEqual(fs.existsSync(`${dir}/belay.config.json`), false);
    assert.strictEqual(writeSetting(C.discover(dir), 'memory.project', 'acme', { cwd: dir }).code, 0);
    const ok = writeSetting(C.discover(dir), 'memory.notes', true, { cwd: dir });
    assert.strictEqual(ok.code, 0);
    assert.deepStrictEqual([ok.json.old.value, ok.json.new.value], [false, true]);
    assert.strictEqual(writeSetting(C.discover(dir), 'memory.index_bytes', '7', { cwd: dir }).json.new.value, 7);
    assert.strictEqual(writeSetting(C.discover(dir), 'memory.index_bytes', 'x', { cwd: dir }).code, 2);
    assert.strictEqual(writeSetting(C.discover(dir), 'memory.alpha', 'x'.length, { cwd: dir }).code, 0);
    assert.strictEqual(writeSetting(C.discover(dir), 'memory.alpha', 5, { cwd: dir }).code, 2);
    assert.deepStrictEqual(readConfig(dir).memory, { project: 'acme', notes: true, index_bytes: 7, alpha: 1 });
  } finally { cleanup(dir); }
});

test('settings: an empty spec model is the built-in orchestrator model, never --model ""', () => {
  const sb = runSandbox({ agents: { orchestrator: { model: 'cfg-orch' } } }, { model: '' });
  try {
    const p = parseSpec(sb.specPath, sb.dir);
    assert.strictEqual(p.model, 'cfg-orch');
    assert.match(p.agentSettings.orchestrator.model.source, /agents\.orchestrator\.model$/);
  } finally { cleanup(sb.dir); }
  const bare = runSandbox(null, { model: '' });
  try {
    assert.strictEqual(parseSpec(bare.specPath, bare.dir).model, require('../../src/run/launch.cjs').DEFAULT_ORCHESTRATOR_MODEL);
  } finally { cleanup(bare.dir); }
});

test('settings: a single memory key warns, as the listing does, when the stored block as a whole would be refused', () => {
  const dir = project();
  try {
    writeConfig(dir, { memory: { notes: true } });
    const one = cli(dir, ['settings', 'memory.notes']);
    assert.match(one.out.memory_error, /memory\.notes needs memory\.project/);
    const text = cli(dir, ['settings', 'memory.alpha'], { json: false });
    assert.match(text.stdout, /warning: the memory block would be refused by a run: memory\.notes needs memory\.project/);
    assert.strictEqual(cli(dir, ['settings', 'agents.coder.model']).out.memory_error, undefined);
  } finally { cleanup(dir); }
});
