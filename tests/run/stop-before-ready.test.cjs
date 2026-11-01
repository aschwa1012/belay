'use strict';
// stop-before-ready.test.cjs — a stop that lands between a spawn's launch and its ready event. The worker was stopped on purpose, so the
// spawn's failed-start path must leave the `stopped` row as it is (no `dead` row, no death wake, no lease release) and its error must
// name the stop, not the startup window. The fake never sends `system/init` (FAKE_HANG) and exits when its stdin closes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { cleanup } = require('../core/helpers.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');

test('a stop between launch and ready: the row ends stopped, the spawn error names the stop', async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stop-ready-'));
  const data = path.join(sb, 'data').replace(/\\/g, '/');
  const worktree = path.join(sb, 'wt').replace(/\\/g, '/');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore();
  let launched; const isLaunched = new Promise((r) => { launched = r; });
  const write = core.worker.write;
  core.worker.write = async (r) => { if (r.state === 'starting' && r.pid) launched(); return write(r); };
  const prev = process.env.FAKE_HANG; process.env.FAKE_HANG = '1';
  const m = createRunManager({ core, dataDir: data, runId: 'run-fake', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    const sp = m.spawn({ substrate: 'claude-code', worktree, prompt: 'go', worker_id: 'w1', startup_timeout_ms: 60000 }).then((r) => ({ ok: r }), (e) => ({ err: e }));
    await isLaunched;
    await m.stop({ worker_id: 'w1' });
    const r = await sp;
    await m._worker('w1').queue;
    assert.ok(r.err, 'the spawn fails');
    assert.strictEqual(r.err.code, 'E_NO_READY');
    assert.match(r.err.message, /stop/, r.err.message);
    assert.doesNotMatch(r.err.message, /startup window/);
    const states = core.rowsFor('w1').map((x) => x.state);
    assert.ok(!states.includes('dead'), `no dead row for a stopped worker: ${states}`);
    assert.strictEqual(core.currentWorker('w1').state, 'stopped');
  } finally {
    if (prev === undefined) delete process.env.FAKE_HANG; else process.env.FAKE_HANG = prev;
    await m.shutdown();
    cleanup(sb);
  }
});
