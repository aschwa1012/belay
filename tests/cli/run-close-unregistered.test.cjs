'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-close-unregistered.test.cjs — ADR 0029 amendment 4 (proposed), the residual window of the late attach, forced through
// the built CLI. The orchestrator (the fake) has a direct child of node's image that stands in for its MCP adapter, and
// that child has NOT attached when the turn ends. The close finds it from one snapshot (the creation time recorded at
// spawn), waits for it by exact pid, and so the attach, and a worker written after it, land before run.end and are closed
// by it. After run.end the same caller can neither write a worker nor become the store owner.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const H = require('./stop-helpers.cjs');
const P = require('../../src/run/process.cjs');
const { crash } = require('../crash.cjs');

const { ROOT, sandbox, cleanup, waitUntil, waitForFileLine, waitForExit, makeSpec, runCli, receiptOf, connectOrchestratorCore, readStoreCopy, releaseCore } = H;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

test('run close: an orchestrator child that has not registered is waited for, and nothing writes into the run after run.end', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, wt, runId, orchestratorDir } = makeSpec(dir, { close_grace_ms: 60000 });
  const pidFile = `${dir}/child.pid`;
  const gate = `${dir}/answer.gate`;
  const snapLog = `${dir}/snapshots.log`;
  const run = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ORPHAN_CHILD: '1', FAKE_CHILD_PID_FILE: pidFile, FAKE_ANSWER_GATE_FILE: gate, BELAY_SNAPSHOT_LOG: snapLog });
  let core = null;
  let worker = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    const adapterPid = await waitUntil(() => { try { return Number(fs.readFileSync(pidFile, 'utf8')) || null; } catch { return null; } }, 60000, 50);
    assert.ok(adapterPid, 'the orchestrator started its stand-in adapter child');
    // The run records the orchestrator's creation time from one snapshot right after it spawns it; a real orchestrator lives for
    // minutes, so the turn is held until that read is done (the real event), not left to a race with a fake that answers at once.
    assert.ok(await waitForFileLine(snapLog, 'spawn-read', 60000), "the run never read the orchestrator's creation time");
    fs.writeFileSync(gate, 'go'); // the orchestrator's turn ends now; the child has not attached
    assert.ok(await waitForFileLine(`${orchestratorDir}/stream.jsonl`, '"type":"result"', 120000), 'the orchestrator turn never ended');
    // The close has taken its one adapter snapshot and reads the run row next: the attach below lands after that read.
    assert.ok(await waitForFileLine(snapLog, 'adapter-scan', 60000), 'the close never scanned for its orchestrator children');

    // The late attach: it can only succeed if the close has not ended the run, which is what waiting for the child guarantees.
    const att = await core.run.attach({ adapter_pid: adapterPid });
    assert.ok(att.epoch >= 2 && att.run.ended_at === null, 'the late attach landed on an open run');
    worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { windowsHide: true, stdio: 'ignore' });
    await core.worker.write({ id: 'w-late', run_id: runId, substrate: 'claude-code', pid: worker.pid, pid_image: 'node.exe', state: 'running', worktree: wt, turns: 0, started_at: Date.now() });

    // The orchestrator has gone by now, so the child is an orphan, still known by its pid and creation time.
    const snap = require('../../src/core/proc-identity.cjs').processSnapshotSync();
    assert.ok(snap && snap.get(adapterPid), 'the stand-in adapter is alive while the close waits for it');
    const killedAt = Date.now();
    assert.ok(crash(adapterPid, snap.get(adapterPid).created), 'the stand-in adapter was stopped by its exact pid and creation time');
    const exited = await waitForExit(run.proc, 120000);
    assert.ok(exited, `belay run did not exit; stderr: ${run.stderr.slice(-1500)}`);
    const receipt = receiptOf(run, exited.code);
    assert.strictEqual(exited.code, 0, `exit ${exited.code}; ended_by: ${receipt.ended_by}`);
    const wc = receipt.workers_closed;
    // Which name the child carries depends on whether the close read the run row before this test's attach landed (unregistered) or
    // after (the run's adapter). Nothing in the test orders those two reads; run-close-scan.test.cjs forces each ordering.
    assert.ok(wc.adapter_pid === adapterPid || (wc.unregistered_adapter_pids && wc.unregistered_adapter_pids.includes(adapterPid)), 'the close named the child it waited for');
    assert.strictEqual(wc.adapter_gone, true);
    assert.ok(receipt.store.ended.ended_at >= killedAt - 250, 'run.end ran before the unregistered adapter was gone');

    // No worker row left running past run.end, and the run reads as ended.
    const w = readStoreCopy(dataDir, (db) => db.prepare('SELECT * FROM worker WHERE id = ? ORDER BY seq DESC LIMIT 1').get('w-late'));
    assert.strictEqual(w.state, 'dead', 'the late worker was closed with the run');
    assert.ok(!P.pidAlive(worker.pid), 'the late worker process was stopped');
    const runRow = H.currentRunRow(dataDir, runId);
    assert.notStrictEqual(runRow.ended_at, null, 'the run reads as ended');
    const rowsAfter = readStoreCopy(dataDir, (db) => db.prepare('SELECT COUNT(*) AS n FROM run WHERE id = ?').get(runId).n);

    // After run.end the same caller cannot write into the run, and does not become a stray owner.
    await assert.rejects(core.worker.write({ id: 'w-after', run_id: runId, substrate: 'claude-code', pid: process.pid, pid_image: 'node.exe', state: 'running', worktree: wt, turns: 0, started_at: Date.now() }), (e) => ['E_SHUTDOWN', 'E_ARGS', 'E_OWNER_LOST'].includes(e.code));
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'no stray owner');
    assert.strictEqual(readStoreCopy(dataDir, (db) => db.prepare('SELECT COUNT(*) AS n FROM worker WHERE id = ?').get('w-after').n), 0);
    assert.strictEqual(readStoreCopy(dataDir, (db) => db.prepare('SELECT COUNT(*) AS n FROM run WHERE id = ?').get(runId).n), rowsAfter);
  } finally {
    await releaseCore(core);
    if (worker) crash(worker);
    if (run.proc.exitCode === null) { try { await P.killTree(run.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});
