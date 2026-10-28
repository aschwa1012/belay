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

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const FAKE_NOREADY = path.join(__dirname, 'fakes', 'fake-claude-noready.cjs').replace(/\\/g, '/');
const FAKE_WITH_CHILD = FAKE.replace('fake-claude.cjs', 'fake-claude-with-child.cjs');
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

test('spawn returns the row only after ready, and every artefact is on disk', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w1' });

    assert.equal(row.state, 'running');
    assert.equal(row.id, 'w1');
    assert.equal(row.substrate, 'claude-code');
    assert.equal(row.run_id, 'run-test');
    assert.equal(row.adapter_pid, process.pid);
    assert.ok(Number.isInteger(row.pid) && row.pid > 0);
    assert.equal(P.pidAlive(row.pid), true, 'a running row requires a live pid (ADR 0004 §2)');
    assert.match(row.session_id, /^fake-session/);
    assert.match(row.argv_hash, /^[0-9a-f]{64}$/);
    assert.ok(typeof row.ready_ms === 'number');

    // The row went through core.worker.write. The contract: the first row is a pidless 'starting' (so
    // task.assign has a worker to assign to); no 'running' row exists before the pid is known; a row
    // carrying the pid exists before the first 'running'. The count of 'starting' rows is not part of it:
    // restating pid_created (src/run/write-row.cjs) queues one more 'starting' row when the creation-time
    // read lands before ready, so there are two or three of them depending on host speed.
    const rows = core.rowsFor('w1');
    const states = rows.map((r) => r.state);
    const firstRunning = states.indexOf('running');
    assert.equal(states[0], 'starting');
    assert.equal(rows[0].pid, null, 'the first row has no pid yet');
    assert.ok(firstRunning > 0, 'a running row exists, and not first');
    assert.ok(states.slice(0, firstRunning).every((st) => st === 'starting'), 'only starting rows precede the first running one');
    assert.ok(rows.slice(0, firstRunning).some((r) => r.pid > 0), 'a row carrying the pid it launched with precedes running');
    assert.ok(rows.filter((r) => r.state === 'running').every((r) => r.pid > 0), 'no running row without a pid');

    const dir = path.join(sb.data, 'workers', 'w1');
    for (const f of ['mcp.json', 'settings.json', 'argv.json', 'stream.jsonl']) {
      assert.ok(fs.existsSync(path.join(dir, f)), f + ' must be written beside the worker');
    }
    // Build 12 A1: a Claude Code worker's adapter is given its own log (ADR 0026 section 3's keepalive
    // lines), inside the worker's directory and named from the process arguments alone.
    const adapterArgs = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')).mcpServers.belay.args;
    assert.equal(adapterArgs[adapterArgs.indexOf('--log') + 1], dir.split(path.sep).join('/') + '/adapter.log');
    const argv = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8'));
    assert.equal(argv.argv_hash, row.argv_hash);
    assert.ok(argv.spec.args.includes('--strict-mcp-config'));
    // ADR 0024, build step S2: writeFilesFor now passes the worker's own cwd, so settings.json also
    // carries the ancestor-exclude/auto-memory hygiene block, computed the same way here.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), {
      enabledPlugins: { 'example-plugin@example': false, 'example-extra@example': false, 'codex@openai-codex': false },
      ...require('../../src/run/surface.cjs').hygieneSettings(sb.worktree), hooks: require('../../src/run/kill-guard.cjs').hooksBlock(), // the kill guard
    });

    // Every stream line reached stream.jsonl as it arrived: at ready only the init is there, and by
    // the end of the turn the rest has followed.
    const atReady = fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(atReady[0]).subtype, 'init');
    await m._waitTurn('w1', 8000);
    await sleep(100);
    const lines = fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8').trim().split('\n');
    assert.ok(lines.length >= 5, 'got ' + lines.length + ' stream lines');
    assert.equal(JSON.parse(lines[lines.length - 1]).type, 'result');
  } finally { await teardown(m, sb); }
});

