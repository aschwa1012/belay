// real-run.test.cjs — the four worker_* tools driven through the adapter against the real
// src/run manager and the real src/core, with no fake injected on either side. The substrate is
// run's own fake-claude fixture, pointed at through BELAY_FAKE_PATHS, so a real child process is
// spawned, a real ready event is parsed and a real pid is stopped: everything except the model.
//
// This is the last of ADR 0010 §2's proof columns to be demonstrated against real code.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { launch, sandboxDir, ROOT } = require('./rpc.cjs');

const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;

// Real core, real run manager; only the substrate binary is a stand-in.
function realRun(data) {
  return launch({
    role: 'orchestrator',
    data,
    fake: false,
    noEmbed: true,
    env: {
      BELAY_FAKE_PATHS: JSON.stringify({ claudeExe: FAKE_CLAUDE, codexExe: FAKE_CLAUDE, userSettings: USER_SETTINGS }),
    },
  });
}

const spawnArgs = (worktree) => ({ substrate: 'claude-code', worktree, prompt: 'do the thing', view: 'debug' }); // the whole row (ADR 0058: compact is the default)

test('A8 worker_spawn returns the row only after the substrate is ready', { timeout: 90000 }, async (t) => {
  const data = sandboxDir('real-run-spawn');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const a = realRun(data);
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const r = await a.call('worker_spawn', spawnArgs(worktree));
  assert.strictEqual(r.isError, false, `worker_spawn refused: ${JSON.stringify(r.structuredContent)}`);
  const w = r.structuredContent;
  for (const k of ['id', 'substrate', 'pid', 'session_id', 'adapter_pid', 'argv_hash', 'started_at', 'state']) {
    assert.ok(Object.prototype.hasOwnProperty.call(w, k), `worker_spawn row names ${k} (ADR 0010 §2)`);
  }
  // The contract allows running, or running then idle for a Codex turn that has already completed.
  assert.ok(['running', 'idle'].includes(w.state), `state was ${w.state}`);
  assert.ok(Number.isInteger(w.pid) && w.pid > 0, 'a real pid, not a placeholder');
  assert.notStrictEqual(w.pid, a.pid, 'the worker is its own process, not the adapter');
  assert.ok(w.session_id, 'the session id needed to resume it later');
  assert.strictEqual(w.adapter_pid, a.pid, 'the adapter that spawned it is named as its parent');
  console.log(`real worker_spawn: pid ${w.pid}, ready_ms ${w.ready_ms}, session ${String(w.session_id).slice(0, 12)}`);

  // ADR 0010 §1: the adapter is the parent, and the artefacts of the launch are on disk.
  const dir = `${data}/workers/${w.id}`;
  assert.ok(fs.existsSync(`${dir}/argv.json`), 'the launch argv is recorded');
  assert.ok(fs.existsSync(`${dir}/stream.jsonl`), 'the stream is being appended');
  // The per-worker MCP config must point at this binary, which is what paths.mcpBinary carries.
  const mcp = JSON.parse(fs.readFileSync(`${dir}/mcp.json`, 'utf8'));
  const argv = JSON.stringify(mcp.mcpServers.belay);
  assert.match(argv, /belay-mcp\.cjs/, 'the worker is given this adapter as its belay server');
  assert.match(argv, /--role[",\s]+worker/, 'the worker adapter is launched in worker role');
  assert.match(argv, new RegExp(w.id), 'the worker adapter is given its own id in argv');
  assert.ok(!argv.includes('--role","orchestrator'), 'a worker is never handed the orchestrator role');

  // status now sees a live worker through the real core, not the manager's own memory.
  const st = (await a.call('status', {})).structuredContent;
  const seen = st.workers.find((x) => x.id === w.id);
  assert.ok(seen, 'status lists the spawned worker');
  assert.strictEqual(seen.pid_alive, true, 'liveness is derived from the pid, not self-reported');
});

test('A8 worker_message, worker_stop and worker_restart return their process facts', { timeout: 90000 }, async (t) => {
  const data = sandboxDir('real-run-life');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const a = realRun(data);
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const w = (await a.call('worker_spawn', spawnArgs(worktree))).structuredContent;

  const m = await a.call('worker_message', { worker_id: w.id, text: 'carry on' });
  assert.strictEqual(m.isError, false, `worker_message refused: ${JSON.stringify(m.structuredContent)}`);
  for (const k of ['worker_id', 'channel', 'bytes', 'pid']) {
    assert.ok(Object.prototype.hasOwnProperty.call(m.structuredContent, k), `worker_message names ${k}`);
  }
  assert.ok(m.structuredContent.bytes > 0, 'bytes actually written');
  console.log(`real worker_message: channel ${m.structuredContent.channel}, ${m.structuredContent.bytes} bytes`);

  const r = await a.call('worker_restart', { worker_id: w.id });
  assert.strictEqual(r.isError, false, `worker_restart refused: ${JSON.stringify(r.structuredContent)}`);
  const rr = r.structuredContent;
  for (const k of ['worker_id', 'branch', 'reason', 'old_pid', 'new_pid', 'session_id', 'checkpoint_id']) {
    assert.ok(Object.prototype.hasOwnProperty.call(rr, k), `worker_restart names ${k} (ADR 0010 §2)`);
  }
  assert.ok(['resume', 'replace'].includes(rr.branch), `branch was ${rr.branch}`);
  assert.ok(rr.reason && rr.reason.length > 0, 'the branch says why, with numbers');
  assert.notStrictEqual(rr.new_pid, rr.old_pid, 'a restart is a new process');
  console.log(`real worker_restart: ${rr.branch}, ${rr.old_pid} -> ${rr.new_pid}, ${rr.reason.slice(0, 70)}`);

  const live = rr.new_pid;
  const s = await a.call('worker_stop', { worker_id: w.id, mode: 'graceful' });
  assert.strictEqual(s.isError, false, `worker_stop refused: ${JSON.stringify(s.structuredContent)}`);
  const ss = s.structuredContent;
  for (const k of ['worker_id', 'pid', 'exit_code', 'ms_to_exit', 'graceful', 'killed', 'session_id']) {
    assert.ok(Object.prototype.hasOwnProperty.call(ss, k), `worker_stop names ${k} (ADR 0010 §2)`);
  }
  assert.strictEqual(ss.graceful, true, 'a graceful stop reports itself as graceful');
  assert.strictEqual(ss.killed, false);
  assert.strictEqual(ss.pid, live, 'the pid stopped is the pid the restart produced');
  console.log(`real worker_stop: exit ${ss.exit_code} in ${ss.ms_to_exit} ms`);

  // No success without effect: the process named in the row is actually gone.
  assert.throws(() => process.kill(live, 0), 'the stopped pid is still alive');
});

test('worker_spawn fails with a code rather than a row when no ready event arrives', { timeout: 90000 }, async (t) => {
  const data = sandboxDir('real-run-noready');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const a = launch({
    role: 'orchestrator',
    data,
    fake: false,
    noEmbed: true,
    env: {
      BELAY_FAKE_PATHS: JSON.stringify({
        claudeExe: `${ROOT}/tests/run/fakes/fake-claude-noready.cjs`,
        userSettings: USER_SETTINGS,
      }),
    },
  });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const r = await a.call('worker_spawn', { ...spawnArgs(worktree), startup_timeout_ms: 4000 });
  assert.strictEqual(r.isError, true, 'a substrate that never says it is ready must not return a row');
  assert.strictEqual(r.structuredContent.error, 'E_NO_READY');
  assert.ok(r.structuredContent.detail, 'the detail carries the pid, exit code and stderr tail');
  console.log(`real E_NO_READY: ${JSON.stringify(r.structuredContent.detail).slice(0, 140)}`);

  // ADR 0010 §2: no row in `running`. The row written is dead.
  const list = (await a.call('status', {})).structuredContent.workers;
  for (const w of list) assert.notStrictEqual(w.state, 'running', 'a worker that never readied is not running');
});

test('the orchestrator stops its workers and releases the owner on stdin end', { timeout: 90000 }, async () => {
  const data = sandboxDir('real-run-shutdown');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const a = realRun(data);
  await a.initialize();
  const w = (await a.call('worker_spawn', spawnArgs(worktree))).structuredContent;
  assert.ok(fs.existsSync(`${data}/owner.lock`), 'spawning elected an owner');

  const code = await a.close();
  assert.strictEqual(code, 0, `exit ${code}, stderr: ${a.stderr}`);
  // Invariant 1: no worker outlives the harness that spawned it.
  assert.throws(() => process.kill(w.pid, 0), 'the worker outlived the orchestrator adapter');
  assert.strictEqual(fs.existsSync(`${data}/owner.lock`), false, 'shutdown must release the owner lock');
  a.kill();
});
