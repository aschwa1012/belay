'use strict';
require('../helpers/tmp.cjs');
// codex-surface.test.cjs — what belay sets on a Codex launch and what it leaves to the user's own Codex config. Every launch and resume
// passes --ignore-rules, the required belay server and the 12 pinned --disable switches; --ignore-user-config is never passed (it was
// probed on codex-cli 0.164.0 and drops the user's provider and profile). A Codex effort comes only from the spawn or
// agents.<type>.codex_effort, never from the Claude effort field. Uses the fake Codex; no real Codex.

require('../helpers/tmp.cjs');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../../src/run/launch.cjs');
const CS = require('../../src/run/codex-surface.cjs');
const AD = require('../../src/run/agent-defaults.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const FAKE_CODEX = path.join(__dirname, 'fakes', 'fake-codex.cjs').split(path.sep).join('/');
const ADAPTER = ['adapter.cjs', '--worker-id', 'w1'];
const CFG = '/cfg/belay.json';

const head = (argv) => argv.slice(0, argv.indexOf('--'));
const valueOf = (argv, flag, prefix) => argv.filter((a, i) => argv[i - 1] === flag && a.startsWith(prefix)).map((a) => a.slice(prefix.length));

test('launch and resume both pass belay\'s switches and nothing that replaces the user\'s Codex config', () => {
  const launch = L.codexLaunchArgv({ worktree: 'C:/wt', adapterArgs: ADAPTER, prompt: 'p' });
  const resume = L.codexResumeArgv({ threadId: 't1', adapterArgs: ADAPTER, prompt: 'p' });
  for (const [name, argv] of [['launch', launch], ['resume', resume]]) {
    const h = head(argv);
    assert.ok(h.includes('--ignore-rules'), `${name}: --ignore-rules`);
    assert.ok(h.includes('mcp_servers.belay.required=true'), `${name}: the belay server is required`);
    assert.deepStrictEqual(valueOf(h, '--disable', ''), [...CS.DISABLED_FEATURES], `${name}: the pinned switches`);
    assert.ok(!h.includes('--ignore-user-config'), `${name}: the user's model, provider, profile and sandbox stay`);
    assert.ok(!h.some((a) => a.startsWith('windows.sandbox=') || a.startsWith('model_reasoning_effort=')), `${name}: no sandbox and no effort unless given`);
    assert.strictEqual(argv[argv.length - 1], 'p');
  }
});

test('a given effort is passed on launch and resume; max is Claude Code\'s and is refused', () => {
  const l = L.codexLaunchArgv({ worktree: 'C:/wt', adapterArgs: ADAPTER, prompt: 'p', effort: 'low' });
  const r = L.codexResumeArgv({ threadId: 't1', adapterArgs: ADAPTER, prompt: 'p', effort: 'xhigh' });
  assert.deepStrictEqual(valueOf(l, '-c', 'model_reasoning_effort='), ['"low"']);
  assert.deepStrictEqual(valueOf(r, '-c', 'model_reasoning_effort='), ['"xhigh"']);
  assert.throws(() => L.codexLaunchArgv({ worktree: 'C:/wt', adapterArgs: ADAPTER, prompt: 'p', effort: 'max' }), (e) => e.code === 'E_ARGS' && /low, medium, high, xhigh/.test(e.message));
});

test('the 12 switches are the ones the probe on 0.164.0 named (a Codex upgrade updates them with a re-probe)', () => {
  assert.strictEqual(CS.PROBED_VERSION, '0.164.0');
  assert.deepStrictEqual([...CS.DISABLED_FEATURES], [
    'apps', 'browser_use', 'browser_use_full_cdp_access', 'computer_use', 'goals', 'guardian_approval',
    'hooks', 'image_generation', 'multi_agent', 'plugins', 'remote_plugin', 'skill_search',
  ]);
});

test('codex_effort is its own field: parsed from the Codex enum, and a Claude effort never reaches a Codex spawn', () => {
  assert.deepStrictEqual(AD.parseAgentsBlock({ reviewer: { codex_effort: 'xhigh' } }).value, { reviewer: { codex_effort: 'xhigh' } });
  assert.match(AD.parseAgentsBlock({ reviewer: { codex_effort: 'max' } }).error, /agents\.reviewer\.codex_effort must be one of low, medium, high, xhigh or null/);
  assert.match(AD.parseAgentsBlock({ orchestrator: { codex_effort: 'low' } }).error, /not a setting/);
  const d = { path: CFG, types: { reviewer: { effort: 'max', codex_effort: 'low' }, coder: { effort: 'medium' } } };
  assert.deepStrictEqual(AD.forWorker(d, { agent_type: 'reviewer', substrate: 'codex' }).effort, { value: 'low', source: `${CFG} agents.reviewer.codex_effort` });
  assert.deepStrictEqual(AD.forWorker(d, { agent_type: 'coder', substrate: 'codex' }).effort, { value: null, source: 'default' }, 'a Claude coder effort is not Codex\'s');
  assert.deepStrictEqual(AD.forWorker(d, { agent_type: 'researcher', substrate: 'codex' }).effort, { value: null, source: 'default' }, 'nor is the Claude built-in');
  assert.strictEqual(AD.forWorker(d, { agent_type: 'reviewer', effort: 'high', substrate: 'codex' }).effort.source, 'spawn argument');
  assert.strictEqual(AD.forWorker(d, { agent_type: 'reviewer', substrate: 'claude-code' }).effort.value, 'max', 'Claude Code is unchanged');
});

function rig(agentDefaults) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-codex-surface-'));
  const data = d.split(path.sep).join('/');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(`${data}/chome`); // hermetic: a Codex spawn test never reads the machine's own ~/.codex
  const before = { CODEX_HOME: process.env.CODEX_HOME };
  process.env.CODEX_HOME = `${data}/chome`;
  process.env.FAKE_CODEX_GATE_FILE = `${data}/codex-turn.gate`;
  const m = createRunManager({ core: createFakeCore(), dataDir: data, runId: 'run-codex-surface', agentDefaults, paths: { claudeExe: FAKE, codexExe: FAKE_CODEX, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  const done = async () => {
    delete process.env.FAKE_CODEX_GATE_FILE; delete process.env.FAKE_CODEX_UNKNOWN_FEATURE;
    if (before.CODEX_HOME === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before.CODEX_HOME;
    await m.shutdown().catch(() => {}); cleanup(data);
  };
  return { m, data, worktree, done };
}
const argsOf = (data, id) => JSON.parse(fs.readFileSync(`${data}/workers/${id}/argv.json`, 'utf8')).spec.args;

test('a Codex spawn passes no effort unless given, records what belay set and what it left to the user, and a Claude effort config is harmless', async () => {
  const { m, data, worktree, done } = rig({ path: CFG, types: { reviewer: { effort: 'max' }, coder: { codex_effort: 'low' } } });
  try {
    const none = await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'wn' });
    assert.strictEqual(none.codex_surface.set_by_belay.effort, null);
    assert.ok(!argsOf(data, 'wn').some((a) => /^model_reasoning_effort=/.test(a)));
    assert.ok(none.codex_surface.left_to_user_config.some((x) => /provider and profile/.test(x)));
    assert.ok(!none.codex_surface.left_to_user_config.some((x) => /trusted/.test(x)), 'the trust write is Codex\'s, not a setting');
    assert.ok(none.codex_surface.not_isolated.some((x) => /trusted/.test(x)) && none.codex_surface.not_isolated.some((x) => /AGENTS\.md/.test(x)));
    assert.strictEqual(none.effort_requested, null);
    const rev = await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'wr', agent_type: 'reviewer' }); // the config's Claude effort 'max'
    assert.strictEqual(rev.codex_surface.set_by_belay.effort, null);
    const cod = await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'wc', agent_type: 'coder' });
    assert.deepStrictEqual(cod.codex_surface.set_by_belay.effort, { value: 'low', source: `${CFG} agents.coder.codex_effort` });
    assert.deepStrictEqual(valueOf(argsOf(data, 'wc'), '-c', 'model_reasoning_effort='), ['"low"']);
    assert.strictEqual(cod.effort_requested, 'low');
    const given = await m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'wg', effort: 'xhigh' });
    assert.deepStrictEqual(given.codex_surface.set_by_belay.effort, { value: 'xhigh', source: 'spawn argument' });
    const cc = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'one', worker_id: 'wcc' });
    assert.strictEqual(cc.codex_surface, undefined);
    await assert.rejects(m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'wm', effort: 'max' }), (e) => e.code === 'E_ARGS' && /codex effort must be one of/.test(e.message));
  } finally { await done(); }
});

