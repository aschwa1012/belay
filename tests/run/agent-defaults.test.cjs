'use strict';
// agent-defaults.test.cjs — worker_spawn's agent_type: the config's per-agent-type model and effort fill what the
// caller left out, an explicit model or effort always wins, and the spawn result names where each value came from.
// A real RunManager over tests/run/fakes/fake-claude.cjs and tests/run/fake-core.cjs (the shape of effort.test.cjs).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const AD = require('../../src/run/agent-defaults.cjs');
const tools = require('../../src/mcp/tools.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const CFG = 'C:/proj/belay.config.json';
const DEFAULTS = { path: CFG, types: { coder: { model: 'cfg-coder', effort: 'low' }, reviewer: { effort: 'high' } } };

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-agentdef-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
const mgr = (sb, core, agentDefaults) => createRunManager({
  core, dataDir: sb.data, runId: 'run-agentdef-test', agentDefaults,
  paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
});
const argsOf = (sb, id) => JSON.parse(fs.readFileSync(`${sb.data}/workers/${id}/argv.json`, 'utf8')).spec.args;
const flag = (args, f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);

test('agent_type: the configured model and effort are used, each with its source', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore(), DEFAULTS);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wc', agent_type: 'coder' });
    assert.deepStrictEqual(row.agent, {
      agent_type: 'coder',
      model: { value: 'cfg-coder', source: `${CFG} agents.coder.model` },
      effort: { value: 'low', source: `${CFG} agents.coder.effort` },
    });
    assert.strictEqual(row.effort_requested, 'low');
    const a = argsOf(sb, 'wc');
    assert.deepStrictEqual([flag(a, '--model'), flag(a, '--effort')], ['cfg-coder', 'low']);
    // A type with only one default: the other is the built-in default.
    const rv = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wr', agent_type: 'reviewer' });
    assert.deepStrictEqual(rv.agent.model, { value: null, source: 'default' });
    assert.deepStrictEqual(rv.agent.effort, { value: 'high', source: `${CFG} agents.reviewer.effort` });
  } finally { await m.shutdown().catch(() => {}); cleanup(sb.data); }
});

test('agent_type: an explicit model or effort on the spawn always wins, and is named as the spawn argument', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore(), DEFAULTS);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wx', agent_type: 'coder', model: 'explicit-model', effort: 'max' });
    assert.deepStrictEqual(row.agent.model, { value: 'explicit-model', source: 'spawn argument' });
    assert.deepStrictEqual(row.agent.effort, { value: 'max', source: 'spawn argument' });
    const a = argsOf(sb, 'wx');
    assert.deepStrictEqual([flag(a, '--model'), flag(a, '--effort')], ['explicit-model', 'max']);
    // Only the model explicit: the effort still comes from the config.
    const half = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wh', agent_type: 'coder', model: 'only-model' });
    assert.deepStrictEqual([half.agent.model.source, half.agent.effort.source], ['spawn argument', `${CFG} agents.coder.effort`]);
  } finally { await m.shutdown().catch(() => {}); cleanup(sb.data); }
});

test('agent_type: absent, the spawn is what it was (no agent field, nothing taken from the config); an unknown type is E_ARGS', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, DEFAULTS);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wp' });
    assert.strictEqual(row.agent, undefined);
    const a = argsOf(sb, 'wp');
    assert.deepStrictEqual([flag(a, '--effort'), a.includes('cfg-coder')], [null, false]);
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wbad', agent_type: 'janitor' }), (e) => e.code === 'E_ARGS' && /coder, tester, reviewer, researcher/.test(e.message));
    await assert.rejects(core.worker.get({ worker_id: 'wbad' }), 'a refused spawn wrote no row');
  } finally { await m.shutdown().catch(() => {}); cleanup(sb.data); }
});

