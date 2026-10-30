'use strict';
// spawn-pause-gap.test.cjs — a pause that lands between the spawn gate and the task assignment. The gate has passed, the worker's
// `starting` row is written, and the assignment is then refused E_PAUSED. Nothing may launch, the refusal reaches the caller as the
// gate's own code, the unstarted worker and its directory are dropped, and the message no longer implies nothing was written (the
// row is, dead). The core is a double whose pause is flipped by the `starting` write: a deterministic seam, no timing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { cleanup } = require('../core/helpers.cjs');
const { createFakeCore, FakeCoreError } = require('./fake-core.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

test('E_PAUSED from the assignment after the gate: nothing launched, the worker is discarded, the refusal is the gate\'s', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-pause-'));
  const data = path.join(sb, 'data').replace(/\\/g, '/');
  const worktree = path.join(sb, 'wt').replace(/\\/g, '/');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore();
  let paused = false;
  const pausedErr = () => new FakeCoreError('E_PAUSED', 'run run-fake is paused (operator:1), and a paused run starts no new work: wait for the operator\'s resume', { run_id: 'run-fake' });
  core.caller = { role: 'orchestrator', run_id: 'run-fake' };
  core.run = { assertNotPaused: async () => { if (paused) throw pausedErr(); return { paused: false }; } };
  const write = core.worker.write;
  core.worker.write = async (r) => { const out = await write(r); if (r.state === 'starting') paused = true; return out; }; // the pause lands once the row is in
  const assign = core.task.assign;
  core.task.assign = async (a) => { if (paused && !a.check_only) throw pausedErr(); return assign(a); };
  const m = createRunManager({ core, dataDir: data, runId: 'run-fake', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    await assert.rejects(
      m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'wpg', task_id: 't1' }),
      (e) => {
        assert.strictEqual(e.code, 'E_PAUSED', `${e.code}: ${e.message}`);
        assert.match(e.message, /paused run starts no new work/);
        assert.match(e.message, /wpg was not launched/);
        assert.match(e.message, /NEW worker id/);
        assert.strictEqual(e.detail.worker_id, 'wpg');
        assert.strictEqual(e.detail.launched, false);
        return true;
      },
    );
    assert.deepStrictEqual(core.rowsFor('wpg').map((r) => r.state), ['starting', 'dead'], 'the starting row is not left claiming a life');
    assert.strictEqual(fs.existsSync(path.join(data, 'workers', 'wpg')), false, 'the unstarted worker\'s directory is dropped');
    assert.deepStrictEqual(core.callsTo('task.assign').filter((c) => !c.args.check_only), [], 'no assignment was recorded');
    // The gate now refuses a second spawn up front, before any row.
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'wpg2', task_id: 't1' }), (e) => e.code === 'E_PAUSED');
    assert.deepStrictEqual(core.rowsFor('wpg2'), []);
  } finally {
    await m.shutdown();
    cleanup(sb);
  }
});
