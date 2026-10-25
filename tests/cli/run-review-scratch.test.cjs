'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // a run here has no model to warm
// run-review-scratch.test.cjs — ADR 0054 amendment 1: `belay run` deletes the run's reviewer scratch folders at close and says
// what it removed in its receipt; the run lever keep_review_scratch keeps them; a bad lever value exits 2 before anything is
// made. A folder another run made is left alone. The fake orchestrator; the folders are planted as the run manager makes them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const RS = require('../../src/run/review-scratch.cjs');
const { parseLevers } = require('../../src/cli/run-levers.cjs');
const fwd = (p) => String(p).split(path.sep).join('/');

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
}

// A sandbox with a spec, and (unless `plant` is false) two scratch folders of this run and one of another run.
function setup(specExtra, plant = true) {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-scratch-')));
  fs.mkdirSync(`${dir}/wt`);
  fs.writeFileSync(`${dir}/prompt.txt`, 'hi\n');
  const runId = `scratch-${Date.now()}`;
  const data = `${dir}/.belay`;
  if (plant) {
    for (const [id, run] of [['rev-a', runId], ['rev-b', runId], ['rev-old', 'an-older-run']]) {
      const s = RS.ensure(data, id, run);
      fs.mkdirSync(`${s}/deep`, { recursive: true });
      fs.writeFileSync(`${s}/probe.cjs`, 'x'.repeat(100));
      fs.writeFileSync(`${s}/deep/out.txt`, 'y'.repeat(20));
    }
  }
  const specPath = `${dir}/spec.json`;
  fs.writeFileSync(specPath, JSON.stringify({ worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, run_id: runId, orchestrator_dir: `${dir}/orch`, poll_ms: 300, startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...specExtra }));
  const r = spawnSync(process.execPath, [CLI, 'run', specPath, '--data', data, '--json'], { cwd: dir, env: { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-scratch' }, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  return { dir, data, runId, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('levers: keep_review_scratch is true or false, and absent from the levers unless on', () => {
  assert.strictEqual(parseLevers({}).keep_review_scratch, undefined);
  assert.strictEqual(parseLevers({ keep_review_scratch: false }).keep_review_scratch, undefined);
  assert.strictEqual(parseLevers({ keep_review_scratch: true }).keep_review_scratch, true);
  for (const bad of ['yes', 1, null, {}]) assert.match(parseLevers({ keep_review_scratch: bad }).error || '', /keep_review_scratch must be true or false/, JSON.stringify(bad));
});

test('run close deletes this run\'s scratch folders, whatever is in them, and the receipt says what it removed', () => {
  const r = setup({});
  try {
    assert.strictEqual(r.status, 0, r.stderr.slice(-600));
    const rec = JSON.parse(r.stdout);
    const s = rec.review_scratch;
    assert.strictEqual(s.kept, false);
    assert.deepStrictEqual(s.folders.map((f) => [f.worker_id, f.bytes, f.files, f.removed]), [['rev-a', 120, 2, true], ['rev-b', 120, 2, true]]);
    assert.deepStrictEqual([s.removed_folders, s.removed_bytes], [2, 240]);
    assert.deepStrictEqual(RS.lines(rec), ['review scratch: removed 2 folder(s), 240 bytes'], 'the text receipt line');
    for (const id of ['rev-a', 'rev-b']) assert.ok(!fs.existsSync(`${r.data}/workers/${id}/scratch`), `${id} removed`);
    assert.ok(fs.existsSync(`${r.data}/workers/rev-old/scratch/probe.cjs`), 'another run\'s folder is left alone');
  } finally { cleanup(r.dir); }
});

test('with keep_review_scratch the folders stay and the receipt says so; a bad value exits 2 before anything is made', () => {
  const r = setup({ keep_review_scratch: true });
  try {
    assert.strictEqual(r.status, 0, r.stderr.slice(-600));
    const s = JSON.parse(r.stdout).review_scratch;
    assert.strictEqual(s.kept, true);
    assert.strictEqual(s.removed_folders, 0);
    assert.ok(fs.existsSync(`${r.data}/workers/rev-a/scratch/deep/out.txt`), 'kept');
    assert.deepStrictEqual(RS.lines({ review_scratch: s }), ['review scratch: kept 2 folder(s) (keep_review_scratch)']);
  } finally { cleanup(r.dir); }
  const bad = setup({ keep_review_scratch: 'yes' }, false);
  try {
    assert.strictEqual(bad.status, 2, bad.stderr);
    assert.match(bad.stderr + bad.stdout, /keep_review_scratch must be true or false/);
    assert.ok(!fs.existsSync(bad.data), 'no data dir was created');
  } finally { cleanup(bad.dir); }
});

test('a run that made no scratch folder has no review_scratch block', () => {
  const r = setup({}, false);
  try {
    assert.strictEqual(r.status, 0, r.stderr.slice(-600));
    assert.strictEqual(JSON.parse(r.stdout).review_scratch, undefined);
  } finally { cleanup(r.dir); }
});
