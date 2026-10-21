'use strict';
// bind-launch-steal.test.cjs — ADR 0045 decision 2, a stolen bind: the bind pipe's name is public (it is in the adapter's argv), so a
// process that dials it before the genuine adapter is handed the worker's key, and the genuine adapter finds no listener. The launch
// fails, and a failed launch must leave no key behind. A real owner and the real run manager over the fake Claude; the "thief" is a
// claim made in the test between the bind's opening and the launch, so the interleaving is forced, not raced.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const { createRunManager } = require('../../src/run/index.cjs');
const BL = require('../../src/run/bind-launch.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { claimBind } = require('../../src/core/bind.cjs');
const { pipeName } = require('../../src/core/lock.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json');
const RUN = 'run-steal';

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-steal-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { root: d, data: fwd(path.join(d, 'data')), worktree: fwd(path.join(d, 'wt')) };
}

// One keyed request to the owner's pipe, as the thief would send it.
function keyedCall(dataDir, key, method = 'memory.store', params = { text: 'forged as the worker', embed: false, caller: { role: 'operator', run_id: RUN } }) {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipeName(dataDir));
    let buf = '';
    const timer = setTimeout(() => { s.destroy(); reject(new Error(`no answer to ${method}`)); }, 8000);
    s.on('data', (d) => { buf += d.toString('utf8'); if (buf.includes('\n')) { clearTimeout(timer); s.destroy(); resolve(JSON.parse(buf.split('\n')[0])); } });
    s.on('error', (e) => { clearTimeout(timer); reject(e); });
    s.on('connect', () => s.write(JSON.stringify({ id: 1, method, params, key }) + '\n'));
  });
}

async function withOwnerCore(fn, role = 'operator') {
  const sb = sandbox();
  fs.mkdirSync(sb.data, { recursive: true });
  const core = await openCore({ dataDir: sb.data, caller: { role, run_id: RUN, pid: process.pid }, embed: false });
  try { return await fn(core, sb); } finally { try { if (core.isOwner()) await core.shutdownOwner(); } catch { /* best effort */ } try { await core.close(); } catch { /* best effort */ } cleanup(sb.root); }
}

// The core, with its bindOpen wrapped so a thief claims every bind the instant it exists, before the launch can use it.
function thiefCore(core, loot) {
  const open = core.bindOpen.bind(core);
  core.bindOpen = async (identity, opts) => {
    const b = await open(identity, opts);
    loot.push({ bind_id: b.bind_id, ...(await claimBind(b.pipe, { timeoutMs: 3000 })) });
    return b;
  };
  return core;
}

test('a launch whose bind was stolen fails, and the thief\'s key is dead: E_UNBOUND, not a write as the worker', async () => {
  await withOwnerCore(async (core, sb) => {
    const loot = [];
    thiefCore(core, loot);
    const m = createRunManager({ core, dataDir: sb.data, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
    process.env.FAKE_MCP = 'failed'; // the genuine adapter found no listener, so Claude Code reports the belay server not connected
    try {
      await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w-stolen', startup_timeout_ms: 8000 }), (e) => {
        assert.strictEqual(e.code, 'E_NO_READY');
        assert.strictEqual(e.detail.bind_id, loot[0].bind_id, 'the error names the bind it revoked');
        assert.strictEqual(e.detail.bind_revoked, true);
        return true;
      });
      assert.strictEqual(loot.length, 1, 'the thief claimed this launch\'s bind');
      assert.strictEqual((await core.bindStatus(loot[0].bind_id)).state, 'revoked');
      const r = await keyedCall(sb.data, loot[0].key);
      assert.strictEqual(r.error && r.error.code, 'E_UNBOUND', `the stolen key must be dead: ${JSON.stringify(r)}`);
      assert.strictEqual(r.error.detail.reason, 'key');
      assert.strictEqual(m._worker('w-stolen').bindId, null, 'the worker record holds no bind');
    } finally { delete process.env.FAKE_MCP; await m.shutdown().catch(() => {}); }
  }, 'orchestrator');
});

test('control: while the launch is alive, the same key works (the test would not notice a key that never worked)', async () => {
  await withOwnerCore(async (core, sb) => {
    const opened = await core.bindOpen({ role: 'worker', run_id: RUN, worker_id: 'w-ok' });
    const claimed = await claimBind(opened.pipe, { timeoutMs: 3000 });
    const r = await keyedCall(sb.data, claimed.key);
    assert.ok(r.result && r.result.id, JSON.stringify(r));
    assert.strictEqual(r.result.written_by, 'worker:w-ok', 'it runs as the bound worker, whatever the request claims');
  });
});

test('a bind whose config write fails is revoked at once, and the worker keeps no bind id', async () => {
  await withOwnerCore(async (core, sb) => {
    const w = { id: 'w-cfg', substrate: 'claude-code', adapterLogPath: null, permissionPrompt: false, permitWaitMs: null, notesOn: false, bindId: null, mcpJsonPath: fwd(path.join(sb.root, 'no-such-dir', 'mcp.json')) };
    const seen = [];
    const open = core.bindOpen.bind(core);
    core.bindOpen = async (i, o) => { const b = await open(i, o); seen.push(b); return b; };
    await assert.rejects(BL.bindWorker({ core, runId: RUN, root: sb.data, mcpPath: 'C:/x/belay-mcp.cjs' }, w), (e) => e.code === 'ENOENT');
    assert.strictEqual(w.bindId, null);
    assert.strictEqual((await core.bindStatus(seen[0].bind_id)).state, 'revoked');
    await assert.rejects(claimBind(seen[0].pipe, { timeoutMs: 1500 }), (e) => e.code === 'E_BIND', 'and nothing listens on it');
  });
});

test('a launch that throws after its bind was opened revokes it', async () => {
  await withOwnerCore(async (core, sb) => {
    const w = { id: 'w-throw', substrate: 'codex', state: 'idle', adapterLogPath: null, permissionPrompt: false, permitWaitMs: null, notesOn: false, bindId: null };
    const seen = [];
    const open = core.bindOpen.bind(core);
    core.bindOpen = async (i, o) => { const b = await open(i, o); seen.push(b); return b; };
    await assert.rejects(BL.launchBound({ core, runId: RUN, root: sb.data, mcpPath: 'C:/x/belay-mcp.cjs' }, w, async () => { throw new Error('spawn failed'); }), /spawn failed/);
    assert.strictEqual(w.bindId, null);
    assert.strictEqual((await core.bindStatus(seen[0].bind_id)).state, 'revoked');
  });
});