test('agent_type: with no configured defaults the type changes nothing; codex is given no configured effort or model', () => {
  const none = AD.forWorker(null, { agent_type: 'coder', model: undefined, effort: undefined, substrate: 'claude-code' });
  assert.deepStrictEqual([none.model, none.effort], [{ value: null, source: 'default' }, { value: null, source: 'default' }]);
  const codex = AD.forWorker(DEFAULTS, { agent_type: 'coder', substrate: 'codex' });
  assert.deepStrictEqual(codex.effort, { value: null, source: 'default' }, 'ADR 0028: codex takes no effort, so none is applied');
  assert.strictEqual(codex.model.value, null, 'nor the configured model');
});

test('worker_spawn lists agent_type as an enum of the four worker types, and the listing stays inside its budgets', () => {
  const spawn = tools.toolsFor('orchestrator').find((t) => t.name === 'worker_spawn');
  assert.deepStrictEqual(spawn.inputSchema.properties.agent_type.enum, ['coder', 'tester', 'reviewer', 'researcher']);
  assert.throws(() => tools.validateArgs('worker_spawn', { substrate: 'codex', worktree: 'w', prompt: 'p', agent_type: 'orchestrator' }), (e) => e.code === 'E_ARGS');
  for (const role of ['orchestrator', 'worker']) {
    const bytes = tools.listingBytes(role);
    console.log(`agent_type ${role}: ${bytes} bytes, budget ${tools.BUDGET[role]}`);
    assert.ok(bytes <= tools.BUDGET[role], `${role} listing ${bytes} over ${tools.BUDGET[role]}`);
  }
});

test('agent_type: a Codex spawn gets neither the configured model nor the configured effort; an empty model counts as none', () => {
  const codex = AD.forWorker(DEFAULTS, { agent_type: 'coder', substrate: 'codex' });
  assert.deepStrictEqual(codex.model, { value: null, source: 'default' }, 'a configured Claude model is not given to Codex');
  assert.deepStrictEqual(codex.effort, { value: null, source: 'default' });
  assert.strictEqual(AD.forWorker(DEFAULTS, { agent_type: 'coder', model: 'gpt-x', substrate: 'codex' }).model.value, 'gpt-x', 'an explicit one is still passed');
  const empty = AD.forWorker(DEFAULTS, { agent_type: 'coder', model: '', effort: '', substrate: 'claude-code' });
  assert.deepStrictEqual([empty.model, empty.effort], [
    { value: 'cfg-coder', source: `${CFG} agents.coder.model` }, { value: 'low', source: `${CFG} agents.coder.effort` }]);
  const bare = AD.forWorker(null, { agent_type: 'coder', model: '', substrate: 'claude-code' });
  assert.deepStrictEqual(bare.model, { value: null, source: 'default' }, 'never "" from spawn argument');
  const orch = AD.forOrchestrator({ path: CFG, types: {} }, { model: '', effort: '', builtinModel: 'builtin' });
  assert.deepStrictEqual(orch.model, { value: 'builtin', source: 'default' });
  assert.deepStrictEqual(orch.effort, { value: null, source: 'default' });
});

test('--agent-defaults: the adapter argv is parsed into agentDefaults and the run manager built from it resolves agent_type', async () => {
  const { parseArgv } = require('../../src/mcp/argv.cjs');
  const sb = sandbox();
  const file = `${sb.data}/agent-defaults-in.json`;
  fs.writeFileSync(file, JSON.stringify(DEFAULTS));
  const opts = parseArgv(['--role', 'orchestrator', '--run', 'run-agentdef-argv', '--data', `${sb.data}/store`, '--agent-defaults', file]);
  assert.deepStrictEqual(opts.agentDefaults, DEFAULTS);
  const m = mgr(sb, createFakeCore(), opts.agentDefaults);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wa', agent_type: 'coder' });
    assert.strictEqual(row.agent.model.value, 'cfg-coder');
    assert.strictEqual(flag(argsOf(sb, 'wa'), '--model'), 'cfg-coder');
  } finally { await m.shutdown().catch(() => {}); cleanup(sb.data); }
});
