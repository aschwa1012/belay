'use strict';
// stop-tree-kill-stale.test.cjs — a stop's receipt names the tree kill that stop made, never one an earlier life's stop made.
// Before, `tree_kill` was read off the worker record, so a graceful stop after a restart reported the kill of the life before it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');

test('a graceful stop after a restart carries no tree_kill from the stop that killed the life before', { timeout: 90000 }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-tree-kill-')).split(path.sep).join('/');
  fs.mkdirSync(`${d}/wt`, { recursive: true });
  const m = createRunManager({ core: createFakeCore(), dataDir: d, runId: 'run-tk', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    await m.spawn({ substrate: 'claude-code', worktree: `${d}/wt`, prompt: 'one', worker_id: 'tk' });
    const killed = await m.stop({ worker_id: 'tk', mode: 'kill', timeout_ms: 8000 });
    assert.equal(killed.killed, true);
    assert.ok(killed.tree_kill, 'the kill carries its own receipt');
    const r = await m.restart({ worker_id: 'tk', first_turn_timeout_ms: 8000 });
    assert.notEqual(r.new_pid, killed.pid);
    const s = await m.stop({ worker_id: 'tk', mode: 'graceful', timeout_ms: 8000 });
    assert.deepStrictEqual([s.graceful, s.killed, s.tree_kill], [true, false, null], JSON.stringify(s));
  } finally {
    await m.shutdown();
    cleanup(d);
  }
});
