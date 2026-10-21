'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm
// run-identity.test.cjs — ADR 0045 decisions 4 and 7 end to end, against the production run configuration (audit D06): `belay run`
// as a subprocess, its owner as that CLI elected it, a worker the run manager launched, and a child of that worker (a stand-in for
// the worker's Bash) forging requests. Unkeyed writes and `bind.open` that name the operator are refused on the pipe and on the
// loopback port, the real CLI's own `stop` run from the worker's descendant is refused, nothing it wrote reaches the store, and
// the operator's `belay stop`, run from this process, still succeeds.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const P = require('../../src/run/process.cjs');
const {
  sandbox, cleanup, waitUntil, waitForExit, makeSpec, runCli, receiptOf, connectOrchestratorCore, readStoreCopy, runStopSync, releaseCore,
} = require('./stop-helpers.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;
const FORGE = `${ROOT}/tests/helpers/forge-from-worker.cjs`;

test('run: a worker\'s child cannot claim the operator on the run\'s owner, and the operator\'s own stop still works', { skip: process.platform !== 'win32' && 'the peer check reads Windows tools', timeout: 240000 }, async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const { specPath, runId } = makeSpec(dir, { startup_timeout_ms: 120000, close_grace_ms: 5000 });
  const out = `${dir}/forge-out.json`;
  const runCliProc = runCli(specPath, dataDir, { BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_HANG: '1' });
  let core = null; let m = null; let worker = null;
  try {
    core = await connectOrchestratorCore(dataDir, runId);
    m = createRunManager({ core, dataDir, runId, paths: { claudeExe: FAKE_CLAUDE, userSettings: USER_SETTINGS } });
    const wt = `${dir}/w1-wt`; fs.mkdirSync(wt, { recursive: true });
    Object.assign(process.env, { FAKE_SPAWN_SCRIPT: FORGE, FORGE_DATA_DIR: dataDir, FORGE_RUN_ID: runId, FORGE_WORKER_ID: 'w1', FORGE_OUT: out });
    try { worker = await m.spawn({ substrate: 'claude-code', worktree: wt, prompt: 'hello', worker_id: 'w1' }); }
    finally { for (const k of ['FAKE_SPAWN_SCRIPT', 'FORGE_DATA_DIR', 'FORGE_RUN_ID', 'FORGE_WORKER_ID', 'FORGE_OUT']) delete process.env[k]; }

    const done = await waitUntil(() => (fs.existsSync(out) ? true : null), 120000, 200);
    assert.ok(done, 'the worker\'s child never finished its attempts');
    const results = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(results.length, 9, JSON.stringify(results));
    for (const r of results) {
      assert.strictEqual(r.ok, false, `forged and served: ${JSON.stringify(r)}`);
      assert.ok(r.code, `refused with no code: ${JSON.stringify(r)}`);
    }
    for (const r of results.filter((x) => !x.attempt.startsWith('cli:'))) assert.strictEqual(r.code, 'E_UNBOUND', JSON.stringify(r));
    const kill = results.find((x) => x.attempt.startsWith('cli: belay worker kill'));
    assert.strictEqual(kill.status, 1, JSON.stringify(kill));
    assert.strictEqual(kill.killed, false, JSON.stringify(kill));
    assert.match(kill.message, /would not vouch for this process as the operator.*nothing was signalled/, JSON.stringify(kill));
    for (const r of results.filter((x) => x.attempt.startsWith('tcp:'))) assert.match(r.message, /descends from a process belay spawned \(worker pid \d+/, `the port's refusal names why: ${JSON.stringify(r)}`);
    for (const r of results.filter((x) => x.attempt.startsWith('pipe:'))) assert.match(r.message, /needs a bound caller|loopback port/, JSON.stringify(r));
    const cli = results.find((x) => x.attempt.startsWith('cli: belay stop'));
    assert.strictEqual(cli.status, 1, JSON.stringify(cli));
    assert.match(cli.message, /operator check refused|descends from a process belay spawned/, JSON.stringify(cli));

    // nothing the child sent reached the store, and the run it tried to stop is still alive
    const forged = readStoreCopy(dataDir, (db) => db.prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE text LIKE 'forged%'").get().n);
    assert.strictEqual(forged, 0, 'a forged write reached the store');
    assert.strictEqual(runCliProc.proc.exitCode, null, 'the run was stopped by the worker\'s child');
    assert.ok(P.pidAlive(worker.pid), 'the worker the run launched is still there');

    // the operator, from this process, is vouched for by its own process: it may signal the worker (the same command the child was refused)
    const killed = require('node:child_process').spawnSync(process.execPath, [`${ROOT}/src/cli/belay.cjs`, 'worker', 'kill', 'w1', '--data', dataDir, '--json'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(killed.status, 0, `operator worker kill: ${killed.stdout} / ${killed.stderr}`);
    assert.strictEqual(JSON.parse(killed.stdout).killed, true);

    // and stops the run
    const stop = runStopSync(dataDir, runId);
    assert.strictEqual(stop.status, 0, `stop: ${stop.stdout} / ${stop.stderr}`);
    assert.strictEqual(stop.receipt.stopped, true);
    const exited = await waitForExit(runCliProc.proc, 30000);
    assert.ok(exited && exited.code === 0, `the run did not exit cleanly after the operator's stop: ${JSON.stringify(exited)} ${runCliProc.stderr}`);
    assert.match(receiptOf(runCliProc, 0).ended_by, /^stopped by belay stop/);
  } finally {
    try { if (m) await m.shutdown(); } catch { /* best effort */ }
    await releaseCore(core);
    if (runCliProc.proc.exitCode === null) { try { await P.killTree(runCliProc.proc); } catch { /* best effort */ } }
    cleanup(dir);
  }
});
