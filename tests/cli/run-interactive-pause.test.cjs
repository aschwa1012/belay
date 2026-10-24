'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-interactive-pause.test.cjs — ADR 0037 wave 2: the run-start.json marker, and the interactive run pause
// (ADR 0023 amendment 5). `belay run --interactive` is driven in this process against the interactive stub
// (run-interactive-helpers.cjs). This process is also the run's worker adapter (its pid is the run row's
// adapter_pid, as run-pause.test.cjs arranges for a subprocess): a real RunManager with the headless fake
// claude as the workers, and a worker control listening on this pid, which run-pause.cjs's pauseWorker dials.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');

const H = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { createRunManager, createWorkerControl } = require('../../src/run/index.cjs');
const P = require('../../src/run/process.cjs');
const cmdStop = require('../../src/cli/cmd-stop.cjs');
const cmdPause = require('../../src/cli/cmd-pause.cjs');
const { start, withRun } = require('./run-interactive-helpers.cjs');
const { teardown: runSteps } = require('../helpers/teardown.cjs');

const { ROOT, sleep, waitUntil, currentRunRow, connectOrchestratorCore, releaseCore } = H;
const FAKE_WORKER = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;
const T = { timeout: 120000 };

const pauseCmd = (r, id = r.runId) => cmdPause.run({ command: 'pause', argv: [id], cwd: ROOT, dataDir: r.dataDir, json: true });
const resumeCmd = (r, id = r.runId) => cmdPause.run({ command: 'resume', argv: [id], cwd: ROOT, dataDir: r.dataDir, json: true });

// An interactive run that stays up until `quit()`, with this process as its worker adapter and `n` live workers.
async function liveRun(dir, workerIds, extraEnv = {}, specOverrides = {}) {
  const exitFile = `${dir}/quit.flag`;
  const r = start(dir, { env: { FAKE_EXIT_FILE: exitFile, ...extraEnv }, specOverrides: { close_grace_ms: 1500, ...specOverrides } });
  let rec = null; let core = null; let m = null; let control = null;
  const pids = [];
  // Every resource is registered as it is created, so a setup that fails part-way unwinds exactly what exists.
  const teardown = async (bodyError) => {
    fs.writeFileSync(exitFile, 'x');
    await r.done.catch(() => {}); // the run's own exit, which a test may already have caused: not a teardown step
    // Every step runs; the body's error wins, and a teardown failure on a passing body is thrown.
    await runSteps(bodyError, [
      () => control && control.close(),
      () => m && m.shutdown(),
      // ADR 0039: a bare pid is refused; the workers and the stub are this process's own descendants, so they
      // are ended through that lineage (one snapshot, leaves first), never by a pid alone.
      () => require('../crash.cjs').crashDescendants([...pids, rec && rec.pid].filter((p) => p && P.pidAlive(p))),
      () => core && releaseCore(core),
    ]);
  };
  try {
  rec = await waitUntil(() => r.record(), 15000);
  assert.ok(rec, 'the stub never started');
  core = await connectOrchestratorCore(r.dataDir, r.runId);
  m = createRunManager({ core, dataDir: r.dataDir, runId: r.runId, paths: { claudeExe: FAKE_WORKER, userSettings: USER_SETTINGS } });
  control = createWorkerControl({ redeem: null, dataDir: r.dataDir, manager: m, pid: process.pid });
  await control.listen();
  for (const id of workerIds) {
    const wt = `${dir}/${id}-wt`;
    fs.mkdirSync(wt, { recursive: true });
    const row = await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'hello', worker_id: id });
    pids.push(row.pid);
    assert.ok(await waitUntil(async () => { const w = await core.worker.get({ worker_id: id }); return w.state === 'running' ? w : null; }, 30000), `${id} never ran`);
  }
  const ctx = {
    r, rec, core, m, control, pids,
    quit: () => fs.writeFileSync(exitFile, 'x'),
    state: async (id) => (await core.worker.get({ worker_id: id })).state,
    teardown,
  };
  return ctx;
  } catch (e) { await teardown(e); throw e; }
}

// ------------------------------------------------------------------ the run-start.json marker