test('a turn writes a harness checkpoint with a tool digest and stores the final text', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'w1', task_id: 't1' });
    await m._waitTurn('w1', 8000);
    await sleep(120);

    assert.equal(core.checkpoints.length, 1);
    const cp = core.checkpoints[0];
    assert.equal(cp.source, 'harness', 'the run manager only ever writes harness-source checkpoints');
    assert.equal(cp.worker_id, 'w1');
    assert.equal(cp.task_id, 't1');
    assert.equal(cp.turn, 1);
    assert.equal(cp.stated, null, 'stated is only ever what a worker said (contract §2)');
    assert.equal(cp.tool_digest.length, 1);
    assert.equal(cp.tool_digest[0].tool, 'Read');
    assert.match(cp.tool_digest[0].args_sha256_12, /^[0-9a-f]{12}$/);
    assert.ok(cp.tool_digest[0].result_bytes > 0);

    assert.equal(core.memories.length, 1);
    const mem = core.memories[0];
    assert.ok(mem.text.startsWith('echo:'));
    assert.ok(mem.text.length <= 1200);
    assert.deepEqual(mem.tags, ['t1', 'w1', 'turn:1']);
    assert.equal(mem.provenance, 'checkpoint:' + cp.id);
  } finally { await teardown(m, sb); }
});

test('a worker with no task gets no checkpoint, says why, and its turn still reaches memory', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hello', worker_id: 'wn' });
    await m._waitTurn('wn', 8000);
    await sleep(120);
    // continuity.checkpoint refuses E_ARGS without a task_id, so there is nothing to checkpoint
    // against. The turn is not lost: it still goes to memory, tagged with the worker and the turn.
    assert.equal(core.checkpoints.length, 0);
    assert.equal(core.callsTo('task.assign').length, 0);
    assert.equal(m._worker('wn').checkpointsSkipped, 1);
    assert.equal(m._worker('wn').lastError.where, 'continuity.checkpoint');
    assert.equal(core.memories.length, 1);
    assert.deepEqual(core.memories[0].tags, ['wn', 'turn:1']);
    assert.equal(core.memories[0].provenance, 'worker:wn');
  } finally { await teardown(m, sb); }
});

test('with a task id the lease is taken and the resume line leads the first message', async () => {
  const sb = sandbox();
  const core = createFakeCore({ resumeLineText: 'RESUME-LINE task t9' });
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'the task', worker_id: 'w1', task_id: 't9' });
    // ADR 0030 decision 4: a check_only call first, then the real assign.
    assert.equal(core.callsTo('task.assign').length, 2);
    assert.equal(core.callsTo('task.assign')[0].args.check_only, true);
    assert.equal(core.callsTo('task.assign')[1].args.worker_id, 'w1');
    assert.equal(core.callsTo('continuity.resumeLine').length, 1);
    const w = m._worker('w1');
    assert.ok(w.firstMessage.startsWith('RESUME-LINE task t9'));
    assert.ok(w.firstMessage.includes('\n\nthe task'), 'the prompt follows the resume line');
    assert.ok(w.firstMessage.endsWith('call lease_release with lease_id lease-1 and a result object (branch, head, tests, findings).'), 'belay closes the message with the hand-back rule naming the lease');
  } finally { await teardown(m, sb); }
});

test('a worker id used twice in a run is refused with the remedy: choose another, an id is used once per run', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore());
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'dup-1' });
    await assert.rejects(() => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'two', worker_id: 'DUP-1' }), (e) => {
      assert.strictEqual(e.code, 'E_ARGS');
      assert.match(e.message, /a worker with that id already exists in this run/);
      assert.match(e.message, /Choose another id: an id is used once per run, even by a spawn that failed/);
      return true;
    });
  } finally { await teardown(m, sb); }
});

test('a task that refuses the assignment fails the spawn before anything launches', async () => {
  // The gate of ADR 0013 1 makes this an ordinary outcome rather than an exotic one: the orchestrator
  // spawns a worker for a task whose dependency is still open. Nothing may launch, the refusal must
  // reach the caller as itself, and the pidless `starting` row must not be left claiming a life.
  const sb = sandbox();
  const core = createFakeCore({ failing: { 'task.assign': 'E_DEPENDENCY_OPEN' } });
  const m = mgr(sb, core);
  try {
    await assert.rejects(
      m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'blocked', worker_id: 'wdep', task_id: 'tdep' }),
      (e) => {
        assert.equal(e.code, 'E_DEPENDENCY_OPEN', 'the refusal is handed back unchanged, not turned into E_NO_READY');
        return true;
      },
    );
    assert.deepEqual(core.rowsFor('wdep').map((r) => r.state), ['starting', 'dead']);
    assert.equal(fs.existsSync(path.join(sb.data, 'workers', 'wdep', 'argv.json')), false, 'no process was launched');
  } finally { await teardown(m, sb); }
});

