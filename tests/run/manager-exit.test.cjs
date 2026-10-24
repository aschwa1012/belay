'use strict';
// The run manager against a fake substrate and the in-memory fake core. Every assertion is about
// an effect: a row written, a checkpoint written, a memory entry written, a file on disk. A
// returned status word on its own is never treated as proof (invariant 5).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');
const P = require('../../src/run/process.cjs');
const { ROTATE_AT } = require('../../src/run/wire-log.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const FAKE_NOREADY = path.join(__dirname, 'fakes', 'fake-claude-noready.cjs').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wave-2 flake fix (build 12): the pid poll can find a killed child gone long before the child's own
// 'exit' event is delivered (receipts/w2-flakes/exit-lag-32.txt: gone at 0.4 ms, exit at 4.7 s under CPU
// saturation). settle()'s fill-in branch writes the real exit code when the event arrives, so the contract
// is eventual: dead at once, exit code once the event lands. These tests wait for that event itself
// (worker.exitEventSeen) and then for the record's write queue, never for a wall-clock bound.

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-mgr-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}

function mgr(sb, core, exe = FAKE) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-test',
    paths: { claudeExe: exe, codexExe: exe, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}

// Every test's own teardown, in a `finally` so a failing assertion still runs it (build step 6h
// design item 2): the sanctioned stop, then the retrying cleanup tests/core/helpers.cjs exports.
async function teardown(m, sb) { await m.shutdown(); cleanup(sb.data); }
test('a launch rotates a worker adapter.log that is at the threshold, before it takes the start offset (review A1-2)', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  try {
    const dir = path.join(sb.data, 'workers', 'wr');
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'wr' }); // a caller-named id needs a fresh directory, so the log is planted after the first life and the second launch is a restart
    await m.stop({ worker_id: 'wr', mode: 'kill', timeout_ms: 8000 });
    const old = 'x'.repeat(ROTATE_AT);
    fs.writeFileSync(path.join(dir, 'adapter.log'), old);
    fs.writeFileSync(path.join(dir, 'adapter.log.1'), 'an older rotation');
    await m.restart({ worker_id: 'wr' });
    assert.equal(fs.readFileSync(path.join(dir, 'adapter.log.1'), 'utf8'), old, '.1 holds the large file, replacing the older .1');
    const live = path.join(dir, 'adapter.log');
    assert.ok(!fs.existsSync(live) || fs.statSync(live).size < 64 * 1024, 'the live file starts fresh');
  } finally { await teardown(m, sb); }
});

test('forced exit lag: E_NO_READY still carries the exit code when the exit event trails the pid check', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE_NOREADY);
  try {
    const p = m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w2lag', startup_timeout_ms: 1500 });
    let w;
    while (!(w = m._worker('w2lag')) || !w.child) await sleep(5);
    const emit = w.child.emit;
    w.child.emit = function (ev, ...a) {
      if (ev === 'exit') { setTimeout(() => emit.call(this, ev, ...a), 2500); return true; }
      return emit.call(this, ev, ...a);
    };
    await assert.rejects(() => p, (e) => {
      assert.equal(e.code, 'E_NO_READY');
      assert.equal(e.detail.exit_code, 1, JSON.stringify(e.detail.death_established_by));
      return true;
    });
    await w.queue;
    assert.equal(core.currentWorker('w2lag').exit_code, 1);
  } finally { await teardown(m, sb); }
});

test('a killed worker is written dead, and carries its exit code once the exit event lands', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w3' });
    const t0 = Date.now();
    require('../crash.cjs').crash(m._worker('w3').child);
    await m._waitExit('w3', 8000);
    // _waitExit resolves when either channel settles the record, but the exit code arrives only with the
    // exit event, which can trail the pid poll. Wait for that event and the queued writes behind it.
    const w = m._worker('w3');
    await w.exitEventSeen;
    await w.queue;
    const cur = core.currentWorker('w3');
    const ms = Date.now() - t0; // recorded in the failure message, never asserted: it measures the host's load
    assert.equal(cur.state, 'dead');
    assert.ok(
      Number.isInteger(cur.exit_code) || typeof cur.exit_signal === 'string',
      'the row must carry the exit code or the signal once the exit event landed (' + ms + ' ms after the kill), got ' + JSON.stringify({ exit_code: cur.exit_code, exit_signal: cur.exit_signal })
    );
    assert.ok(cur.exited_at >= t0);
    assert.match(String(cur.death_established_by), /exit-event/, 'named channel: ' + cur.death_established_by);
    assert.equal(P.pidAlive(row.pid), false);
  } finally { await teardown(m, sb); }
});
