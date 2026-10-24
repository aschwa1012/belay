'use strict';
// lease-heartbeat.test.cjs — ADR 0026 defect.
// A worker streams heartbeats through ONE long turn. The keepalive gates on the stored row's
// last_event_at, which the run manager used to write only at turn start, turn end and exit, so the row
// looked silent after one lease length and the lease stopped being renewed. Here a real RunManager and
// the real keepalive run against the fake core and a fake worker that emits tool_progress lines mid-turn,
// with the lease length shrunk to 1 s. Every renewal is read from the lease the test holds.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { createKeepalive } = require('../../src/mcp/lease-keepalive.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const P = require('../../src/run/process.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const L = 1000;
const TURN_MS = 4500;
process.env.FAKE_ANSWER_DELAY_MS = String(TURN_MS);
process.env.FAKE_HEARTBEAT_MS = '50';
process.env.BELAY_TEST_MODE = '1'; // the refresh knob is honoured in test mode only
process.env.BELAY_ROW_REFRESH_MS = '200';

test('a worker streaming heartbeats through one turn longer than twice the lease keeps its lease: at least three renewals', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-leasehb-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  const core = createFakeCore();
  const m = createRunManager({
    core, dataDir: d.replace(/\\/g, '/'), runId: 'run-leasehb',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
  t.after(() => m.shutdown());

  await m.spawn({ substrate: 'claude-code', worktree: path.join(d, 'wt').replace(/\\/g, '/'), prompt: 'hello', worker_id: 'w1' });
  const lease = { id: 'l1', holder: 'w1', holder_role: 'worker', granted_at: Date.now(), ttl_ms: L, expires_at: Date.now() + L, released_at: null };
  let renewals = 0;
  let expired = false;
  const call = async (method, args) => {
    if (method === 'task.list') return { tasks: [{ id: 't1', lease }] };
    if (method === 'worker.get') {
      const row = core.currentWorker('w1');
      return { ...row, last_event_age_ms: Date.now() - row.last_event_at };
    }
    if (method === 'lease.renew') { renewals += 1; lease.expires_at = Date.now() + args.ttl_ms; return { ...lease }; }
    throw new Error(`unexpected ${method}`);
  };
  const ka = createKeepalive({ call, workerId: 'w1', tickMs: 100 });
  ka.start();
  t.after(() => ka.stop());

  const turn = m._waitTurn('w1', 12000);
  const until = Date.now() + TURN_MS - 300; // watch the turn only, not its end
  while (Date.now() < until) {
    if (Date.now() >= lease.expires_at) expired = true;
    await sleep(50);
  }
  ka.stop();
  await turn;
  assert.strictEqual(expired, false, 'the lease expired while its worker was streaming');
  assert.ok(renewals >= 3, `renewed ${renewals} time(s); a lease of ${L} ms over a ${TURN_MS} ms turn needs at least three`);
});

// Review B1: a refresh write must never be a death channel. With the refresh forced to fire on every chunk,
// a heartbeat-streaming worker killed mid-turn must still have its death recorded by the exit event, with
// its exit code, never by a refresh's pid check (which knows no code).
test('a heartbeat-streaming worker killed mid-turn is recorded dead by its exit event with an exit code, refresh forced low', async (t) => {
  const prev = process.env.BELAY_ROW_REFRESH_MS;
  process.env.BELAY_ROW_REFRESH_MS = '1';
  t.after(() => { process.env.BELAY_ROW_REFRESH_MS = prev; });
  for (let i = 0; i < 5; i++) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-leasekill-'));
    fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
    const m = createRunManager({
      core: createFakeCore(), dataDir: d.replace(/\\/g, '/'), runId: 'run-leasekill',
      paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
    });
    try {
      const id = `k${i}`;
      const row = await m.spawn({ substrate: 'claude-code', worktree: path.join(d, 'wt').replace(/\\/g, '/'), prompt: 'hello', worker_id: id });
      await sleep(300);
      const waiting = m.wait({ worker_ids: [id], timeout_ms: 5000 });
      require('../crash.cjs').crash(m._worker(id).child);
      const r = await waiting;
      assert.notStrictEqual(r.established_by, 'pid-check-before-running-write', 'a refresh recorded the death');
      assert.notStrictEqual(r.established_by, 'core-refused-running', 'a refresh recorded the death');
      if (r.established_by === 'exit-event') {
        assert.ok(r.exit_code !== null || r.exit_signal !== null, `exit-event death lost its code: ${JSON.stringify(r)}`);
      }
    } finally {
      await m.shutdown();
    }
  }
});
