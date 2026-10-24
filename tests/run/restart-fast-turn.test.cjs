'use strict';
// restart-fast-turn.test.cjs — a relaunch whose first turn ends before `restart` starts waiting for it.
// On a slow runner the fake's reply was parsed and its turn end processed while doRestart was still writing
// the relaunch's `running` row; the turn's waiters were resolved with nobody registered, and `restart` then
// waited out its whole first_turn_timeout_ms for a turn that had already happened. The seam holds that
// `running` row until the relaunched process's turn end has been parsed, forcing the CI ordering every time.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const fwd = (p) => p.replace(/\\/g, '/');
const FIRST_TURN_MS = 20000;

async function until(pred, ms) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

test("restart: a first turn that ends while the relaunch's running row is still being written is reported, not waited out", async () => {
  const data = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-restart-fast-')));
  const worktree = fwd(path.join(data, 'wt'));
  fs.mkdirSync(worktree, { recursive: true });
  const core = createFakeCore({ runId: 'run-fake', resumeLineText: 'LINE' });
  const m = createRunManager({
    core, dataDir: data, runId: 'run-fake',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
  try {
    const first = await m.spawn({ substrate: 'claude-code', worktree, prompt: 'hello', worker_id: 'w1' });
    await m._waitTurn('w1', 8000);
    const w = m._worker('w1');

    // The seam: from here on, the first `running` row for a pid other than the original is held until that
    // process's turn end has been parsed (pendingTurnEnd set) or its turn already counted.
    let held = null;
    const turnsBefore = w.turns;
    const write = core.worker.write.bind(core.worker);
    core.worker.write = async (row) => {
      if (held === null && row.state === 'running' && row.pid && row.pid !== first.pid) {
        held = 'holding'; // armed once, synchronously: the turn end's own running row passes straight through
        held = await until(() => w.pendingTurnEnd !== null || w.turns > turnsBefore, 10000);
      }
      return write(row);
    };

    const t0 = Date.now();
    const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: FIRST_TURN_MS });
    const ms = Date.now() - t0;
    assert.strictEqual(held, true, 'the seam must have held the running row until the turn end was parsed');
    assert.strictEqual(r.first_turn_timed_out, false, JSON.stringify(r));
    assert.strictEqual(r.first_turn_ended_by, 'turn');
    assert.ok(r.first_turn_usage, 'the turn that already ended carries its usage');
    assert.ok(ms < FIRST_TURN_MS / 2, `restart took ${ms} ms; it waited for a turn that had already ended`);
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(data);
  }
});