test('marker: run-start.json is written after the launcher\'s own attach with exactly run_id, epoch, mode, started_at, launcher_pid, session_id, session_file', T, async (t) => withRun(t, async (dir) => {
  const r = start(dir, { env: { FAKE_HOLD_MS: '1500' } });
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  const file = `${r.orchestratorDir}/run-start.json`;
  assert.ok(fs.existsSync(file), 'no run-start.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(m).sort(), ['epoch', 'launcher_pid', 'mode', 'run_id', 'session_file', 'session_id', 'started_at']);
  assert.strictEqual(m.run_id, r.runId);
  assert.strictEqual(m.mode, 'interactive');
  assert.strictEqual(m.launcher_pid, process.pid);
  assert.strictEqual(m.epoch, res.json.store.attach.epoch, 'epoch is the run row\'s epoch at that attach');
  assert.ok(Number.isInteger(m.started_at));
  const rec = r.record();
  const sid = rec.argv[rec.argv.indexOf('--session-id') + 1];
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.strictEqual(m.session_id, sid, 'the marker names the session the launch asked for');
  assert.ok(typeof m.session_file === 'string' && m.session_file.replaceAll('\\', '/').endsWith(`/${sid}.jsonl`), String(m.session_file));
  assert.strictEqual(res.json.orchestrator.interactive.run_start.written, true);
  const row = currentRunRow(r.dataDir, r.runId);
  assert.ok(m.started_at >= row.started_at - 1, 'started_at precedes the run row');
}));

// ------------------------------------------------------------------ the pause

test('pause: parks every live worker of a fake-claude interactive run, records the park set, and leaves the orchestrator alone', T, async (t) => withRun(t, async (dir) => {
  const c = await liveRun(dir, ['w1', 'w2']);
  let bodyError = null;
  try {
    const res = await pauseCmd(c.r);
    assert.strictEqual(res.code, 0, res.text);
    assert.strictEqual(res.json.paused, true);
    assert.strictEqual(res.json.already, false);
    assert.deepStrictEqual(res.json.workers.map((w) => w.worker_id).sort(), ['w1', 'w2']);
    assert.deepStrictEqual(res.json.not_paused, []);
    assert.strictEqual(res.json.interrupt, null, 'the orchestrator session was interrupted');
    assert.strictEqual(res.json.timeout, null);
    assert.strictEqual(await c.state('w1'), 'paused');
    assert.strictEqual(await c.state('w2'), 'paused');
    // the row records paused_at/paused_by and the park set
    const row = currentRunRow(c.r.dataDir, c.r.runId);
    assert.ok(Number.isInteger(row.paused_at) && row.paused_by, 'paused_at/paused_by not recorded');
    const parks = JSON.parse(row.pause_parks);
    assert.deepStrictEqual(parks.parked.map((p) => p.worker_id).sort(), ['w1', 'w2']);
    assert.deepStrictEqual(parks.already_parked, []);
    // the orchestrator child is neither interrupted nor killed: same pid, still alive, run still open
    assert.ok(P.pidAlive(c.rec.pid), 'the orchestrator child died with the pause');
    assert.strictEqual(row.ended_at, null);
    // a second pause is answered, not repeated
    const again = await pauseCmd(c.r);
    assert.strictEqual(again.json.already, true);
  } catch (e) { bodyError = e; throw e; } finally { await c.teardown(bodyError); }
}));

test('resume: relaunches exactly the parks the pause recorded, leaves a worker parked before the pause, and clears the row', T, async (t) => withRun(t, async (dir) => {
  const c = await liveRun(dir, ['w0', 'w1', 'w2']);
  let bodyError = null;
  try {
    const pre = await pauseCmd(c.r, 'w0'); // parked by hand, before the run pause
    assert.strictEqual(pre.json.paused, true, pre.text);
    const res = await pauseCmd(c.r);
    assert.deepStrictEqual(res.json.workers.map((w) => w.worker_id).sort(), ['w1', 'w2']);
    assert.deepStrictEqual(res.json.already_parked, ['w0']);

    const back = await resumeCmd(c.r);
    assert.strictEqual(back.json.resumed, true, back.text);
    assert.deepStrictEqual(back.json.workers_resumed.map((w) => w.worker_id).sort(), ['w1', 'w2']);
    assert.deepStrictEqual(back.json.left_parked.map((w) => [w.worker_id, !!w.already_parked]), [['w0', true]]);
    assert.strictEqual(back.json.timeout, null);
    assert.deepStrictEqual(back.json.held_wakes, []);
    assert.notStrictEqual(await c.state('w1'), 'paused');
    assert.notStrictEqual(await c.state('w2'), 'paused');
    assert.strictEqual(await c.state('w0'), 'paused', 'a worker the pause did not park was relaunched');
    const row = currentRunRow(c.r.dataDir, c.r.runId);
    assert.strictEqual(row.paused_at, null);
    assert.ok(P.pidAlive(c.rec.pid), 'the orchestrator child died across the pause and resume');
    const nope = await resumeCmd(c.r);
    assert.strictEqual(nope.json.resumed, false, 'a resume of a run that is not paused');
  } catch (e) { bodyError = e; throw e; } finally { await c.teardown(bodyError); }
}));

test('stop during a pause: belay stop ends the run and names the left-parked workers', T, async (t) => withRun(t, async (dir) => {
  const c = await liveRun(dir, ['w1', 'w2']);
  let bodyError = null;
  try {
    assert.strictEqual((await pauseCmd(c.r)).json.paused, true);
    const stopped = await cmdStop.run({ argv: [c.r.runId], cwd: ROOT, dataDir: c.r.dataDir, json: true });
    assert.strictEqual(stopped.code, 0, stopped.text);
    assert.deepStrictEqual([...stopped.json.left_parked].sort(), ['w1', 'w2']);
    assert.match(stopped.text, /left parked: w1, w2|left parked: w2, w1/);
    const res = await c.r.done;
    assert.ok(!P.pidAlive(c.rec.pid), 'claude outlived the stop');
    assert.match(res.json.ended_by, /^stopped by belay stop/);
    assert.deepStrictEqual([...res.json.workers_closed.left_parked].sort(), ['w1', 'w2']);
    assert.ok(currentRunRow(c.r.dataDir, c.r.runId).ended_at != null);
  } catch (e) { bodyError = e; throw e; } finally { await c.teardown(bodyError); }
}));

test('quit during a pause: the normal close runs and the receipt lists the parked workers', T, async (t) => withRun(t, async (dir) => {
  const c = await liveRun(dir, ['w1', 'w2']);
  let bodyError = null;
  try {
    assert.strictEqual((await pauseCmd(c.r)).json.paused, true);
    c.quit();
    const res = await c.r.done;
    assert.strictEqual(res.code, 0, res.text);
    assert.match(res.json.ended_by, /^claude exited \(code 0\)/);
    assert.deepStrictEqual([...res.json.workers_closed.left_parked].sort(), ['w1', 'w2']);
    assert.match(res.text, /left parked: w[12], w[12]/);
    assert.ok(currentRunRow(c.r.dataDir, c.r.runId).ended_at != null);
    assert.strictEqual(await c.state('w1'), 'paused', 'a parked worker is left parked, not rewritten');
  } catch (e) { bodyError = e; throw e; } finally { await c.teardown(bodyError); }
}));

test('pause on a session that is not a belay run is still refused', T, async (t) => withRun(t, async (dir) => {
  const dataDir = `${dir}/.belay`;
  fs.mkdirSync(dataDir, { recursive: true });
  const runId = 'run-not-belay';
  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: runId, pid: process.pid } });
  try {
    await core.run.attach({ adapter_pid: process.pid }); // this process is the owner, with no controls at all
    const res = await cmdPause.run({ command: 'pause', argv: [runId], cwd: ROOT, dataDir, json: true });
    assert.strictEqual(res.code, 1);
    assert.strictEqual(res.json.paused, false);
    assert.match(res.json.reason, /a run pause exists only for a headless run or an interactive run/);
    assert.strictEqual(res.json.error.code, 'E_NOT_FOUND');
  } finally {
    if (core.isOwner()) { try { await core.shutdownOwner(); } catch { /* best effort */ } }
    await core.close();
  }
  await sleep(0);
}));

