'use strict';
// agents.<type>.codex_model (audit L24): the model a type's Codex workers use, a field apart from the Claude roster's `model`. The
// config validates it separately, a Codex spawn takes it (named in the spawn result and passed as -m), a Claude Code spawn never does,
// and a Codex model under `model` is refused rather than handed to Claude Code coders.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const AD = require('../../src/run/agent-defaults.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const FAKE_CODEX = path.join(__dirname, 'fakes', 'fake-codex.cjs').split(path.sep).join('/');
const CFG = 'C:/proj/belay.config.json';
const DEFAULTS = { path: CFG, types: { coder: { model: 'cfg-coder', codex_model: 'cfg-codex' }, reviewer: { effort: 'high' } } };

test('the block accepts codex_model on a worker type, apart from model, and refuses it on the orchestrator', () => {
  const ok = AD.parseAgentsBlock({ coder: { model: 'claude-sonnet-5-5', codex_model: 'gpt-6-sol' }, tester: { codex_model: null } });
  assert.deepStrictEqual(ok.value, { coder: { model: 'claude-sonnet-5-5', codex_model: 'gpt-6-sol' } }, 'a null is unset');
  assert.match(AD.parseAgentsBlock({ orchestrator: { codex_model: 'gpt-6-sol' } }).error, /agents\.orchestrator\.codex_model is not a setting \(known: model, effort\)/);
  assert.match(AD.parseAgentsBlock({ coder: { codex_model: '' } }).error, /agents\.coder\.codex_model must be a non-empty string or null/);
  assert.match(AD.parseAgentsBlock({ coder: { codex_model: 3 } }).error, /agents\.coder\.codex_model must be a non-empty string/);
});

test('a Codex model under model is refused: Claude Code coders would be launched with it', () => {
  for (const m of ['gpt-6-sol', 'GPT-6.1-Astra', 'codex-mini', 'o3']) {
    assert.match(AD.parseAgentsBlock({ coder: { model: m } }).error, new RegExp(`agents\\.coder\\.model .* is not a Claude model.*agents\\.coder\\.codex_model`), m);
  }
  for (const m of ['claude-opus-5-5', 'sonnet', 'opus', 'cfg-coder']) assert.ifError(AD.parseAgentsBlock({ coder: { model: m } }).error);
  assert.ifError(AD.parseAgentsBlock({ coder: { codex_model: 'gpt-6-sol' } }).error, 'the Codex field itself takes a GPT model');
});

test('forWorker: a Codex spawn takes the type\'s codex_model with its source; an explicit model wins; Claude Code never takes it', () => {
  const cx = AD.forWorker(DEFAULTS, { agent_type: 'coder', substrate: 'codex' });
  assert.deepStrictEqual(cx.model, { value: 'cfg-codex', source: `${CFG} agents.coder.codex_model` });
  assert.deepStrictEqual(cx.effort, { value: null, source: 'default' }, 'Codex still takes no effort');
  assert.deepStrictEqual(AD.forWorker(DEFAULTS, { agent_type: 'coder', model: 'gpt-x', substrate: 'codex' }).model, { value: 'gpt-x', source: 'spawn argument' });
  assert.strictEqual(AD.forWorker(DEFAULTS, { agent_type: 'coder', model: '', substrate: 'codex' }).model.value, 'cfg-codex', 'an empty model is not given');
  assert.deepStrictEqual(AD.forWorker(DEFAULTS, { agent_type: 'reviewer', substrate: 'codex' }).model, { value: null, source: 'default' }, 'no built-in Codex model');
  assert.strictEqual(AD.forWorker(DEFAULTS, { agent_type: 'coder', substrate: 'claude-code' }).model.value, 'cfg-coder');
  assert.strictEqual(AD.forWorker({ path: CFG, types: { coder: { codex_model: 'cfg-codex' } } }, { agent_type: 'coder', substrate: 'claude-code' }).model.value, 'claude-sonnet-5-5', 'the built-in Claude roster, not the Codex model');
});

test('a Codex worker is launched with the configured codex_model as -m, and the Claude Code one with its own model', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-agentdef-cx-'));
  const data = d.split(path.sep).join('/');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const m = createRunManager({ core: createFakeCore(), dataDir: data, runId: 'run-agentdef-cx', agentDefaults: DEFAULTS, paths: { claudeExe: FAKE, codexExe: FAKE_CODEX, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    const row = await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'wx', agent_type: 'coder' });
    assert.deepStrictEqual(row.agent.model, { value: 'cfg-codex', source: `${CFG} agents.coder.codex_model` });
    const args = JSON.parse(fs.readFileSync(`${data}/workers/wx/argv.json`, 'utf8')).spec.args;
    assert.strictEqual(args[args.indexOf('-m') + 1], 'cfg-codex');
    const cc = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'one', worker_id: 'wc', agent_type: 'coder' });
    assert.strictEqual(cc.agent.model.value, 'cfg-coder');
    const cargs = JSON.parse(fs.readFileSync(`${data}/workers/wc/argv.json`, 'utf8')).spec.args;
    assert.ok(!cargs.includes('cfg-codex'));
  } finally { await m.shutdown().catch(() => {}); cleanup(data); }
});
