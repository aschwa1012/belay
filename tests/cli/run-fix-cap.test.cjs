'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// run-fix-cap.test.cjs — ADR 0031 decision 6 (build 12 wave 2): `belay run` records its `max_fix_rounds`
// lever on the run row through run.attach, which is what lets core refuse a fix task past the cap. If the
// plumbing in cmd-run.cjs is dropped the cap is silently inert, so this runs the real CLI with the fake
// orchestrator and reads the row.

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
  const tmp = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-fixcap-copy-')));
  try {
    for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${dataDir}/memory.db${s}`)) fs.copyFileSync(`${dataDir}/memory.db${s}`, `${tmp}/memory.db${s}`);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(`${tmp}/memory.db`);
    try { return db.prepare('SELECT seq, epoch, max_fix_rounds, fix_hard_cap FROM run WHERE id = ? ORDER BY seq').all(runId); }
    finally { db.close(); }
  } finally { cleanup(tmp); }
}

test('run: the spec lever (or the default 2) reaches the run row through run.attach', () => {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-fixcap-')));
  try {
    const dataDir = `${dir}/.belay`;
    fs.mkdirSync(`${dir}/wt`);
    fs.writeFileSync(`${dir}/prompt.txt`, 'hi\n');
    const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-fixcap' };
    const go = (name, runId, extra) => {
      const specPath = `${dir}/spec-${name}.json`;
      fs.writeFileSync(specPath, JSON.stringify({ on_embedder_failure: 'continue', worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, run_id: runId, orchestrator_dir: `${dir}/${name}`, poll_ms: 300, startup_timeout_ms: 20000, ...extra }));
      const r = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', dataDir, '--json'], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
      assert.strictEqual(r.status, 0, `${name}: exit ${r.status}: ${(r.stderr || '').slice(-600)}`);
      return runRows(dataDir, runId);
    };
    const one = go('orch1', `cap-a-${Date.now()}`, { max_fix_rounds: 1 });
    assert.ok(one.length >= 1 && one.every((r) => r.max_fix_rounds === 1), JSON.stringify(one));
    const two = go('orch2', `cap-b-${Date.now()}`, {});
    assert.ok(two.length >= 1 && two.every((r) => r.max_fix_rounds === 2), `the default is 2: ${JSON.stringify(two)}`);
    assert.ok(two.every((r) => r.fix_hard_cap === null), `no hard cap by default: ${JSON.stringify(two)}`);
    assert.ok(one.every((r) => r.fix_hard_cap === null), 'max_fix_rounds alone sets no hard cap');
    const three = go('orch3', `cap-c-${Date.now()}`, { fix_hard_cap: 5 });
    assert.ok(three.length >= 1 && three.every((r) => r.fix_hard_cap === 5 && r.max_fix_rounds === 2), JSON.stringify(three));
  } finally { cleanup(dir); }
});
