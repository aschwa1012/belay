'use strict';
// The pid poll holds a death for the child's own exit event (src/run/manager.cjs POLL_EXIT_HOLD_MS), so the
// first dead row, and the wake built from it, carries the exit code the late event delivers. Past the bound
// it settles as before: null code, established by pid-poll.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { POLL_EXIT_HOLD_MS } = require('../../src/run/worker.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');
const P = require('../../src/run/process.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-hold-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.split(path.sep).join('/'), worktree: path.join(d, 'wt').split(path.sep).join('/') };
}

function mgr(sb, core) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-test',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

// Spawn, make the child's 'exit' event late (delayMs) or never (null), kill it by its exact pid, and
// return the first `dead` row the core saw plus how long it took to appear.
async function killWithExitLag(id, delayMs) {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id });
    const w = m._worker(id);
    const emit = w.child.emit;
    w.child.emit = function (ev, ...a) {
      if (ev !== 'exit') return emit.call(this, ev, ...a);
      if (delayMs != null) setTimeout(() => emit.call(this, ev, ...a), delayMs);
      return true;
    };
    const t0 = Date.now();
    process.kill(w.pid); // exact pid
    let dead;
    while (!(dead = core.rowsFor(id).find((r) => r.state === 'dead'))) {
      assert.ok(Date.now() - t0 < POLL_EXIT_HOLD_MS + 8000, 'no dead row');
      await sleep(25);
    }
    return { dead, ms: Date.now() - t0 };
  } finally { await m.shutdown(); cleanup(sb.data); }
}

test('a late exit event: the first dead row carries the integer exit code, established by the exit event', async () => {
  const { dead, ms } = await killWithExitLag('hold1', 2500);
  assert.ok(Number.isInteger(dead.exit_code), `exit_code ${dead.exit_code}`);
  assert.match(dead.death_established_by, /exit-event/);
  assert.ok(ms >= 2000, `the death was held for the event (${ms} ms)`);
});

test('an exit event that never comes: the death settles after the bound with a null code, by pid-poll', async () => {
  const { dead, ms } = await killWithExitLag('hold2', null);
  assert.equal(dead.exit_code == null, true);
  assert.equal(dead.death_established_by, 'pid-poll');
  assert.ok(ms >= POLL_EXIT_HOLD_MS - 100, `held for the bound (${ms} ms)`);
});

// A held death must not leave stop or restart working around an unsettled record: stop writes the terminal row
// and restart gives the old life its dead row before relaunching.
async function heldDeath(id, m, core, sb) {
  await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: id });
  const w = m._worker(id);
  const emit = w.child.emit;
  w.child.emit = function (ev, ...a) {
    if (ev === 'exit') { setTimeout(() => emit.call(this, ev, ...a), 3000); return true; }
    return emit.call(this, ev, ...a);
  };
  const oldPid = w.pid;
  process.kill(oldPid); // exact pid
  while (P.pidAlive(oldPid)) await sleep(20);
  assert.equal(w.settled, false, 'premise: the death is held, not settled');
  return oldPid;
}

test('stop during the hold settles the held death and writes a stopped row at once', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core);
  try {
    await heldDeath('hold3', m, core, sb);
    const t0 = Date.now();
    await m.stop({ worker_id: 'hold3' });
    assert.ok(Date.now() - t0 < 2000, 'stop did not wait out the hold');
    assert.equal(core.currentWorker('hold3').state, 'stopped');
  } finally { await m.shutdown(); cleanup(sb.data); }
});

test('restart during the hold gives the old life its dead row before the relaunch', async () => {
  const sb = sandbox(); const core = createFakeCore(); const m = mgr(sb, core);
  try {
    const oldPid = await heldDeath('hold4', m, core, sb);
    await m.restart({ worker_id: 'hold4', first_turn_timeout_ms: 20000 });
    const rows = core.rowsFor('hold4');
    assert.ok(rows.some((r) => r.state === 'dead' && r.pid === oldPid), JSON.stringify(rows.map((r) => [r.state, r.pid])));
  } finally { await m.shutdown(); cleanup(sb.data); }
});