// ------------------------------------------------------------------ the wake hold (ADR 0037 amendment 5 decision 6)

// A client of the run's wake pipe, found the way the mod finds it: the nonce in the copy's belay-run.json.
function wakeClient(r) {
  const { wakePipeName } = require('../../src/run/wake-pipe.cjs');
  const cfg = JSON.parse(fs.readFileSync(`${r.orchestratorDir}/plugin/belay-run.json`, 'utf8'));
  const lines = [];
  const sock = net.connect(wakePipeName(r.dataDir, r.runId, cfg.wake_nonce));
  let buf = '';
  sock.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { try { lines.push(JSON.parse(buf.slice(0, i))); } catch { /* torn */ } buf = buf.slice(i + 1); } });
  sock.on('error', () => {});
  return { wakes: () => lines.filter((l) => l.id), close: () => sock.destroy() };
}

test('wake hold: no wake is published while the run is paused; the held wakes are delivered, in order, after the resume', T, async (t) => withRun(t, async (dir) => {
  const c = await liveRun(dir, ['w1', 'w2'], {}, { poll_ms: 100 });
  let bodyError = null;
  const w = wakeClient(c.r);
  try {
    // let the workers' own start-up wakes settle before the pause
    let last = -1; let stable = 0;
    for (let i = 0; i < 100 && stable < 15; i++) { await sleep(100); const n = w.wakes().length; stable = n === last ? stable + 1 : 0; last = n; }
    const before = w.wakes().length;
    const res = await pauseCmd(c.r);
    assert.strictEqual(res.json.paused, true, res.text);
    await sleep(1500); // many polls: the two paused events are derived and must stay queued
    assert.strictEqual(w.wakes().length, before, `wakes were published during the pause: ${JSON.stringify(w.wakes().slice(before))}`);
    const back = await resumeCmd(c.r);
    assert.strictEqual(back.json.resumed, true, back.text);
    assert.ok(await waitUntil(() => w.wakes().length > before, 8000), 'the held wakes were never released');
    await sleep(400);
    const released = w.wakes().slice(before);
    // the first released wake is belay's own resume wake; the paused wakes of the relaunched workers are dropped
    assert.match(released[0].text, /^belay: run resumed by operator:\d+: relaunched w[12], w[12]; \d+ held events? follows?\.$/, released[0].text);
    assert.ok(Buffer.byteLength(released[0].text) <= 221, 'the resume wake is over the byte cap');
    assert.strictEqual(released.filter((x) => /was paused by/.test(x.text)).length, 0, `a paused wake survived the resume: ${JSON.stringify(released)}`);
    assert.strictEqual(Number(released[0].text.match(/(\d+) held event/)[1]), released.length - 1, 'the count names the events that follow');
    const seqs = released.slice(1).map((x) => Number(x.id.split(':').pop()));
    assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b), 'the held wakes were released out of order');
  } catch (e) { bodyError = e; throw e; } finally { w.close(); await c.teardown(bodyError); }
}));

