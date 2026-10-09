'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-effort.test.cjs — build step S6b fix round 1 (MF1, SF2, SF3): `belay run --effort` end to end with
// the fake orchestrator. The level reaches the orchestrator's recorded argv, the run row and the run's
// own receipt; a later run on the same run id without the flag records null, not the earlier level.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const fwd = (p) => String(p).split(path.sep).join('/');

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
}

function runRows(dataDir, runId) {
  const tmp = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-effort-copy-')));
  try {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${dataDir}/memory.db${s}`)) fs.copyFileSync(`${dataDir}/memory.db${s}`, `${tmp}/memory.db${s}`);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(`${tmp}/memory.db`);
    try { return db.prepare('SELECT seq, epoch, orch_effort_requested FROM run WHERE id = ? ORDER BY seq').all(runId); }
    finally { db.close(); }
  } finally { cleanup(tmp); }
}

function argvEffort(orchDir) {
  const a = JSON.parse(fs.readFileSync(`${orchDir}/argv.json`, 'utf8')).spec.args;
  const i = a.indexOf('--effort');
  return i >= 0 ? a[i + 1] : null;
}

test('run: --effort reaches the orchestrator argv, the run row and the receipt, and a later flagless run on the same run id records null', () => {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-effort-')));
  try {
    const dataDir = `${dir}/.belay`;
    fs.mkdirSync(`${dir}/wt`);
    fs.writeFileSync(`${dir}/prompt.txt`, 'hi\n');
    const runId = `effort-${Date.now()}`;
    const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-effort' };
    const go = (name, extra) => {
      const specPath = `${dir}/spec-${name}.json`;
      fs.writeFileSync(specPath, JSON.stringify({ on_embedder_failure: 'continue', worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, run_id: runId, orchestrator_dir: `${dir}/${name}`, poll_ms: 300, startup_timeout_ms: 20000 }));
      const r = spawnSync(process.execPath, [CLI, 'run', specPath, ...extra, '--data', dataDir, '--json'], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
      assert.strictEqual(r.status, 0, `${name}: exit ${r.status}: ${(r.stderr || '').slice(-600)}`);
      return { receipt: JSON.parse(r.stdout), argv: argvEffort(`${dir}/${name}`), rows: runRows(dataDir, runId) };
    };

    const one = go('orch1', ['--effort', 'low']);
    assert.strictEqual(one.argv, 'low', 'the orchestrator argv carries --effort low');
    assert.strictEqual(one.receipt.orch_effort_requested, 'low', 'the receipt names it');
    assert.ok(one.rows.length >= 2 && one.rows.every((r) => r.orch_effort_requested === 'low'), JSON.stringify(one.rows));

    const two = go('orch2', []);
    assert.strictEqual(two.argv, null, 'no flag, no --effort on the argv');
    assert.strictEqual(two.receipt.orch_effort_requested, null);
    const secondEpoch = two.rows.filter((r) => r.epoch === 2);
    assert.ok(secondEpoch.length >= 2, JSON.stringify(two.rows));
    assert.ok(secondEpoch.every((r) => r.orch_effort_requested === null), `the second epoch inherited: ${JSON.stringify(two.rows)}`);

    const three = go('orch3', ['--effort=high']);
    assert.strictEqual(three.argv, 'high');
    assert.ok(three.rows.filter((r) => r.epoch === 3).every((r) => r.orch_effort_requested === 'high'), JSON.stringify(three.rows));
  } finally { cleanup(dir); }
});