test('Codex exiting at once on a feature name it does not know is reported with the feature, the version and the stderr line', async () => {
  const { m, worktree, done } = rig(undefined);
  process.env.FAKE_CODEX_UNKNOWN_FEATURE = 'goals';
  try {
    await assert.rejects(m.spawn({ substrate: 'codex', worktree, prompt: 'one', worker_id: 'wu' }), (e) => {
      assert.strictEqual(e.code, 'E_NO_READY');
      assert.strictEqual(e.detail.cause, 'unknown_codex_feature');
      assert.strictEqual(e.detail.feature, 'goals');
      assert.strictEqual(e.detail.codex_version, 'codex-cli 9.9.9-fake');
      assert.match(e.detail.stderr_line, /Unknown feature flag: goals/);
      assert.match(e.message, /Unknown feature flag: goals.*pinned for codex-cli 0\.164\.0.*codex-cli 9\.9\.9-fake/s);
      assert.doesNotMatch(e.message, /startup window/);
      assert.doesNotMatch(e.message, /src\/run|DISABLED_FEATURES/, 'users are not told to edit belay\'s source');
      assert.match(e.message, /Upgrade or downgrade Codex/);
      return true;
    });
  } finally { await done(); }
});

test('explainStart does not throw when the text after the colon is on the next line, and ignores other output', async () => {
  assert.strictEqual(await CS.explainStart('/nope', 'Error: Unknown feature flag:\ngoals\n'), null);
  assert.strictEqual(await CS.explainStart('/nope', 'some other error'), null);
  const x = await CS.explainStart('/nope', 'noise\nError: Unknown feature flag: goals\n');
  assert.strictEqual(x.detail.feature, 'goals');
  assert.strictEqual(x.detail.codex_version, null, 'no readable receipt: the version is unknown, said so');
});
