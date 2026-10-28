'use strict';
// run-budgets.test.cjs — the time bounds the functional `belay run` tests do not assert, in the quiet phase (ADR 0018's shape): the
// run is driven N times, the minimum is the figure, and the raw samples are printed beside the gate. The functional suites keep the
// facts (the kill came after the grace, the run says so); here is how long it took.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { spawnSync } = require('node:child_process');
const P = require('../../src/run/process.cjs');
const { emptyScript } = require('../cli/budget.cjs');
const { makeSpec, runCli, receiptOf, waitForFileLine, waitForExit, fwd, cleanup } = require('../cli/stop-helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const N = 3;
const CLOSE_GRACE_MS = 1500;
const KILL_OVER_GRACE_MS = 4500; // the orchestrator that ignores a closed stdin is gone within close_grace_ms plus this, its own identity snapshot aside
const TOTAL_MS = 9000;

async function onceIgnoringStdin() {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-budgets-')));
  const dataDir = `${dir}/.belay`;
  const { specPath, orchestratorDir } = makeSpec(dir, { close_grace_ms: CLOSE_GRACE_MS });
  const t0 = Date.now();
  const run = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_IGNORE_STDIN_END: '1' });
  try {
    assert.ok(await waitForFileLine(`${orchestratorDir}/stream.jsonl`, '"type":"result"', 30000), 'the orchestrator never answered');
    const turnEndAt = Date.now();
    const exited = await waitForExit(run.proc, 60000);
    assert.ok(exited, 'the CLI did not exit within 60,000 ms');
    const totalMs = Date.now() - t0;
    const sinceTurnEnd = Date.now() - turnEndAt;
    const receipt = receiptOf(run, 1);
    const snapMs = (receipt.orchestrator.kill && receipt.orchestrator.kill.snapshot_ms) || 0;
    return { sinceTurnEnd, totalMs, snapMs, killed: receipt.orchestrator.killed_after_close };
  } finally {
    if (run.proc.exitCode === null) { try { await P.killTree(run.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
}

test('budgets: an orchestrator that ignores a closed stdin is killed within its grace plus 4,500 ms, minimum of 3', async () => {
  const samples = [];
  const floors = []; // the host's own spawn floor, taken between the runs and printed beside the figure (ADR 0018), never asserted
  const floorScript = emptyScript();
  for (let i = 0; i < N; i += 1) {
    const s = await onceIgnoringStdin();
    assert.strictEqual(s.killed, true, `run ${i} did not kill the orchestrator after the close`);
    samples.push(s);
    const f0 = Date.now();
    spawnSync(process.execPath, [floorScript], { windowsHide: true, timeout: 20000 });
    floors.push(Date.now() - f0);
  }
  const afterTurn = Math.min(...samples.map((s) => s.sinceTurnEnd - s.snapMs));
  const total = Math.min(...samples.map((s) => s.totalMs - s.snapMs));
  console.log(JSON.stringify({ close_grace_ms: CLOSE_GRACE_MS, since_turn_end_minus_snapshot_min: afterTurn, total_minus_snapshot_min: total, host_floor_ms: floors, samples }));
  assert.ok(afterTurn <= CLOSE_GRACE_MS + KILL_OVER_GRACE_MS, `the kill came ${afterTurn} ms after the turn end (minimum of ${N}), over ${CLOSE_GRACE_MS + KILL_OVER_GRACE_MS} ms; samples ${JSON.stringify(samples)}`);
  assert.ok(total < TOTAL_MS, `the run took ${total} ms (minimum of ${N}), over ${TOTAL_MS} ms; samples ${JSON.stringify(samples)}`);
});
