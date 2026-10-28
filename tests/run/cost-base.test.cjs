'use strict';
// cost-base.test.cjs — Claude Code's total_cost_usd is cumulative per session. A restart that starts a FRESH session (the replace
// branch) begins at zero, so the row's reported cost carries the earlier sessions' as a base rather than being set below it
// (ADR 0068, proposed). A resume of the same session keeps the total and so keeps no base.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => p.replace(/\\/g, '/');

test('restart on the replace branch adds the earlier session reported cost as a base; a resume does not', async (t) => {
  const data = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cost-base-')));
  const worktree = fwd(path.join(data, 'wt'));
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore({ runId: 'run-cb', resumeLineText: 'LINE' });
  const m = createRunManager({ core, dataDir: data, runId: 'run-cb', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  t.after(async () => { await m.shutdown().catch(() => {}); try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* tmp */ } });
  await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'cb' });
  await m._waitTurn('cb', 8000);
  const w = m._worker('cb');
  const first = w.costUsd;
  assert.ok(first > 0, 'the fake reports a cost');
  assert.strictEqual(w.costBase, 0);

  // A resume of the same session: the new process starts from the session total (FAKE_COST_BASE is how the fake inherits it), no base.
  await m.stop({ worker_id: 'cb', mode: 'kill', timeout_ms: 5000 });
  await m.restart({ worker_id: 'cb', first_turn_timeout_ms: 20000 });
  assert.strictEqual(w.costBase, 0, 'the resume branch keeps no base');

  // A fresh session: its total starts at zero, and the row keeps what the earlier session reported.
  const before = w.costUsd;
  await m.stop({ worker_id: 'cb', mode: 'kill', timeout_ms: 5000 });
  w.sessionId = null;
  await m.restart({ worker_id: 'cb', first_turn_timeout_ms: 20000 });
  assert.strictEqual(w.costBase, before, 'the base is the cost recorded before the fresh session');
  assert.ok(w.costUsd >= before, `cost ${w.costUsd} did not fall below ${before}`);
  assert.strictEqual(core.currentWorker('cb').cost_base, before);
});