test('no ready event inside the window is E_NO_READY with a stderr tail and a dead row', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core, FAKE_NOREADY);
  try {
    await assert.rejects(
      () => m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'hi', worker_id: 'w2', startup_timeout_ms: 4000 }),
      (e) => {
        assert.equal(e.code, 'E_NO_READY');
        assert.equal(e.detail.worker_id, 'w2');
        assert.ok(Number.isInteger(e.detail.pid));
        assert.equal(e.detail.exit_code, 1, 'the receipt carries the real exit code, never null (failNoReady waits for the event)');
        assert.match(e.detail.stderr_tail, /refusing to start/);
        return true;
      }
    );
    const wNoReady = m._worker('w2');
    await wNoReady.exitEventSeen;
    await wNoReady.queue;
    assert.equal(core.currentWorker('w2').exit_code, 1, 'the exit event fills the code in');
    const states = core.rowsFor('w2').map((r) => r.state);
    assert.ok(!states.includes('running'), 'never a running row for a worker that never started');
    assert.equal(states[states.length - 1], 'dead');
  } finally { await teardown(m, sb); }
});

// Forced lag (build 12 a2-noready): the child's 'exit' event is held back 2,500 ms, longer than the 1,000 ms
// failNoReady used to wait and longer than the pid poll's interval, so the poll settles the death first with no
// code. The old code failed the start with exit_code null; the fix waits for the event and carries the code.
test('message writes to stdin, counts a turn, and refuses a worker with no live stdin', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w4', task_id: 't4' });
    await m._waitTurn('w4', 8000);
    const r = await m.message({ worker_id: 'w4', text: 'two' });
    assert.equal(r.channel, 'stdin');
    assert.equal(r.bytes, 3);
    assert.equal(r.pid, row.pid);
    assert.equal(r.turn, 2);
    await m._waitTurn('w4', 8000);
    await sleep(120);
    assert.equal(core.checkpoints.length, 2, 'a checkpoint per turn');
    assert.equal(core.memories[1].tags[core.memories[1].tags.length - 1], 'turn:2');

    await m.stop({ worker_id: 'w4', mode: 'kill' });
    await assert.rejects(() => m.message({ worker_id: 'w4', text: 'three' }), (e) => e.code === 'E_SUBSTRATE');
  } finally { await teardown(m, sb); }
});

test('graceful stop closes stdin and reports graceful; kill reports killed', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w5' });
    const s = await m.stop({ worker_id: 'w5', mode: 'graceful', timeout_ms: 8000 });
    assert.equal(s.graceful, true);
    assert.equal(s.killed, false);
    assert.equal(s.exit_code, 0);
    assert.equal(s.pid, row.pid);
    assert.ok(s.ms_to_exit >= 0);
    assert.equal(core.currentWorker('w5').state, 'stopped', 'a requested stop is stopped, not dead');

    const row2 = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w6' });
    const k = await m.stop({ worker_id: 'w6', mode: 'kill', timeout_ms: 8000 });
    assert.equal(k.killed, true);
    assert.equal(k.graceful, false);
    assert.equal(P.pidAlive(row2.pid), false);
  } finally { await teardown(m, sb); }
});

