'use strict';
// spawn-policy.test.cjs — ADR 0054 decision 4 on the spawn path: an agent type's tool list is the worker's --tools surface,
// allowed_tools narrows within it, web tools are pre-approved, a refusal writes nothing, a relaunch keeps the list from the
// row, and a Codex spawn of a type whose list is not the six is refused. Driven over the fake claude, which reports exactly
// its --tools plus the belay tools.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const TP = require('../../src/run/tool-policy.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => String(p).replace(/\\/g, '/');
const RESEARCHER = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-policy-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}
const argvOf = (sb, id) => JSON.parse(fs.readFileSync(path.join(sb.data, 'workers', id, 'argv.json'), 'utf8')).spec.args;
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const allowed = (args) => { const i = args.indexOf('--allowedTools'); const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j += 1) out.push(args[j]); return out; };
async function withMgr(fn, agentDefaults = null) {
  const sb = sandbox(); const core = createFakeCore();
  const m = createRunManager({
    core, dataDir: sb.data, runId: 'run-spawn-policy', agentDefaults,
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
  try { await fn({ sb, core, m }); } finally { await m.shutdown(); cleanup(sb.data); }
}
const spawn = (m, sb, id, extra) => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id, ...extra });

test('a researcher gets Read, Glob, Grep and the web tools, pre-approved, and no Bash; the row keeps the list', () => withMgr(async ({ sb, core, m }) => {
  const r = await spawn(m, sb, 'r1', { agent_type: 'researcher' });
  const args = argvOf(sb, 'r1');
  assert.strictEqual(flag(args, '--tools'), RESEARCHER.join(','));
  assert.deepStrictEqual(r.surface.builtins, [...RESEARCHER].sort(), 'the ready gate held the launch to the list');
  for (const t of ['WebFetch', 'WebSearch']) assert.ok(allowed(args).includes(t), `${t} is pre-approved`);
  const rows = core.rowsFor('r1');
  assert.deepStrictEqual(rows[rows.length - 1].tools, RESEARCHER, 'the row records the list a relaunch takes');
}));

test('allowed_tools narrows a researcher within its list; Bash past it is refused with nothing written', () => withMgr(async ({ sb, core, m }) => {
  await spawn(m, sb, 'r2', { agent_type: 'researcher', allowed_tools: ['Read', 'WebSearch', 'mcp__belay'] });
  assert.strictEqual(flag(argvOf(sb, 'r2'), '--tools'), 'Read,WebSearch');
  await assert.rejects(spawn(m, sb, 'r3', { agent_type: 'researcher', allowed_tools: ['Read', 'Bash'] }),
    (e) => e.code === 'E_ARGS' && /Bash, outside the researcher list/.test(e.message) && e.detail.source === 'built-in policy for researcher');
  assert.strictEqual(fs.existsSync(path.join(sb.data, 'workers', 'r3')), false, 'no worker directory');
  assert.strictEqual(core.rowsFor('r3').length, 0, 'no row');
}));

test('a coder keeps the six, and the config\'s agents.coder.tools narrows it', async () => {
  await withMgr(async ({ sb, m }) => {
    await spawn(m, sb, 'c1', { agent_type: 'coder' });
    assert.strictEqual(flag(argvOf(sb, 'c1'), '--tools'), 'Read,Edit,Write,Glob,Grep,Bash');
  });
  await withMgr(async ({ sb, m }) => {
    const r = await spawn(m, sb, 'c2', { agent_type: 'coder' });
    assert.strictEqual(flag(argvOf(sb, 'c2'), '--tools'), 'Read,Edit,Glob,Grep');
    assert.deepStrictEqual(r.surface.builtins, ['Edit', 'Glob', 'Grep', 'Read']);
    await assert.rejects(spawn(m, sb, 'c3', { agent_type: 'coder', allowed_tools: ['Bash'] }), (e) => e.code === 'E_ARGS' && /C:\/cfg\/belay\.config\.json agents\.coder\.tools/.test(e.message));
  }, { path: 'C:/cfg/belay.config.json', types: { coder: { tools: ['Read', 'Edit', 'Glob', 'Grep'] } } });
});

test('a restart keeps the researcher\'s list from the row', () => withMgr(async ({ sb, m }) => {
  await spawn(m, sb, 'r4', { agent_type: 'researcher' });
  const r = await m.restart({ worker_id: 'r4', first_turn_timeout_ms: 30000 });
  assert.deepStrictEqual(r.surface.builtins, [...RESEARCHER].sort());
  assert.strictEqual(flag(argvOf(sb, 'r4'), '--tools'), RESEARCHER.join(','));
}));

test('Codex: a researcher is refused E_SUBSTRATE naming its list, with nothing written; a coder passes the policy unchanged', () => withMgr(async ({ sb, core, m }) => {
  await assert.rejects(m.spawn({ substrate: 'codex', worktree: sb.worktree, prompt: 'hi', worker_id: 'x1', agent_type: 'researcher' }),
    (e) => e.code === 'E_SUBSTRATE' && /researcher worker's tools are Read, Glob, Grep, WebFetch, WebSearch/.test(e.message));
  assert.strictEqual(core.rowsFor('x1').length, 0);
  assert.strictEqual(fs.existsSync(path.join(sb.data, 'workers', 'x1')), false);
  // A Codex coder's launch is agent-defaults-codex.test.cjs's; here only the policy's answer for it: no list, no extra pre-approval.
  assert.deepStrictEqual(TP.spawnSurface(null, { substrate: 'codex', agent_type: 'coder' }), { tools: null, allowedTools: null });
}));
