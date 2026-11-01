'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// `belay stop` against a live run whose worker's process cannot be proven (no creation time on its row):
// the kill is refused, the pid stays alive, so the command must exit 1, say NOT killed and list the failure
// in failed_kills. Same scaffold as the planted-worker case in tests/cli/stop.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const P = require('../../src/run/process.cjs');
const {
  sandbox, cleanup, waitForFileLine, makeSpec, runCli, connectOrchestratorCore, releaseCore,
} = require('./stop-helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

function stopCli(dataDir, runId, json) {
  const r = spawnSync(process.execPath, [CLI, 'stop', runId, '--data', dataDir, ...(json ? ['--json'] : [])], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
  let receipt = null;
  if (json) { try { receipt = JSON.parse(r.stdout); } catch { try { receipt = JSON.parse(r.stderr); } catch { /* left null */ } } }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, receipt };
}

test('stop: a worker whose kill is refused as unverifiable and whose pid stays alive makes belay stop exit 1, say NOT killed and list failed_kills', { timeout: 180000 }, async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId, orchestratorDir } = makeSpec(dir, { poll_ms: 300, close_grace_ms: 2000 });
  const holdsFile = `${dir}/holds.jsonl`;
  const env = { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_GATE_FILE: `${dir}/answer.gate`, BELAY_TEST_HOLDS_FILE: holdsFile };
  const runCliProc = runCli(specPath, dataDir, env);
  let core = null;
  let plantedProc = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId, runCliProc);
    plantedProc = spawn(process.execPath, [FAKE_CLAUDE], {
      cwd: dir, env: { ...process.env, FAKE_HANG: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const plantedPid = plantedProc.pid;
    const workerWt = `${dir}/w1-wt`;
    fs.mkdirSync(workerWt, { recursive: true });
    await core.worker.write({
      id: 'w1', substrate: 'claude-code', pid: plantedPid, state: 'running', turns: 0, mid_turn: 1,
      started_at: Date.now(), worktree: workerWt, pid_created: null, pid_created_error: 'the process snapshot was unreadable at spawn',
    });
    fs.writeFileSync(`${dir}/answer.gate`, 'go');
    assert.ok(await waitForFileLine(`${orchestratorDir}/stream.jsonl`, '"type":"result"', 60000), "the orchestrator's first turn never ended");
    assert.ok(await waitForFileLine(holdsFile, '"busy":["w1"]', 60000), 'the run never recorded w1 as busy');

    const j = stopCli(dataDir, runId, true);
    assert.strictEqual(j.status, 1, `exit code: ${j.stdout} / ${j.stderr}`);
    assert.ok(j.receipt, `json receipt: ${j.stdout} / ${j.stderr}`);
    assert.ok(Array.isArray(j.receipt.failed_kills) && j.receipt.failed_kills.length === 1, JSON.stringify(j.receipt.failed_kills));
    assert.strictEqual(j.receipt.failed_kills[0].id, 'w1');
    assert.strictEqual(j.receipt.failed_kills[0].pid, plantedPid);
    assert.strictEqual(P.pidAlive(plantedPid), true, 'the unproven process must not have been killed');

    // A second stop is refused as ended, so the text is rendered from this real receipt by the command's own renderer.
    const text = require('../../src/cli/cmd-stop.cjs').renderText(j.receipt);
    assert.match(text, /NOT killed/);
    assert.ok(text.includes(String(plantedPid)), 'the text shows the pid');
    const w = j.receipt.workers[0];
    assert.strictEqual(w.killed.pid_alive_after, true);
    assert.ok(w.killed.refused, 'the kill was not recorded as refused');
  } finally {
    if (plantedProc && P.pidAlive(plantedProc.pid)) { try { require('../crash.cjs').crash(plantedProc); } catch { /* best effort */ } }
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});