test('a wedged worker times out on the graceful stop and is killed, and says so', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  // A worker that ignores its stdin closing is the case ADR 0001 §5's "exit < 1 s" does not cover.
  // The graceful branch must time out and say `graceful: false`, not credit itself with the death
  // the kill produced.
  process.env.FAKE_IGNORE_STDIN_END = '1';
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w7' });
    const t0 = Date.now();
    const s = await m.stop({ worker_id: 'w7', mode: 'graceful', timeout_ms: 400 });
    assert.equal(s.graceful, false, 'closing stdin did not end this worker');
    assert.equal(s.killed, true, 'the kill did');
    assert.ok(Date.now() - t0 >= 400, 'the graceful branch waited its whole timeout first');
    assert.equal(s.pid, row.pid);
    assert.equal(P.pidAlive(row.pid), false);
    assert.equal(core.currentWorker('w7').state, 'stopped', 'a requested stop is stopped, not dead');
  } finally {
    delete process.env.FAKE_IGNORE_STDIN_END;
    await teardown(m, sb);
  }
});

test('stopping a worker that is already gone claims neither a graceful stop nor a kill', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w9' });
    require('../crash.cjs').crash(m._worker('w9').child);
    await m._waitExit('w9', 8000);
    const s = await m.stop({ worker_id: 'w9', mode: 'graceful', timeout_ms: 4000 });
    // This stop did not end this worker; something else did. Reporting `graceful: true` would credit
    // the harness with a death it had no part in (invariant 5).
    assert.equal(s.graceful, false);
    assert.equal(s.killed, false);
    assert.equal(s.pid, row.pid);
    assert.equal(s.ms_to_exit, 0);
    assert.equal(s.already_exited, true, 'the receipt says the worker had already exited');
    assert.match(s.note, /had already exited .*nothing was stopped/);
    assert.ok(s.state_before, 'and what its row said when the stop arrived');
    assert.equal(core.currentWorker('w9').state, 'dead', 'it died before the stop, so it is dead, not stopped');
  } finally { await teardown(m, sb); }
});

test('restart resumes inside the window and replaces outside it, and says the numbers', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w8', task_id: 't1' });
    await m._waitTurn('w8', 8000);

    const r = await m.restart({ worker_id: 'w8', first_turn_timeout_ms: 8000 });
    assert.equal(r.branch, 'resume');
    assert.match(r.reason, /inside the 3300000 ms claude-code window/);
    assert.ok(r.new_pid !== r.old_pid);
    assert.equal(r.first_turn_timed_out, false);
    assert.ok(r.first_turn_usage);
    assert.ok(r.checkpoint_id);
    const argv = JSON.parse(fs.readFileSync(path.join(sb.data, 'workers', 'w8', 'argv.json'), 'utf8'));
    assert.ok(argv.spec.args.includes('--resume'), 'a resume branch passes --resume');

    // Age the worker past the window: the branch flips to replace and resume.md is written.
    m._worker('w8').lastEventAt = Date.now() - 60 * 60 * 1000;
    const r2 = await m.restart({ worker_id: 'w8', first_turn_timeout_ms: 8000 });
    assert.equal(r2.branch, 'replace');
    assert.match(r2.reason, /outside the 3300000 ms claude-code window/);
    const doc = fs.readFileSync(path.join(sb.data, 'workers', 'w8', 'resume.md'), 'utf8');
    assert.match(doc, /^# resume/);
    const argv2 = JSON.parse(fs.readFileSync(path.join(sb.data, 'workers', 'w8', 'argv.json'), 'utf8'));
    assert.ok(!argv2.spec.args.includes('--resume'), 'a replace branch is a fresh session');
    // The replacement really was told to read the file that was written for it: the fake echoes the
    // first message back, and that echo is what reached memory. (The assertion here used to be on a
    // property no worker record has, so it held whatever the code did.)
    const lastTurnText = core.memories[core.memories.length - 1].text;
    assert.match(lastTurnText, /Read resume\.md in your worker directory/);
    assert.ok(!lastTurnText.includes('You were interrupted and resumed'), 'that is the resume branch line, not the replace one');
  } finally { await teardown(m, sb); }
});

