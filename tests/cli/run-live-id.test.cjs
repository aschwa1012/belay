'use strict';
require('../helpers/tmp.cjs');
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// A second `belay run` on a run id whose first life is still going is refused before anything is spawned or cleared.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const { openCore } = require('../../src/core/index.cjs');

test('run: a run id with a live adapter is refused, the run row is untouched and nothing is spawned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-live-')).split(path.sep).join('/');
  const dataDir = `${dir}/.belay`;
  const runId = 'live-run-id';
  try {
    // The first life: a row whose adapter pid is this test process, which answers.
    const seed = await openCore({ dataDir, caller: { role: 'operator', run_id: runId, pid: process.pid }, embed: false });
    await seed.run.attach({ adapter_pid: process.pid });
    const before = await seed.run.get();
    await seed.shutdownOwner();
    await seed.close();

    fs.mkdirSync(`${dir}/wt`, { recursive: true });
    fs.writeFileSync(`${dir}/prompt.txt`, 'a prompt\n');
    const spec = { worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, run_id: runId, orchestrator_dir: `${dir}/orch`, poll_ms: 300, startup_timeout_ms: 20000, on_embedder_failure: 'continue' };
    fs.writeFileSync(`${dir}/spec.json`, JSON.stringify(spec));
    const r = spawnSync(process.execPath, [CLI, 'run', `${dir}/spec.json`, '--data', dataDir, '--json'], { cwd: ROOT, env: { ...process.env, BELAY_CLAUDE_EXE: FAKE_CLAUDE }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.strictEqual(r.status, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const receipt = JSON.parse(r.stderr);
    assert.ok(receipt.ended_by.startsWith(`run ${runId} is still live (adapter pid ${process.pid}, epoch ${before.run.epoch})`), receipt.ended_by);
    assert.strictEqual(receipt.store.attach, null, 'no epoch was opened');
    assert.ok(!fs.existsSync(`${dir}/orch`), 'no orchestrator directory was created');

    const check = await openCore({ dataDir, caller: { role: 'operator', run_id: runId, pid: process.pid }, embed: false });
    try {
      const after = await check.run.get();
      assert.strictEqual(after.epochs.length, before.epochs.length, 'the run row is unchanged');
      assert.strictEqual(after.run.ended_at, null);
    } finally { await check.shutdownOwner(); await check.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