test('pause: a stale paused_at on the row (from a crashed earlier epoch) does not make a pause answer already', T, async (t) => withRun(t, async (dir) => {
  const c = await liveRun(dir, ['w1']);
  let bodyError = null;
  try {
    await c.core.run.setPaused({ paused: true, at: Date.now() - 60000, by: 'operator:1 (stale)' });
    const res = await pauseCmd(c.r);
    assert.strictEqual(res.json.already, false, 'answered already: true from a stale row');
    assert.deepStrictEqual(res.json.workers.map((x) => x.worker_id), ['w1']);
    assert.strictEqual(await c.state('w1'), 'paused');
    const again = await pauseCmd(c.r);
    assert.strictEqual(again.json.already, true);
  } catch (e) { bodyError = e; throw e; } finally { await c.teardown(bodyError); }
}));

// ------------------------------------------------------------------ a marker belongs to one life of a run id

const plantStale = (dir, runId) => {
  fs.mkdirSync(`${dir}/orch`, { recursive: true });
  fs.writeFileSync(`${dir}/orch/run-start.json`, JSON.stringify({ run_id: runId, epoch: 1, mode: 'interactive', started_at: 1, launcher_pid: 1, session_id: 'STALE', session_file: `${dir}/stale.jsonl` }));
};

test('marker: an interactive re-run replaces an earlier life\'s marker after its attach', T, async (t) => withRun(t, async (dir) => {
  const runId = `stale-int-${process.pid}`;
  plantStale(dir, runId);
  const r = start(dir, { env: { FAKE_HOLD_MS: '1500' }, specOverrides: { run_id: runId } });
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  const m = JSON.parse(fs.readFileSync(`${r.orchestratorDir}/run-start.json`, 'utf8'));
  assert.notStrictEqual(m.session_id, 'STALE');
  assert.match(m.session_id, /^[0-9a-f-]{36}$/);
}));

test('marker: an interactive re-run whose marker write fails leaves no stale marker behind', T, async (t) => withRun(t, async (dir) => {
  const runId = `stale-int-fail-${process.pid}`;
  plantStale(dir, runId);
  const r = start(dir, { env: { FAKE_HOLD_MS: '1500' }, specOverrides: { run_id: runId }, deps: { writeRunStart: (d) => ({ path: `${d}/run-start.json`, written: false, error: 'injected write failure' }) } });
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  assert.strictEqual(res.json.orchestrator.interactive.run_start.written, false);
  assert.ok(!fs.existsSync(`${r.orchestratorDir}/run-start.json`), 'the earlier life\'s marker survived the launch');
}));
