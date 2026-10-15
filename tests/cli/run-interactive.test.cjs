'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-interactive.test.cjs — ADR 0037 decisions 1, 3, 5 to 7 and 9, and amendment 1 item 1. The interactive
// mode is driven in this process (a console event can only be `process.emit`ted here, decision 10) against
// tests/run/fakes/fake-claude-interactive.cjs, selected through BELAY_CLAUDE_EXE. The two modules written
// beside this build (launch.cjs's orchestratorInteractiveArgv and interactive-surface.cjs) are injected
// through ctx.interactiveDeps, so this suite runs before they are merged. CLAUDE_CONFIG_DIR is always a
// sandbox: the real ~/.claude is never touched. Every assertion reads a derived fact: a pid check, a store
// row read from a copy, an exit code, a file the stub wrote.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const H = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const P = require('../../src/run/process.cjs');
const ID = require('../../src/core/proc-identity.cjs');
const cmdRun = require('../../src/cli/cmd-run.cjs');
const cmdStop = require('../../src/cli/cmd-stop.cjs');
const cmdPause = require('../../src/cli/cmd-pause.cjs');
const { closeRunWorkers } = require('../../src/cli/run-close.cjs');

const { ROOT, fwd, sleep, sandbox, cleanup, waitUntil, currentRunRow, releaseCore } = H;
const H2 = require('./run-interactive-helpers.cjs');
const { FAKE, MARKER, makeSpec, fakeGate, start, sleeper, withRun } = H2;


// ---------------------------------------------------------------- mode selection

test('mode: bad mode and bad interactive_surface_ms are usage errors that create nothing', async (t) => withRun(t, async (dir) => {
  for (const [over, re] of [[{ mode: 'both' }, /mode must be one of headless, interactive/], [{ interactive_surface_ms: 0 }, /interactive_surface_ms must be a positive integer/]]) {
    const r = start(dir, { specOverrides: over });
    const res = await r.done;
    assert.strictEqual(res.code, 2);
    assert.match(res.text, re);
    assert.ok(!fs.existsSync(r.dataDir), 'a usage error created the data dir');
  }
}));

test('mode: interactive refuses mcp_tool_timeout_ms above 120000 and a prompt without the marker, headless needs neither', async (t) => withRun(t, async (dir) => {
  let r = start(dir, { specOverrides: { mcp_tool_timeout_ms: 120001 } });
  let res = await r.done;
  assert.strictEqual(res.code, 2);
  assert.match(res.text, /mcp_tool_timeout_ms of at most 120000/);
  assert.ok(!fs.existsSync(r.dataDir));

  r = start(dir, { prompt: 'a headless prompt with no marker\n' });
  res = await r.done;
  assert.strictEqual(res.code, 2);
  assert.match(res.text, /lacks the line <!-- belay-mode: interactive -->/);
  assert.match(res.text, /src\/run\/prompts\/orchestrator-interactive\.md/);
  assert.ok(!fs.existsSync(r.dataDir));

  // The flag alone selects the mode over a headless spec key, and is refused the same way.
  r = start(dir, { specOverrides: { mode: 'headless' }, argv: ['--interactive'], prompt: 'no marker\n' });
  res = await r.done;
  assert.strictEqual(res.code, 2, '--interactive did not select the interactive refusal over mode: headless');

  // A headless spec with the same bad values is not refused by the interactive rules.
  r = start(dir, { specOverrides: { mode: 'headless', mcp_tool_timeout_ms: 300000 }, prompt: 'no marker\n', env: { BELAY_CLAUDE_EXE: `${ROOT}/tests/run/fakes/fake-claude-noready.cjs`, FAKE_HOLD_MS: '0' } });
  res = await r.done;
  assert.notStrictEqual(res.code, 2, `headless was refused as a usage error: ${res.text}`);
  assert.strictEqual(res.json.mode, 'headless');
}));

test('mode: the usage text names --interactive', async () => {
  const res = await cmdRun.run({ argv: [], cwd: ROOT, dataDir: `${os.tmpdir()}/never-created-belay-int`, json: true });
  assert.strictEqual(res.code, 2);
  assert.match(res.text, /\[--interactive\]/);
});

