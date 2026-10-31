'use strict';
// spawn-pause-inflight.test.cjs — a run pause that lands after a taskless spawn passed the paused gate but before it launched. The
// pause lists only rows with a live pid, so it cannot name this worker; the spawn must therefore look again just before its launch and
// refuse (nothing launched, the gate's own code, the row written dead). Seam: the spawn's first pidless `starting` write stalls on a
// deferred while the pause is flipped. No timing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { cleanup } = require('../core/helpers.cjs');
const { createFakeCore, FakeCoreError } = require('./fake-core.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

test('a pause landing after the spawn gate and before the launch: the spawn is refused E_PAUSED and starts no process', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-pause-inflight-'));
  const data = path.join(sb, 'data').replace(/\\/g, '/');
  const worktree = path.join(sb, 'wt').replace(/\\/g, '/');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore();
  let paused = false;
  core.caller = { role: 'orchestrator', run_id: 'run-fake' };
  core.run = { assertNotPaused: async () => { if (paused) throw new FakeCoreError('E_PAUSED', 'run run-fake is paused (operator:1), and a paused run starts no new work', { run_id: 'run-fake' }); return { paused: false }; } };
  let release; const gate = new Promise((r) => { release = r; });
  let entered; const stalled = new Promise((r) => { entered = r; });
  const write = core.worker.write; let first = true;
  core.worker.write = async (r) => { if (first && r.state === 'starting' && r.pid == null) { first = false; entered(); await gate; } return write(r); };
  const m = createRunManager({ core, dataDir: data, runId: 'run-fake', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    const sp = m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'w1' }).then((r) => ({ ok: r }), (e) => ({ err: e }));
    await stalled;
    paused = true; // the run pause: it set the row first, and its listing found no live pid to park
    release();
    const r = await sp;
    assert.ok(r.err, 'the spawn is refused');
    assert.strictEqual(r.err.code, 'E_PAUSED', `${r.err.code}: ${r.err.message}`);
    assert.strictEqual(r.err.detail.launched, false);
    assert.strictEqual(core.rowsFor('w1').filter((x) => x.pid).length, 0, 'no row ever carried a pid');
    assert.strictEqual(core.currentWorker('w1').state, 'dead', 'the starting row is not left claiming a life');
  } finally {
    await m.shutdown();
    cleanup(sb);
  }
});
