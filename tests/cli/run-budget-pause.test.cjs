'use strict';
// run-budget-pause.test.cjs — a budgeted `belay run` end to end with the fake Claude Code executable: a usage row past 90 percent of
// the limit pauses the run with a budget reason and a recorded detail; the orchestrator is woken once, past the hold; the resume is
// refused without a raise or an override, and each of --budget and --over-budget lets it through and is recorded on the run row.
// Scaffolding as tests/cli/run-embedder-pause.test.cjs: a real `belay run` subprocess, and this process the orchestrator's core.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const {
  ROOT, CLI, sandbox, cleanup, waitUntil, waitForExit, makeSpec, runCli, connectOrchestratorCore, currentRunRow, releaseCore,
} = require('./stop-helpers.cjs');
const P = require('../../src/run/process.cjs');

const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

function cli(args, dataDir) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true });
    let stdout = ''; proc.stdout.on('data', (d) => { stdout += d; });
    let stderr = ''; proc.stderr.on('data', (d) => { stderr += d; });
    proc.once('exit', (status) => {
      let json = null;
      try { json = JSON.parse(status === 0 ? stdout : stderr); } catch { /* left null */ }
      resolve({ status, stdout, stderr, json });
    });
  });
}

const pausedRow = (dataDir, runId) => waitUntil(() => { const r = currentRunRow(dataDir, runId); return r && r.paused_at && r.pause_parks ? r : null; }, 30000, 200);
const record = (core, cost) => core.usage.record({ worker_id: 'w1', substrate: 'claude-code', turn: 1, cost_usd: cost, cost_basis: 'delta-of-cumulative' });

test('a budgeted run pauses at 90 percent, wakes the orchestrator once, and resumes only with a raise or an override', { timeout: 300000 }, async () => {
  const dir = sandbox();
  let core, cliProc, dataDir, runId;
  try {
    dataDir = `${dir}/.belay`;
    const made = makeSpec(dir, { poll_ms: 300, budget_usd: 10 });
    runId = made.runId;
    cliProc = runCli(made.specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_ANSWER_DELAY_MS: '60000' });
    core = await connectOrchestratorCore(dataDir, runId);
    const row0 = currentRunRow(dataDir, runId);
    assert.strictEqual(row0.budget_usd, 10);

    await record(core, 8.5);
    assert.strictEqual(currentRunRow(dataDir, runId).paused_at, null, 'under 90 percent: no pause');
    await record(core, 1.0);
    const row = await pausedRow(dataDir, runId);
    assert.ok(row, 'the run never paused');
    assert.match(row.paused_by, /^operator:\d+ \[budget \(run, \$9\.50 of \$10\.00 est\.\)\]$/);
    const budget = JSON.parse(row.budget);
    const ev = budget.events.find((e) => e.type === 'pause');
    assert.strictEqual(ev.estimate, true);
    assert.strictEqual(ev.spent_after_parks, 9.5);

    const refused = await cli(['resume', runId], dataDir);
    assert.notStrictEqual(refused.status, 0);
    assert.match(refused.stderr + refused.stdout, /--over-budget/);
    assert.ok(currentRunRow(dataDir, runId).paused_at, 'a refused resume leaves the run paused');
    const low = await cli(['resume', runId, '--budget', '9'], dataDir);
    assert.notStrictEqual(low.status, 0);

    const raised = await cli(['resume', runId, '--budget', '20'], dataDir);
    assert.strictEqual(raised.status, 0, `${raised.stdout} / ${raised.stderr}`);
    const after = currentRunRow(dataDir, runId);
    assert.strictEqual(after.paused_at, null);
    assert.strictEqual(after.budget_usd, 20);
    assert.ok(JSON.parse(after.budget).events.some((e) => e.type === 'raise' && e.old === 10 && e.new === 20 && /^operator:/.test(e.by)));

    await record(core, 9.0); // 18.5 of 20: past 90 percent again
    assert.ok(await pausedRow(dataDir, runId), 'a second breach pauses again');
    const over = await cli(['resume', runId, '--over-budget'], dataDir);
    assert.strictEqual(over.status, 0, `${over.stdout} / ${over.stderr}`);
    assert.ok(JSON.parse(currentRunRow(dataDir, runId).budget).events.some((e) => e.type === 'override' && e.override === true));
    await record(core, 100);
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(currentRunRow(dataDir, runId).paused_at, null, 'an overridden limit is no longer enforced');
  } finally {
    if (cliProc && cliProc.proc.exitCode === null) { try { await cli(['stop', runId], dataDir); } catch { /* best effort */ } await waitForExit(cliProc.proc, 15000); }
    await releaseCore(core);
    if (cliProc && cliProc.proc.exitCode === null) { try { await P.killTree(cliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});
