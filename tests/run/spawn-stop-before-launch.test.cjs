'use strict';
// spawn-stop-before-launch.test.cjs — a stop that lands while a spawn is still before its launch. The stop finds no process and writes
// `stopped`; the spawn must then refuse to launch (no process, the row stays `stopped`). Seam: the real assignment inside the memory
// preface stalls on a deferred, so the spawn is parked between its worker record and its launch. No timing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { cleanup } = require('../core/helpers.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

test('a stop before the launch: the spawn is refused, no process starts, the row stays stopped', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spawn-stop-'));
  const data = path.join(sb, 'data').replace(/\\/g, '/');
  const worktree = path.join(sb, 'wt').replace(/\\/g, '/');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore();
  let release; const gate = new Promise((r) => { release = r; });
  let entered; const inAssign = new Promise((r) => { entered = r; });
  const assign = core.task.assign;
  core.task.assign = async (a) => { if (!a.check_only) { entered(); await gate; } return assign(a); };
  const m = createRunManager({ core, dataDir: data, runId: 'run-fake', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    const sp = m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'w1', task_id: 't1' }).then((r) => ({ ok: r }), (e) => ({ err: e }));
    await inAssign;
    await m.stop({ worker_id: 'w1' });
    assert.strictEqual(core.currentWorker('w1').state, 'stopped');
    release();
    const r = await sp;
    assert.ok(r.err, 'the spawn a stop overtook is refused');
    assert.strictEqual(r.err.code, 'E_SUBSTRATE', `${r.err.code}: ${r.err.message}`);
    assert.strictEqual(r.err.detail.reason, 'stopped_during_launch');
    assert.strictEqual(r.err.detail.task_id, 't1', 'the refusal names the task whose lease the worker still holds');
    assert.match(r.err.message, /lease/);
    assert.ok(!m._worker('w1').child, 'no process was started');
    assert.ok(!m._worker('w1').pid);
    assert.deepStrictEqual(core.rowsFor('w1').map((x) => x.state), ['starting', 'stopped'], 'nothing is written over the stopped row');
  } finally {
    await m.shutdown();
    cleanup(sb);
  }
});
