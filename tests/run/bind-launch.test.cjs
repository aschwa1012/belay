'use strict';
// bind-launch.test.cjs — ADR 0045 decision 2, the spawning side: every launch of an adapter binds it first. The run manager asks the
// core for a bind, writes its pipe name into the worker's mcp.json as --bind, and a restart opens a fresh one and revokes the last;
// a core that cannot open a bind fails the launch E_BIND and nothing starts. The orchestrator's files carry its bind the same way.
// Real manager, the fake core and the fake Claude.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const L = require('../../src/run/launch.cjs');
const BL = require('../../src/run/bind-launch.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/[\\]/g, '/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json');

// The fake core with the two bind verbs a real core has, recording what the manager asked.
function bindingCore({ failOpen = false } = {}) {
  const core = createFakeCore();
  const log = { opened: [], revoked: [] };
  let n = 0;
  core.bindOpen = async (identity) => {
    if (failOpen) { const e = new Error('the owner is not serving binds'); e.code = 'E_ROLE'; throw e; }
    n += 1;
    log.opened.push(identity);
    return { bind_id: `b${n}`, pipe: `belay-test-bind-${n}`, caller: identity };
  };
  core.bindRevoke = async (id) => { log.revoked.push(id); return { bind_id: id, state: 'revoked' }; };
  return { core, log };
}

const mcpArgs = (data, id) => JSON.parse(fs.readFileSync(path.join(data, 'workers', id, 'mcp.json'), 'utf8')).mcpServers.belay.args;
const bindOf = (args) => (args.includes('--bind') ? args[args.indexOf('--bind') + 1] : null);

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-bindl-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/[\\]/g, '/'), worktree: path.join(d, 'wt').replace(/[\\]/g, '/') };
}

test('spawn binds the worker it launches, and a restart opens a fresh bind and revokes the last', async () => {
  const { data, worktree } = sandbox();
  const { core, log } = bindingCore();
  const m = createRunManager({ core, dataDir: data, runId: 'run-bl', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
  try {
    await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w-bind' });
    assert.deepStrictEqual(log.opened, [{ role: 'worker', run_id: 'run-bl', worker_id: 'w-bind' }], 'a bind for exactly this worker of this run');
    assert.strictEqual(bindOf(mcpArgs(data, 'w-bind')), 'belay-test-bind-1');
    const r = await m.restart({ worker_id: 'w-bind' });
    assert.notStrictEqual(r.restarted, false, JSON.stringify(r));
    assert.strictEqual(bindOf(mcpArgs(data, 'w-bind')), 'belay-test-bind-2', 'the relaunch reads a fresh bind, not the spent one');
    assert.deepStrictEqual(log.revoked, ['b1'], 'the spent bind was revoked');
  } finally { await m.shutdown(); cleanup(data); }
});

test('a core that cannot open a bind fails the launch E_BIND and no worker process starts', async () => {
  const { data, worktree } = sandbox();
  const { core } = bindingCore({ failOpen: true });
  const m = createRunManager({ core, dataDir: data, runId: 'run-bl', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
  try {
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w-nobind' }), (e) => e.code === 'E_BIND' && /would not open a bind/.test(e.message));
    assert.ok(!fs.existsSync(path.join(data, 'workers', 'w-nobind', 'argv.json')), 'the launch never got as far as writing its argv');
  } finally { await m.shutdown(); cleanup(data); }
});

test('a core with no bind verbs launches unbound, byte for byte as before: no --bind anywhere', async () => {
  const { data, worktree } = sandbox();
  const m = createRunManager({ core: createFakeCore(), dataDir: data, runId: 'run-bl', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
  try {
    await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w-plain' });
    assert.strictEqual(bindOf(mcpArgs(data, 'w-plain')), null);
  } finally { await m.shutdown(); cleanup(data); }
});

test('a Codex worker carries its bind in the argv it is launched with', async () => {
  const { core } = bindingCore();
  const w = { id: 'w-cx', substrate: 'codex', adapterLogPath: null, permissionPrompt: false, permitWaitMs: null, notesOn: false, bindId: null };
  await BL.bindWorker({ core, runId: 'run-bl', root: 'C:/x/data', mcpPath: 'C:/x/belay-mcp.cjs' }, w);
  assert.deepStrictEqual(w.adapterArgs.slice(-2), ['--bind', 'belay-test-bind-1']);
  assert.ok(w.adapterArgs.includes('--worker-id') && w.adapterArgs.includes('w-cx'));
  assert.strictEqual(w.bindId, 'b1');
});

test('the orchestrator\'s files carry its bind; with no bind they carry none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-bindo-'));
  try {
    const data = path.join(dir, 'data');
    const withBind = L.writeOrchestratorFiles({ dir: path.join(dir, 'orch1'), runId: 'run-bl', dataDir: data, settingsPath: USER_SETTINGS, bind: 'belay-test-bind-9' });
    const args = JSON.parse(fs.readFileSync(withBind.mcpJsonPath, 'utf8')).mcpServers.belay.args;
    assert.strictEqual(bindOf(args), 'belay-test-bind-9');
    const without = L.writeOrchestratorFiles({ dir: path.join(dir, 'orch2'), runId: 'run-bl', dataDir: data, settingsPath: USER_SETTINGS });
    assert.strictEqual(bindOf(JSON.parse(fs.readFileSync(without.mcpJsonPath, 'utf8')).mcpServers.belay.args), null);
  } finally { cleanup(dir); }
});

test('launchBound: a second launch of a worker while the first awaits its bind is refused E_SUBSTRATE, and the slot is free again after', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const core = { bindOpen: async (identity) => { await gate; return { bind_id: 'b1', pipe: 'belay-test-bind-slow', caller: identity }; }, bindRevoke: async () => ({}) };
  const w = { id: 'w-slot', substrate: 'codex', state: 'idle', adapterLogPath: null, permissionPrompt: false, permitWaitMs: null, notesOn: false, bindId: null };
  let launches = 0;
  const env = { core, runId: 'run-bl', root: 'C:/x/data', mcpPath: 'C:/x/belay-mcp.cjs' };
  const first = BL.launchBound(env, w, async () => { launches += 1; return 'launched'; });
  await assert.rejects(BL.launchBound(env, w, async () => { launches += 1; }), (e) => e.code === 'E_SUBSTRATE' && /already in progress/.test(e.message));
  release();
  assert.strictEqual(await first, 'launched');
  assert.strictEqual(launches, 1, 'exactly one launch ran');
  assert.strictEqual(await BL.launchBound(env, w, async () => 'again'), 'again', 'the slot was released');
  const failing = BL.launchBound(env, w, async () => { throw new Error('spawn failed'); });
  await assert.rejects(failing, /spawn failed/);
  assert.strictEqual(w.launchSlot, false, 'a failed launch released the slot too');
});
