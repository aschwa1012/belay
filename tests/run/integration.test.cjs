'use strict';
// The one test that spends real money: a real Claude Code worker on launch.cjs's default model, launched by the real
// run manager against the real core, in a sandbox data dir under the OS temp dir — never the
// repository's own store. It asserts the whole chain the contract promises:
//   spawn returns only after `ready`, and the row it returns is `running` with a live pid;
//   the turn writes a harness checkpoint and a memory entry through the core;
//   killing the worker by its exact pid leaves a `dead` row with an exit code within one poll.
//
// Opt-in: it runs only when BELAY_REAL=1 is set and a Claude Code binary can be found; otherwise it is
// skipped with a message saying which.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const L = require('../../src/run/launch.cjs');
const P = require('../../src/run/process.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// claudeExe() throws when no executable can be found; that is "no binary" here, not a failure.
const HAVE_CLAUDE = (() => { try { return fs.existsSync(L.claudeExe()); } catch { return false; } })();
const SKIP = process.env.BELAY_REAL !== '1'
  ? 'opt-in: set BELAY_REAL=1 to run this test, which starts a real Claude Code session and spends money'
  : (HAVE_CLAUDE ? false : 'BELAY_REAL=1 is set but no Claude Code binary was found');

test('a real Claude Code worker: ready, a checkpoint through the core, then dead on an exact-pid kill', { skip: SKIP, timeout: 300000 }, async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-real-'));
  const dataDir = path.join(sb, 'data').replace(/\\/g, '/');
  const worktree = path.join(sb, 'wt').replace(/\\/g, '/');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'input.md'), 'belay holds the rope; it does not do the work.\n');

  const runId = 'run-integration-' + process.pid;
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: runId, pid: process.pid }, embed: true });
  let m = null;
  try {
    await core.run.attach({ adapter_pid: process.pid });
    m = createRunManager({
      core, dataDir, runId,
      // A stub stdio MCP server stands in for src/mcp/belay-mcp.cjs, which another agent owns:
      // the point here is that the worker really launches an MCP child under --strict-mcp-config.
      paths: { mcpBinary: path.join(__dirname, 'fakes', 'stub-mcp.cjs') },
    });

    // A real task, so the lease, the resume line and the harness checkpoint are all exercised: a
    // checkpoint row belongs to a task, and the core refuses one without a task_id.
    const task = await core.task.create({ spec: 'Report the first four words of input.md.', files_owned: [] });

    const row = await m.spawn({
      substrate: 'claude-code', worktree, worker_id: 'real-1', task_id: task.id,
      prompt: 'Read input.md in this directory and reply with its first four words. Do not write any files.',
      allowed_tools: ['Read', 'mcp__belay'],
      startup_timeout_ms: 120000,
    });

    // Ready, and the row is running with a live pid (ADR 0004 §2: never running without one).
    assert.equal(row.state, 'running');
    assert.equal(row.substrate, 'claude-code');
    assert.equal(row.run_id, runId);
    assert.ok(Number.isInteger(row.pid) && row.pid > 0);
    assert.equal(P.pidAlive(row.pid), true);
    assert.match(row.session_id, /^[0-9a-f-]{36}$/);
    assert.match(row.argv_hash, /^[0-9a-f]{64}$/);
    assert.ok(row.ready_ms > 0 && row.ready_ms < 120000);
    // ADR 0001 §8, verified rather than assumed: spawn only returned because the init event listed
    // the belay MCP server as connected. Contract §5 makes anything else E_NO_READY.
    assert.deepEqual(m._worker('real-1').readyEvidence.mcp_servers, [{ name: 'belay', status: 'connected' }]);

    // The worker really has an MCP child, so this is a subtree and not a lone process.
    const kids = await P.childPids(row.pid);
    assert.ok(kids.length >= 1, 'the worker must have spawned its MCP server: ' + JSON.stringify(kids));

    // The store, read back through the core rather than from the manager's memory.
    const fromStore = await core.worker.get({ worker_id: 'real-1' });
    assert.equal(fromStore.state, 'running');
    assert.equal(fromStore.pid, row.pid);
    assert.equal(fromStore.pid_alive, true);
    assert.equal(fromStore.adapter_pid, process.pid);

    // One real turn: a harness checkpoint and the turn's text in memory, both through the core.
    const turn = await m._waitTurn('real-1', 180000);
    assert.ok(turn, 'the worker must complete a turn');
    await sleep(400);
    assert.ok(turn.checkpoint_id, 'a harness checkpoint id must come back: ' + JSON.stringify(m._worker('real-1').lastError));

    // The checkpoint is readable back through the core, is harness-source, and its digest is
    // derived from the stream rather than from anything the worker said (contract §2).
    const t = await core.task.get({ task_id: task.id });
    assert.equal(t.last_checkpoint_id, turn.checkpoint_id);
    const doc = await core.continuity.resumeDoc({ task_id: task.id });
    assert.ok(doc.bytes <= 4096);
    const line = await core.continuity.resumeLine({ task_id: task.id });
    assert.ok(line.bytes <= 400, 'the resume line stays inside the 400-byte hook budget');

    const found = await core.memory.search({ query: 'first four words of input.md', k: 5 }).catch(() => null);
    if (found) {
      assert.ok(found.results.some((r) => (r.tags || []).includes('real-1')), 'the turn text must be findable by the worker id tag');
    }

    // Kill by exact pid. The row must settle to dead with an exit code inside one 1,000 ms poll.
    const t0 = Date.now();
    require('../crash.cjs').crash(m._worker('real-1').child);
    await m._waitExit('real-1', 15000);
    await sleep(300);
    const ms = Date.now() - t0;
    const dead = await core.worker.get({ worker_id: 'real-1' });
    assert.equal(dead.state, 'dead', 'a killed worker is dead, not running');
    assert.equal(dead.pid_alive, false);
    assert.ok(dead.exited_at >= t0);
    // `!== undefined` passed on the null this row used to carry. A killed process leaves an exit
    // code on Windows and a signal on POSIX; one of the two has to be there.
    assert.ok(
      Number.isInteger(dead.exit_code) || typeof dead.exit_signal === 'string',
      'the exit code or the signal is recorded, got ' + JSON.stringify({ exit_code: dead.exit_code, exit_signal: dead.exit_signal })
    );
    assert.ok(ms < 1500, 'settled within one poll, took ' + ms + ' ms');

    // Every stream line landed where status.get looks for it.
    const stream = path.join(dataDir, 'workers', 'real-1', 'stream.jsonl');
    assert.ok(fs.existsSync(stream));
    assert.ok(fs.readFileSync(stream, 'utf8').trim().split('\n').length >= 3);
    for (const f of ['mcp.json', 'settings.json', 'argv.json']) {
      assert.ok(fs.existsSync(path.join(dataDir, 'workers', 'real-1', f)), f);
    }
  } finally {
    if (m) await m.shutdown().catch(() => {});
    await core.close().catch(() => {});
    await sleep(300);
    try {
      fs.rmSync(sb, { recursive: true, force: true });
    } catch { /* a sandbox left in the temp dir is not a test failure */ }
  }
});