// ---------------------------------------------------------------- the run, exit codes, the close

test('interactive run, claude exits 0: launch facts, receipt, run row closed, belay exits 0', async (t) => withRun(t, async (dir) => {
  const captured = [];
  const gate = fakeGate();
  const r = start(dir, { captured, gate, specOverrides: { model: 'claude-sonnet-5-5', mcp_tool_timeout_ms: 90000 }, argv: ['--effort', 'high'] });
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  const rc = res.json;
  assert.strictEqual(rc.mode, 'interactive');
  assert.match(res.text, /mode: interactive/);
  assert.match(rc.ended_by, /^claude exited \(code 0\)$/);
  assert.strictEqual(rc.orchestrator.exit_code, 0);
  assert.strictEqual(rc.orchestrator.interactive.tools.verified, 'unverified');
  assert.deepStrictEqual(rc.orchestrator.interactive.tools.requested, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']);
  assert.deepStrictEqual(rc.orchestrator.interactive.console_events, []);
  assert.strictEqual(rc.orchestrator.interactive.gate.debug.ok, true);
  assert.strictEqual(rc.orchestrator.interactive.gate.session.ok, true);
  assert.strictEqual(rc.orchestrator.permission_mode_effective, 'auto');
  assert.strictEqual(rc.orchestrator.claude_code_version, '2.1.293');
  assert.strictEqual(rc.orchestrator.interactive.actual.effort, 'high');

  // What was launched: the stub's own record, not the launcher's account of it.
  const rec = r.record();
  assert.strictEqual(rec.pid, rc.orchestrator.pid);
  assert.ok(!rec.argv.includes('-p') && !rec.argv.includes('--output-format'), 'headless flags reached an interactive launch');
  assert.strictEqual(rec.argv[rec.argv.indexOf('--session-id') + 1], rc.orchestrator.session_id);
  assert.match(rc.orchestrator.session_id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(rec.argv[rec.argv.indexOf('--debug-file') + 1], rc.orchestrator.interactive.debug_file);
  assert.strictEqual(rec.argv[rec.argv.indexOf('--effort') + 1], 'high');
  assert.strictEqual(rec.env.MCP_TOOL_TIMEOUT, '90000');
  assert.strictEqual(captured.length, 1);
  assert.strictEqual(captured[0].permissionMode, 'auto');
  assert.strictEqual(captured[0].model, 'claude-sonnet-5-5');
  assert.strictEqual(gate.seen[0].surfaceMs, 15000);
  assert.strictEqual(gate.seen[0].requested.effort, 'high');
  assert.strictEqual(gate.seen[0].debugFile, rc.orchestrator.interactive.debug_file);
  // The new gate contract's options (G3, G5): the projects dir and the session id locate the file; spawnedAt dates the debug log.
  assert.strictEqual(gate.seen[0].projectsDir, `${fwd(r.cfg)}/projects`);
  assert.strictEqual(gate.seen[0].sessionId, rc.orchestrator.session_id);
  assert.strictEqual(fwd(gate.seen[0].cwd).toLowerCase(), r.wt.toLowerCase());
  assert.ok(Number.isFinite(gate.seen[0].spawnedAt) && gate.seen[0].spawnedAt > 0 && gate.seen[0].assistantMs === undefined);
  assert.ok(fwd(rec.cwd).toLowerCase() === r.wt.toLowerCase());

  // ONE system prompt file: the spawn-time CLAUDE.md copy, then the run's prompt, and no positional prompt.
  const sys = fs.readFileSync(captured[0].appendSystemPromptFile, 'utf8');
  assert.ok(sys.indexOf('WORKTREE-INSTRUCTIONS-SENTINEL') >= 0 && sys.indexOf('the interactive prompt') > sys.indexOf('WORKTREE-INSTRUCTIONS-SENTINEL'));
  assert.strictEqual(rec.argv[rec.argv.length - 1], rc.orchestrator.interactive.debug_file, `a positional prompt reached the argv: ${JSON.stringify(rec.argv)}`);

  // The run row: closed, with the cause the receipt names.
  const row = currentRunRow(r.dataDir, r.runId);
  assert.ok(row.ended_at != null, 'run.end never landed');
  assert.strictEqual(row.exit_reason, rc.ended_by);
  assert.ok(!fs.existsSync(`${r.dataDir}/owner.lock`), 'the owner was left running');
  assert.strictEqual(JSON.parse(fs.readFileSync(`${r.orchestratorDir}/run.json`, 'utf8')).mode, 'interactive');
}));

test('interactive run, claude exits non-zero: belay exits 1 and ended_by names the code', async (t) => withRun(t, async (dir) => {
  const r = start(dir, { env: { FAKE_EXIT_CODE: '3' } });
  const res = await r.done;
  assert.strictEqual(res.code, 1);
  assert.match(res.json.ended_by, /^claude exited \(code 3\)$/);
  assert.strictEqual(res.json.orchestrator.exit_code, 3);
  assert.ok(currentRunRow(r.dataDir, r.runId).ended_at != null);
}));

test('interactive run, claude exits before its session file exists: ended_by says so, with the code', async (t) => withRun(t, async (dir) => {
  const gate = fakeGate({ firstMs: null, sessionMs: null }); // no first message, no session file
  const r = start(dir, { env: { FAKE_NO_SESSION: '1', FAKE_EXIT_CODE: '1', FAKE_HOLD_MS: '200' }, gate });
  const res = await r.done;
  assert.strictEqual(res.code, 1);
  assert.match(res.json.ended_by, /^claude exited before the session started \(code 1\)$/);
  assert.strictEqual(res.json.orchestrator.interactive.session_file_present, false);
}));

test('interactive run: a life-claiming worker is killed by its exact pid before run.end, and its row closed', async (t) => withRun(t, async (dir) => {
  const r = start(dir, { env: { FAKE_HOLD_MS: '2500' } });
  const w = sleeper();
  let core;
  try {
    assert.ok(await waitUntil(() => r.record(), 15000), 'the stub never started');
    core = await openCore({ dataDir: r.dataDir, caller: { role: 'orchestrator', run_id: r.runId, pid: process.pid } });
    assert.ok(await waitUntil(async () => (await core.run.get()).run, 15000), 'no run row');
    await core.worker.write({ id: 'w-int', run_id: r.runId, substrate: 'claude-code', pid: w.pid, pid_image: 'node.exe', state: 'running', turns: 0, started_at: Date.now() });
    const res = await r.done;
    assert.strictEqual(res.code, 0, res.text);
    const killed = res.json.workers_closed.killed.find((k) => k.worker_id === 'w-int');
    assert.ok(killed && killed.pid === w.pid && killed.gone === true, JSON.stringify(res.json.workers_closed));
    assert.ok(!P.pidAlive(w.pid), 'the worker pid is still alive');
    assert.match(res.text, /workers closed: 1 killed/);
  } finally { require('../crash.cjs').crash(w); await releaseCore(core); }
}));

// ---------------------------------------------------------------- console events

test('SIGINT and SIGBREAK are recorded, never acted on: the launcher stays, and the close runs at the stub\'s exit', async (t) => withRun(t, async (dir) => {
  const before = { SIGINT: process.listenerCount('SIGINT'), SIGBREAK: process.listenerCount('SIGBREAK'), SIGHUP: process.listenerCount('SIGHUP') };
  const r = start(dir, { env: { FAKE_HOLD_MS: '1800' } });
  const rec = await waitUntil(() => r.record(), 15000);
  assert.ok(rec, 'the stub never started');
  assert.ok(await waitUntil(() => process.listenerCount('SIGINT') > before.SIGINT, 5000), 'no SIGINT handler was installed');
  process.emit('SIGINT');
  process.emit('SIGBREAK');
  await sleep(300);
  assert.ok(P.pidAlive(rec.pid), 'a console event stopped claude');
  const res = await r.done;
  assert.strictEqual(res.code, 0, res.text);
  assert.match(res.json.ended_by, /^claude exited \(code 0\)$/);
  const ev = res.json.orchestrator.interactive.console_events;
  assert.deepStrictEqual(ev.map((e) => e.signal), ['SIGINT', 'SIGBREAK']);
  assert.ok(ev.every((e) => typeof e.at === 'string' && Number.isFinite(e.at_ms)));
  assert.ok(currentRunRow(r.dataDir, r.runId).ended_at != null);
  assert.deepStrictEqual({ SIGINT: process.listenerCount('SIGINT'), SIGBREAK: process.listenerCount('SIGBREAK'), SIGHUP: process.listenerCount('SIGHUP') }, before, 'the handlers were not removed');
}));

test('SIGHUP: the fast close kills workers by pid, closes the row, and ends with the console-closed cause', async (t) => withRun(t, async (dir) => {
  const w = sleeper();
  let core;
  let r = null;
  // ADR 0048 decision 8 (b): the 3500 ms fast close is a product budget that includes its snapshot, so this test supplies
  // the SIGHUP's snapshot (a real one, taken now) through the same seam the fast-close test uses, and never depends on
  // how long CIM takes. The no-fit path has its own test (run-interactive-nofit.test.cjs).
  const realShared = P.snapshotShared;
  try {
    const pre = await ID.processSnapshot(); // before the run starts, so its time is nobody's bound
    assert.ok(pre && pre.get(w.pid), 'precondition: the snapshot could not read the sleeper');
    r = start(dir, { env: { FAKE_HOLD_MS: '800' } });
    assert.ok(await waitUntil(() => r.record(), 15000));
    core = await openCore({ dataDir: r.dataDir, caller: { role: 'orchestrator', run_id: r.runId, pid: process.pid } });
    assert.ok(await waitUntil(async () => (await core.run.get()).run, 15000));
    P.snapshotShared = () => Promise.resolve(pre);
    await core.worker.write({ id: 'w-hup', run_id: r.runId, substrate: 'claude-code', pid: w.pid, pid_image: 'node.exe', state: 'running', turns: 0, started_at: Date.now() });
    process.emit('SIGHUP');
    const res = await r.done;
    assert.strictEqual(res.code, 1, 'a fast close is never a clean exit');
    assert.strictEqual(res.json.ended_by, 'console closed (fast close)');
    assert.deepStrictEqual(res.json.orchestrator.interactive.console_events.map((e) => e.signal), ['SIGHUP']);
    assert.ok(!P.pidAlive(w.pid), 'the worker survived the fast close');
    assert.ok(res.json.workers_closed.killed.some((k) => k.pid === w.pid && k.gone));
    const row = currentRunRow(r.dataDir, r.runId);
    assert.ok(row.ended_at != null && row.exit_reason === 'console closed (fast close)');
    assert.ok(!fs.existsSync(`${r.dataDir}/owner.lock`));
  } finally { P.snapshotShared = realShared; require('../crash.cjs').crash(w); await releaseCore(core); }
}));

test('closeRunWorkers: with `fast`, the adapter wait is skipped, or cut short when the request arrives during it', async () => {
  const adapter = sleeper();
  const core = { run: { get: async () => ({ run: { adapter_pid: adapter.pid } }) }, worker: { list: async () => ({ workers: [] }) } };
  try {
    let t = Date.now();
    let out = await closeRunWorkers({ core, runId: 'r', graceMs: 20000, ownPid: -1, fast: { requested: () => true } });
    // The adapter wait it skips is graceMs (20 s); 10 s separates a skipped wait from a held one on a loaded host.
    assert.ok(Date.now() - t < 10000 && out.fast_close === true && out.adapter_wait_ms === 0, JSON.stringify(out));
    let flip = false;
    setTimeout(() => { flip = true; }, 400);
    t = Date.now();
    out = await closeRunWorkers({ core, runId: 'r', graceMs: 20000, ownPid: -1, fast: { requested: () => flip } });
    const ms = Date.now() - t;
    assert.ok(ms >= 300 && ms < 10000 && out.fast_close === true && out.adapter_gone === false, `${ms} ${JSON.stringify(out)}`);
    assert.ok(P.pidAlive(adapter.pid), 'the close touched the adapter');
  } finally { require('../crash.cjs').crash(adapter); }
});

// ---------------------------------------------------------------- the gate

test('a failing gate: claude is killed by its pid, the close runs, and ended_by names the check', async (t) => withRun(t, async (dir) => {
  const gate = fakeGate({ debug: { ok: false, failed: 'skills', detail: '2 skills loaded' }, debugMs: 400, debugWhen: () => fs.existsSync(`${dir}/stub-record.json`) });
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1' }, gate });
  const res = await r.done;
  const rec = r.record();
  assert.ok(!P.pidAlive(rec.pid), 'claude outlived a failed gate');
  assert.strictEqual(res.code, 1);
  assert.match(res.json.ended_by, /^surface gate failed \(debug\): skills: 2 skills loaded$/);
  assert.strictEqual(res.json.orchestrator.interactive.gate.debug.ok, false);
  const row = currentRunRow(r.dataDir, r.runId);
  assert.ok(row.ended_at != null && /surface gate failed/.test(row.exit_reason));
}));

// A fake terminal that records every write with whether claude's pid was still alive when it arrived: the
// reset must come after the child's exit, once, never before it or interleaved with it (probe ide-leak).
function fakeTerm(getPid) {
  const writes = [];
  return { writes, out: { isTTY: true, write: (s) => { writes.push({ s, claudeAlive: getPid() != null && P.pidAlive(getPid()) }); return true; } } };
}
const resetOnce = (term, { altScreen = true } = {}) => { // fullscreen is the default, so the alternate screen is left too
  const { RESET_SEQUENCE, ALT_SCREEN_OFF } = require('../../src/run/term-restore.cjs');
  assert.deepStrictEqual(term.writes.map((w) => w.s), [altScreen ? ALT_SCREEN_OFF + RESET_SEQUENCE : RESET_SEQUENCE], 'exactly one write, the reset sequence');
  assert.strictEqual(term.writes[0].claudeAlive, false, 'the reset was written while claude was still alive');
};

test('a claude killed by a failed gate gets the terminal reset written once, after its exit (probe ide-leak)', async (t) => withRun(t, async (dir) => {
  let pid = null;
  const term = fakeTerm(() => pid);
  const gate = fakeGate({ debug: { ok: false, failed: 'mcp_servers', detail: 'connected: belay, ide; expected exactly belay' }, debugMs: 400, debugWhen: () => fs.existsSync(`${dir}/stub-record.json`) });
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1' }, gate, deps: { termOut: term.out } });
  pid = (await waitUntil(() => r.record(), 15000)).pid;
  const res = await r.done;
  assert.strictEqual(res.code, 1);
  resetOnce(term);
}));

test('fullscreen false: a killed claude gets the reset without the alternate-screen exit', async (t) => withRun(t, async (dir) => {
  const saved = process.env.CLAUDE_CODE_NO_FLICKER;
  delete process.env.CLAUDE_CODE_NO_FLICKER;
  try {
    let pid = null;
    const term = fakeTerm(() => pid);
    const gate = fakeGate({ debug: { ok: false, failed: 'skills', detail: 'x' }, debugMs: 400, debugWhen: () => fs.existsSync(`${dir}/stub-record.json`) });
    const r = start(dir, { env: { FAKE_NEVER_EXIT: '1' }, gate, deps: { termOut: term.out }, specOverrides: { fullscreen: false } });
    pid = (await waitUntil(() => r.record(), 15000)).pid;
    await r.done;
    resetOnce(term, { altScreen: false });
  } finally { if (saved === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER; else process.env.CLAUDE_CODE_NO_FLICKER = saved; }
}));

test('belay stop: the killed claude gets the terminal reset written once, after its exit (probe ide-leak)', async (t) => withRun(t, async (dir) => {
  let pid = null;
  const term = fakeTerm(() => pid);
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1' }, deps: { termOut: term.out }, specOverrides: { close_grace_ms: 1500 } });
  const rec = await waitUntil(() => r.record(), 15000);
  assert.ok(rec, 'the stub never started');
  pid = rec.pid;
  let core;
  try {
    core = await openCore({ dataDir: r.dataDir, caller: { role: 'orchestrator', run_id: r.runId, pid: process.pid } });
    assert.ok(await waitUntil(async () => (await core.run.get()).run, 15000));
    const stopped = await cmdStop.run({ argv: [r.runId], cwd: ROOT, dataDir: r.dataDir, json: true });
    assert.strictEqual(stopped.code, 0, stopped.text);
    await r.done;
    resetOnce(term);
  } finally { P.killPid(rec.pid, 'SIGKILL'); await releaseCore(core); await r.done.catch(() => {}); }
}));

test('SIGHUP fast close: a claude that does not follow is killed and gets the terminal reset written once, after its exit (probe ide-leak)', async (t) => withRun(t, async (dir) => {
  let pid = null;
  const term = fakeTerm(() => pid);
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1' }, deps: { termOut: term.out } });
  const rec = await waitUntil(() => r.record(), 15000);
  assert.ok(rec, 'the stub never started');
  pid = rec.pid;
  try {
    process.emit('SIGHUP');
    const res = await r.done;
    assert.strictEqual(res.code, 1);
    assert.ok(!P.pidAlive(rec.pid));
    resetOnce(term);
  } finally { P.killPid(rec.pid, 'SIGKILL'); await r.done.catch(() => {}); }
}));

// One test per case: each run ends after the creation-time reads its receipt waits for, so five runs in one test count five
// snapshots against the one test's 60 s timeout (ADR 0048 decision 8, c).
for (const [over, env, want] of [[{}, {}, '1'], [{ fullscreen: true }, {}, '1'], [{ fullscreen: false }, {}, '0'], [{ fullscreen: true }, { CLAUDE_CODE_NO_FLICKER: '0' }, '0'], [{ fullscreen: false }, { CLAUDE_CODE_NO_FLICKER: '1' }, '1']]) {
  test(`fullscreen: the orchestrator env carries CLAUDE_CODE_NO_FLICKER=${want} for ${JSON.stringify([over, env])} (1 by default, 0 when the spec says false, an explicit belay env wins)`, async (t) => {
    const saved = process.env.CLAUDE_CODE_NO_FLICKER;
    delete process.env.CLAUDE_CODE_NO_FLICKER;
    try {
      await withRun(t, async (dir) => {
        const r = start(dir, { env, specOverrides: over });
        const res = await r.done;
        assert.strictEqual(res.code, 0);
        assert.strictEqual(r.record().env.CLAUDE_CODE_NO_FLICKER, want, JSON.stringify([over, env]));
      });
    } finally { if (saved === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER; else process.env.CLAUDE_CODE_NO_FLICKER = saved; }
  });
}

test('fullscreen: a non-boolean is a usage error, and the key is refused on a headless run, both before anything is created', async (t) => withRun(t, async (dir) => {
  for (const [over, argv, re] of [[{ fullscreen: 'yes' }, [], /fullscreen must be true or false/], [{ fullscreen: 1 }, [], /fullscreen must be true or false/], [{ mode: 'headless', fullscreen: true }, [], /fullscreen is an interactive key/]]) {
    const r = start(dir, { specOverrides: over, argv });
    const res = await r.done;
    assert.strictEqual(res.code, 2, JSON.stringify(over));
    assert.match(res.text, re);
    assert.ok(!fs.existsSync(r.dataDir), 'the data dir was created');
  }
}));

test('a claude that exits on its own gets no terminal reset from belay (probe ide-leak)', async (t) => withRun(t, async (dir) => {
  const writes = [];
  const r = start(dir, { deps: { termOut: { isTTY: true, write: (s) => { writes.push(s); return true; } } } });
  const res = await r.done;
  assert.strictEqual(res.code, 0);
  assert.deepStrictEqual(writes, []);
}));

// ---------------------------------------------------------------- belay stop and belay pause

test('belay stop against an interactive run ends claude by its pid, runs the close, and the receipt names the stop', async (t) => withRun(t, async (dir) => {
  const r = start(dir, { env: { FAKE_NEVER_EXIT: '1', FAKE_ORPHAN: '1' }, specOverrides: { close_grace_ms: 1500 } });
  const rec = await waitUntil(() => { const x = r.record(); return x && x.grandchild_pid ? x : null; }, 15000);
  assert.ok(rec, 'the stub never started');
  let core;
  try {
    core = await openCore({ dataDir: r.dataDir, caller: { role: 'orchestrator', run_id: r.runId, pid: process.pid } });
    assert.ok(await waitUntil(async () => (await core.run.get()).run, 15000));
    const w = sleeper();
    try {
      await core.worker.write({ id: 'w-stop', run_id: r.runId, substrate: 'claude-code', pid: w.pid, pid_image: 'node.exe', state: 'running', turns: 0, started_at: Date.now() });
      const stopped = await cmdStop.run({ argv: [r.runId], cwd: ROOT, dataDir: r.dataDir, json: true });
      assert.strictEqual(stopped.code, 0, stopped.text);
      assert.strictEqual(stopped.json.stopped, true);
      assert.strictEqual(stopped.json.orchestrator.pid, rec.pid);
      const res = await r.done;
      assert.ok(!P.pidAlive(rec.pid), 'claude is still alive after belay stop');
      // (whether claude's descendant survives is the host's job-object behaviour, not belay's: L4 asserts the kill calls instead)
      assert.ok(!P.pidAlive(w.pid), "the run's worker outlived the stop");
      assert.strictEqual(res.json.stop.caller_pid, process.pid);
      assert.match(res.json.ended_by, /^stopped by belay stop \(caller pid \d+\); claude ended by its pid$/);
      assert.match(res.text, /stopped by: pid /);
      const row = currentRunRow(r.dataDir, r.runId);
      assert.ok(row.ended_at != null && row.exit_reason === res.json.ended_by);
      assert.ok(!fs.existsSync(`${r.dataDir}/owner.lock`));
    } finally { require('../crash.cjs').crash(w); }
  } finally { await releaseCore(core); await r.done.catch(() => {}); }
}));

test('belay pause against an interactive run is accepted (ADR 0023 amendment 5): no workers, the session undisturbed', async (t) => withRun(t, async (dir) => {
  const r = start(dir, { env: { FAKE_HOLD_MS: '2500' } });
  assert.ok(await waitUntil(() => r.record(), 15000));
  const probe = await openCore({ dataDir: r.dataDir, caller: { role: 'operator', run_id: r.runId, pid: process.pid } });
  assert.ok(await waitUntil(async () => (await probe.run.get()).run, 15000));
  await probe.close();
  const res = await cmdPause.run({ command: 'pause', argv: [r.runId], cwd: ROOT, dataDir: r.dataDir, json: true });
  assert.strictEqual(res.code, 0, res.text);
  assert.strictEqual(res.json.paused, true);
  assert.deepStrictEqual(res.json.workers, []);
  assert.strictEqual(res.json.interrupt, null);
  const done = await r.done;
  assert.strictEqual(done.code, 0, 'the pause disturbed the run');
}));

// ---------------------------------------------------------------- the real gate and argv, when merged

// The gate must be the new contract (firstMessage, current(), projectsDir): the old one never settles against this stub's debug log, so a strict exit (L2) cannot pass.
const hasReal = fs.existsSync(`${ROOT}/src/run/interactive-surface.cjs`) && fs.readFileSync(`${ROOT}/src/run/interactive-surface.cjs`, 'utf8').includes('firstMessage') && typeof require('../../src/run/launch.cjs').orchestratorInteractiveArgv === 'function';

test('with the real argv builder and gate (skipped until they are merged): a clean surface passes, a leaking one is killed', { skip: !hasReal && 'interactive-surface.cjs / orchestratorInteractiveArgv not merged on this branch' }, async (t) => withRun(t, async (dir) => {
  const cfg = `${dir}/claude-config`;
  const real = (env) => {
    const { specPath, runId } = makeSpec(dir);
    const saved = { ...process.env };
    Object.assign(process.env, { BELAY_CLAUDE_EXE: FAKE, CLAUDE_CONFIG_DIR: cfg, FAKE_RECORD_FILE: `${dir}/rec.json`, FAKE_HOLD_MS: '1500', ...env });
    return cmdRun.run({ argv: [specPath], cwd: ROOT, dataDir: `${dir}/.belay`, json: true }).finally(() => { process.env = saved; }).then((x) => ({ x, runId }));
  };
  const ok = await real({});
  assert.strictEqual(ok.x.code, 0, ok.x.text);
  fs.rmSync(`${dir}/.belay`, { recursive: true, force: true });
  const leak = await real({ FAKE_LEAK: '1', FAKE_NEVER_EXIT: '1' });
  assert.strictEqual(leak.x.code, 1);
  assert.match(leak.x.json.ended_by, /surface gate failed/);
}));

// ---------------------------------------------------------------- finalize: claude exited, so both files are final

// The real gate, argv builder and fake claude. `env` steers the fake; the run is driven in this process.
async function realRun(dir, env) {
  const { specPath } = makeSpec(dir);
  const saved = { ...process.env };
  Object.assign(process.env, { BELAY_CLAUDE_EXE: FAKE, CLAUDE_CONFIG_DIR: `${dir}/claude-config`, FAKE_RECORD_FILE: `${dir}/rec.json`, FAKE_HOLD_MS: '2000', ...env });
  try { return await cmdRun.run({ argv: [specPath], cwd: ROOT, dataDir: `${dir}/.belay`, json: true }); } finally { process.env = saved; }
}
const skipReal = !hasReal && 'interactive-surface.cjs / orchestratorInteractiveArgv not merged on this branch';

test('finalize: claude exits 2 s after a clean first message, well inside surface_ms: the gate decides at the exit and belay exits 0', { skip: skipReal }, async (t) => withRun(t, async (dir) => {
  const res = await realRun(dir, {});
  assert.strictEqual(res.code, 0, res.text);
  assert.match(res.json.ended_by, /^claude exited \(code 0\)$/);
  const g = res.json.orchestrator.interactive.gate;
  assert.strictEqual(g.status, 'passed');
  assert.strictEqual(g.debug.ok, true);
  assert.strictEqual(g.session.ok, true);
}));

test('finalize: a leak line that lands as claude exits fails the run and the receipt names the check', { skip: skipReal }, async (t) => withRun(t, async (dir) => {
  const res = await realRun(dir, { FAKE_LATE_LEAK: '1' });
  assert.strictEqual(res.code, 1, res.text);
  assert.match(res.json.ended_by, /^surface gate failed \(debug\): skills/);
  assert.strictEqual(res.json.orchestrator.interactive.gate.debug.ok, false);
  assert.strictEqual(res.json.orchestrator.interactive.gate.status, 'failed');
}));

test('finalize: an exit after a first message but before any assistant reply fails no_assistant_reply_before_exit, exit 1', { skip: skipReal }, async (t) => withRun(t, async (dir) => {
  const res = await realRun(dir, { FAKE_NO_ASSISTANT: '1' });
  assert.strictEqual(res.code, 1, res.text);
  assert.match(res.json.ended_by, /^surface gate failed \(session\): no_assistant_reply_before_exit/);
  assert.strictEqual(res.json.orchestrator.interactive.gate.session.failed, 'no_assistant_reply_before_exit');
}));

test('finalize: a quit before the first message is exit 0 with the existing wording, both halves not reached', { skip: skipReal }, async (t) => withRun(t, async (dir) => {
  const res = await realRun(dir, { FAKE_NO_FIRST: '1' });
  assert.strictEqual(res.code, 0, res.text);
  assert.strictEqual(res.json.ended_by, 'operator quit before the first message');
  const g = res.json.orchestrator.interactive.gate;
  assert.strictEqual(g.status, 'not reached');
  assert.strictEqual(g.debug.reason, 'not reached');
  assert.strictEqual(g.session.reason, 'not reached');
}));
