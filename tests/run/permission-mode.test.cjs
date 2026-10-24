'use strict';
// ADR 0021 decisions 2 to 4: a Claude Code launch defaults to `auto`, and every launch reports the
// mode it asked for beside the one its system/init says it got, and the Claude Code version. The
// facts come from the substrate's own event (the fake reports what it was launched with, or what
// FAKE_PERMISSION_MODE says a model without auto mode fell back to), never from the request alone.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const L = require('../../src/run/launch.cjs');
const { initFacts } = require('../../src/run/ready.cjs');
const { createParser } = require('../../src/run/parsers.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup, callerFor } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-perm-mode-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-perm',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

test('the default permission mode is auto, for a worker and for the orchestrator', () => {
  assert.equal(L.DEFAULT_PERMISSION_MODE, 'auto');
  const w = L.claudeLaunchArgv({ workerId: 'w1', mcpJsonPath: 'm', settingsPath: 's' });
  assert.equal(w[w.indexOf('--permission-mode') + 1], 'auto');
  const o = L.orchestratorLaunchArgv({ mcpJsonPath: 'm', settingsPath: 's' });
  assert.equal(o[o.indexOf('--permission-mode') + 1], 'auto');
});

test('initFacts reports a match, a degradation, and claims nothing when init carried no mode', () => {
  assert.deepStrictEqual(initFacts('auto', { permission_mode: 'auto', claude_code_version: '2.1.280' }), {
    permission_mode_requested: 'auto', permission_mode_effective: 'auto', permission_mode_degraded: false, claude_code_version: '2.1.280',
  });
  assert.deepStrictEqual(initFacts('auto', { permission_mode: 'default', claude_code_version: '2.1.280' }), {
    permission_mode_requested: 'auto', permission_mode_effective: 'default', permission_mode_degraded: true, claude_code_version: '2.1.280',
  });
  assert.deepStrictEqual(initFacts('auto', { session_id: 't1' }), {
    permission_mode_requested: null, permission_mode_effective: null, permission_mode_degraded: null, claude_code_version: null,
  });
});

test('the Claude Code ready event carries the init event\'s permissionMode and claude_code_version', () => {
  const p = createParser('claude-code');
  const [ev] = p.pushLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', permissionMode: 'default', claude_code_version: '2.1.280', mcp_servers: [] }));
  assert.equal(ev.kind, 'ready');
  assert.equal(ev.permission_mode, 'default');
  assert.equal(ev.claude_code_version, '2.1.280');
});

for (const [label, fakeMode, effective, degraded] of [
  ['a launch that got auto', null, 'auto', false],
  ['a launch that fell back to default (a model without auto mode)', 'default', 'default', true],
]) {
  test(`spawn reports ${label}, on the returned row and on the row the store holds`, async () => {
    const sb = sandbox();
    const core = createFakeCore();
    const m = mgr(sb, core);
    const saved = process.env.FAKE_PERMISSION_MODE;
    if (fakeMode) process.env.FAKE_PERMISSION_MODE = fakeMode; else delete process.env.FAKE_PERMISSION_MODE;
    try {
      const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w1' });
      assert.equal(row.permission_mode_requested, 'auto');
      assert.equal(row.permission_mode_effective, effective);
      assert.equal(row.permission_mode_degraded, degraded);
      assert.equal(row.claude_code_version, '2.1.280-fake');
      const stored = await core.worker.get({ worker_id: 'w1' });
      assert.equal(stored.permission_mode_effective, effective, 'the store holds the effective mode, not just the receipt');
      assert.equal(stored.claude_code_version, '2.1.280-fake');
      const argv = JSON.parse(fs.readFileSync(path.join(sb.data, 'workers', 'w1', 'argv.json'), 'utf8'));
      const flat = JSON.stringify(argv);
      assert.ok(flat.includes('"--permission-mode","auto"'), `the launch asked for auto: ${flat.slice(0, 300)}`);
    } finally {
      if (saved === undefined) delete process.env.FAKE_PERMISSION_MODE; else process.env.FAKE_PERMISSION_MODE = saved;
      await m.shutdown(); cleanup(sb.data);
    }
  });
}

test('the real core stores the three columns, which reach every store through the additive migrations, and a later write inherits them', async (tcx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-perm-core-')).replace(/\\/g, '/');
  try {
    const o = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => o.shutdownOwner()));
    tcx.after(() => Promise.resolve().then(() => o.close()));
    await o.run.attach({ adapter_pid: process.pid });
    const w = await o.worker.write({
      id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running',
      permission_mode_requested: 'auto', permission_mode_effective: 'default', claude_code_version: '2.1.280',
    });
    assert.equal(w.permission_mode_requested, 'auto');
    assert.equal(w.permission_mode_effective, 'default');
    assert.equal(w.claude_code_version, '2.1.280');
    // A later write that does not name them inherits them (methods-run.cjs's merge rule).
    const w2 = await o.worker.write({ id: 'w1', state: 'idle' });
    assert.equal(w2.permission_mode_effective, 'default');
    await o.shutdownOwner();
    await o.close();
  } finally {
    cleanup(dir);
  }
});

// ADR 0021 amendment 3: the floor is the operator's, because Opus 5.5 is served from 2.1.280 on.
test('compareVersions reads the leading dotted numbers, and the floor is 2.1.280', () => {
  const { compareVersions, MIN_CLAUDE_CODE_VERSION } = require('../../src/run/ready.cjs');
  assert.equal(MIN_CLAUDE_CODE_VERSION, '2.1.280');
  assert.equal(compareVersions('2.1.268', '2.1.280'), -1);
  assert.equal(compareVersions('2.1.281', '2.1.280'), 1);
  assert.equal(compareVersions('2.1.280-fake', '2.1.280'), 0);
  assert.equal(compareVersions('2.2.0', '2.1.280'), 1);
  assert.equal(compareVersions('10.0.0', '9.9.9'), 1);
});

test('spawn refuses a Claude Code older than the floor with E_NO_READY naming both versions, and writes no running row', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  const saved = process.env.FAKE_CLAUDE_CODE_VERSION;
  process.env.FAKE_CLAUDE_CODE_VERSION = '2.1.268';
  try {
    await assert.rejects(
      m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w-old' }),
      (e) => e.code === 'E_NO_READY' && /2\.1\.268/.test(JSON.stringify(e.details || e.message)) && /2\.1\.280/.test(JSON.stringify(e.details || e.message)),
    );
    const stored = await core.worker.get({ worker_id: 'w-old' });
    assert.equal(stored.state, 'dead', 'a refused launch leaves a dead row, never a running one');
  } finally {
    if (saved === undefined) delete process.env.FAKE_CLAUDE_CODE_VERSION; else process.env.FAKE_CLAUDE_CODE_VERSION = saved;
    await m.shutdown(); cleanup(sb.data);
  }
});

test('the Claude Code executable comes from BELAY_CLAUDE_EXE first', () => {
  const prev = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = 'C:/x/claude.exe';
  try { assert.equal(L.claudeExe(), 'C:/x/claude.exe'); } finally {
    if (prev === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = prev;
  }
});
