'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// tool-policy.test.cjs — ADR 0054 decision 4: a worker type's tool list is a ceiling and a default. The built-in policy
// gives the researcher Read, Glob, Grep and the two web tools and no Bash; the config's agents.<type>.tools replaces a
// type's list; a spawn's allowed_tools narrows within it and is refused, naming the ceiling, when it reaches past it.
// `belay settings agents.<type>.tools` lists, writes and unsets the field like the other agents keys.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TP = require('../../src/run/tool-policy.cjs');
const S = require('../../src/run/surface.cjs');
const AD = require('../../src/run/agent-defaults.cjs');

const refused = (fn, re) => assert.throws(fn, (e) => e.code === 'E_ARGS' && re.test(e.message), String(re));

test('the six are surface.cjs\'s list, and the built-in policy gives the researcher the web tools without Bash', () => {
  assert.deepStrictEqual(TP.SIX, S.CLAUDE_TOOLS);
  assert.deepStrictEqual(TP.forType(null, 'researcher').tools, ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
  for (const t of ['coder', 'tester', 'reviewer']) assert.deepStrictEqual(TP.forType(null, t).tools, S.CLAUDE_TOOLS, t);
  assert.deepStrictEqual(TP.forType(null, null), { tools: S.CLAUDE_TOOLS, source: 'default (no agent_type)' }, 'no type: the six, as before');
  for (const t of AD.WORKER_TYPES) assert.ok(TP.BUILTIN[t], `${t} has a built-in policy`);
});

test('resolve: the type\'s list by default, narrowed by allowed_tools, web tools pre-approved', () => {
  assert.deepStrictEqual(TP.resolve(null, { agent_type: 'researcher' }), { tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'], source: 'built-in policy for researcher', preapprove: ['WebFetch', 'WebSearch'] });
  assert.deepStrictEqual(TP.resolve(null, { agent_type: 'researcher', allowed_tools: ['WebSearch', 'Read', 'mcp__belay'] }).tools, ['Read', 'WebSearch'], 'canonical order; mcp names never narrow');
  assert.deepStrictEqual(TP.resolve(null, { agent_type: 'coder', allowed_tools: ['Grep', 'Read', 'mcp__belay'] }), { tools: ['Read', 'Grep'], source: 'built-in policy for coder', preapprove: [] });
  assert.deepStrictEqual(TP.resolve(null, {}).tools, S.CLAUDE_TOOLS);
});

test('resolve: past the ceiling, an unknown name, or no tool at all is refused before anything is written', () => {
  refused(() => TP.resolve(null, { agent_type: 'researcher', allowed_tools: ['Read', 'Bash'] }), /Bash, outside the researcher list Read, Glob, Grep, WebFetch, WebSearch \(built-in policy for researcher\)/);
  refused(() => TP.resolve(null, { agent_type: 'coder', allowed_tools: ['Read', 'WebFetch'] }), /WebFetch, outside the coder list/);
  refused(() => TP.resolve(null, { allowed_tools: ['WebSearch'] }), /outside the default list/);
  refused(() => TP.resolve(null, { agent_type: 'coder', allowed_tools: ['Read', 'Task'] }), /Task, which no worker can have/);
  refused(() => TP.resolve(null, { agent_type: 'coder', allowed_tools: ['mcp__belay'] }), /names no tool of the coder list/);
  refused(() => TP.resolve(null, { agent_type: 'coder', allowed_tools: 'Read' }), /array of strings/);
});

test('config: agents.<type>.tools replaces the type\'s list, canonicalised; a bad list or one on the orchestrator is refused', () => {
  const ok = AD.parseAgentsBlock({ researcher: { tools: ['WebSearch', 'Read'] }, coder: { tools: null } });
  assert.deepStrictEqual(ok.value, { researcher: { tools: ['Read', 'WebSearch'] } });
  const defaults = { path: 'C:/p/belay.config.json', types: ok.value };
  assert.deepStrictEqual(TP.forType(defaults, 'researcher'), { tools: ['Read', 'WebSearch'], source: 'C:/p/belay.config.json agents.researcher.tools' });
  refused(() => TP.resolve(defaults, { agent_type: 'researcher', allowed_tools: ['Read', 'WebFetch'] }), /WebFetch, outside the researcher list Read, WebSearch \(C:\/p\/belay\.config\.json agents\.researcher\.tools\)/);
  assert.deepStrictEqual(TP.forType(defaults, 'coder').tools, S.CLAUDE_TOOLS, 'an unset type keeps the built-in policy');
  for (const [block, re] of [
    [{ researcher: { tools: [] } }, /non-empty array/],
    [{ researcher: { tools: ['Read', 'Task'] } }, /"Task"; the known tools are/],
    [{ researcher: { tools: ['Read', 'Read'] } }, /repeats a tool/],
    [{ researcher: { tools: 'Read' } }, /non-empty array/],
    [{ orchestrator: { tools: ['Read'] } }, /agents\.orchestrator\.tools is not a setting/],
  ]) assert.match(AD.parseAgentsBlock(block).error || '', re, JSON.stringify(block));
});

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');
const fwd = (p) => String(p).split(path.sep).join('/');
function cli(cwd, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd, windowsHide: true, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(r.stdout || r.stderr); } catch { /* text */ }
  return { code: r.status, out, stderr: r.stderr };
}

test('settings: agents.researcher.tools is written as a list, read back from the file, refused when bad, and unset by null', () => {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-settings-tools-')));
  fs.mkdirSync(`${dir}/.git`);
  try {
    const before = cli(dir, ['settings', 'agents.researcher.tools']);
    assert.deepStrictEqual([before.out.value, before.out.source], [['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'], 'default']);
    const w = cli(dir, ['settings', 'agents.researcher.tools', 'WebSearch, Read']);
    assert.strictEqual(w.code, 0, w.stderr);
    assert.deepStrictEqual([w.out.new.value, w.out.new.source], [['Read', 'WebSearch'], `${dir}/belay.config.json`]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${dir}/belay.config.json`, 'utf8')), { agents: { researcher: { tools: ['Read', 'WebSearch'] } } });
    const bad = cli(dir, ['settings', 'agents.researcher.tools', 'Read,Task']);
    assert.notStrictEqual(bad.code, 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(`${dir}/belay.config.json`, 'utf8')).agents.researcher.tools, ['Read', 'WebSearch'], 'the file is unchanged');
    assert.notStrictEqual(cli(dir, ['settings', 'agents.orchestrator.tools', 'Read']).code, 0, 'the orchestrator has no tools key');
    const u = cli(dir, ['settings', 'agents.researcher.tools', 'null']);
    assert.strictEqual(u.code, 0, u.stderr);
    assert.deepStrictEqual([u.out.new.value, u.out.new.source], [['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'], 'default']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