test('list reports the in-memory view and shutdown stops every worker and the owner', async (tcx) => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  tcx.after(() => Promise.resolve().then(() => m.shutdown()));
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wa' });
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wb' });
    const l = await m.list();
    assert.equal(l.workers.length, 2);
    for (const w of l.workers) {
      assert.equal(w.state, 'running');
      assert.equal(w.pid_alive, true);
      assert.ok(w.last_event_at > 0);
    }
    const s = await m.shutdown();
    assert.deepEqual(s.stopped.sort(), ['wa', 'wb']);
    assert.ok(s.ms >= 0);
    assert.equal(core.callsTo('shutdownOwner').length, 1);
    for (const w of (await m.list()).workers) assert.equal(w.pid_alive, false);
  } finally {
    // build step 6h fix round (blocking, FINDINGS.json line 382): only `cleanup(sb.data)` used to run
    // here, so a throw after either `m.spawn` above left both workers alive, holding the process open.
    // The pass path's own `shutdown()` above makes this a no-op then; it is what saves the fail path.
    await teardown(m, sb);
  }
});

test('spawn refuses bad arguments before it launches anything', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    await assert.rejects(() => m.spawn({ substrate: 'nope', worktree: sb.worktree, prompt: 'x' }), (e) => e.code === 'E_ARGS');
    await assert.rejects(() => m.spawn({ substrate: 'claude-code', prompt: 'x' }), (e) => e.code === 'E_ARGS');
    await assert.rejects(() => m.spawn({ substrate: 'claude-code', worktree: sb.worktree }), (e) => e.code === 'E_ARGS');
    assert.equal(core.calls.length, 0, 'a refused spawn writes nothing');
  } finally { await teardown(m, sb); }
});

test('an unsolicited turn is still checkpointed, and marked as one the harness did not ask for', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const m = createRunManager({
    core, dataDir: sb.data, runId: 'run-test',
    paths: { claudeExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
  process.env.FAKE_EXTRA_INIT = '1';
  try {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wc', task_id: 'tc' });
    await sleep(600);
    // Two turns arrived from one stdin write: the harness's own and the injected one.
    assert.equal(core.checkpoints.length, 2);
    // The session id never changed, so the second init was not treated as a restart.
    const sessions = new Set(core.rowsFor('wc').map((r) => r.session_id).filter(Boolean));
    assert.equal(sessions.size, 1);
  } finally {
    delete process.env.FAKE_EXTRA_INIT;
    await teardown(m, sb);
  }
});

test('a stop walks the worker subtree, and the taskkill receipt proves it', async () => {
  const sb = sandbox();
  const core = createFakeCore();
  const pidFile = sb.data + '/grandchild.pid';
  const m = mgr(sb, core, FAKE_WITH_CHILD);
  process.env.FAKE_CHILD_PID_FILE = pidFile;
  let gpid = 0;
  try {
    const row = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wt' });
    gpid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(gpid > 0 && P.pidAlive(gpid), 'the worker must really have a child to lose');

    const s = await m.stop({ worker_id: 'wt', mode: 'kill', timeout_ms: 8000 });
    assert.equal(s.killed, true);
    assert.equal(P.pidAlive(row.pid), false);
    if (P.IS_WINDOWS) {
      // The receipt is the point. A grandchild also dies with its parent through this host's
      // ambient job binding (ADR 0011 §1), so its absence alone would not prove belay killed it;
      // what proves it is that taskkill walked the tree and said so. Issued after process.kill it
      // answers "ERROR: The process not found", exit 128, and terminates nothing.
      const tk = s.tree_kill;
      assert.ok(tk, 'the stop must carry a receipt for the kill it performed');
      assert.equal(tk.tool, 'process.kill'); // ADR 0039: the snapshot tree kill, no taskkill /T
      assert.deepEqual(tk.identity, { via: 'handle' });
      assert.equal(tk.ok, true, `the tree kill reported ${JSON.stringify(tk)}`);
      assert.equal(tk.exit_code, 0);
      assert.ok(tk.terminated >= 2, `the tree kill must reach past the direct child, and it named ${tk.terminated} process(es): ${tk.output}`);
    }
    let alive = P.pidAlive(gpid);
    for (let i = 0; i < 30 && alive; i++) { await sleep(100); alive = P.pidAlive(gpid); }
    assert.equal(alive, false, `the child (pid ${gpid}) outlived the worker that spawned it`);
    gpid = 0;
  } finally {
    delete process.env.FAKE_CHILD_PID_FILE;
    if (gpid) { try { process.kill(gpid); } catch { /* already gone */ } }
    await teardown(m, sb);
  }
});
