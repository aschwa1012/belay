'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-start-marker.test.cjs — the launch marker <orchestrator_dir>/run-start.json belongs to one life of a run id. The reader accepts a
// marker whose epoch is at or before the row's (the orchestrator's adapter attach bumps the row past the launcher's), so a marker left
// by an earlier life would answer for a later one. The writer side closes that: every launch removes the marker before its own attach.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { clearRunStart } = require('../../src/run/orchestrator-interactive.cjs');
const { markerMatches } = require('../../src/cli/transcript-usage.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const fwd = (p) => String(p).split(path.sep).join('/');
const mk = () => fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-runstart-')));
const rm = (d) => { for (let i = 0; i < 5; i += 1) { try { fs.rmSync(d, { recursive: true, force: true }); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } } };

test('clearRunStart removes exactly run-start.json, ignores a missing one and fails loudly on anything else', () => {
  const d = mk();
  try {
    fs.writeFileSync(`${d}/run-start.json`, '{}');
    fs.writeFileSync(`${d}/run-start.json.keep`, 'x');
    fs.writeFileSync(`${d}/stream.jsonl`, 'x');
    clearRunStart(d);
    assert.deepStrictEqual(fs.readdirSync(d).sort(), ['run-start.json.keep', 'stream.jsonl']);
    clearRunStart(d); // already gone: ENOENT is fine
    fs.mkdirSync(`${d}/run-start.json`);
    assert.throws(() => clearRunStart(d), /run-start\.json in .* could not be removed/);
  } finally { rm(d); }
});

test('the reader keeps its epoch rule: an adapter re-attach in the same session (epoch + 2) still matches, a marker from the future does not', () => {
  const m = { run_id: 'r', mode: 'interactive', epoch: 1 };
  assert.strictEqual(markerMatches(m, { id: 'r', epoch: 1 }), true);
  assert.strictEqual(markerMatches(m, { id: 'r', epoch: 2 }), true);
  assert.strictEqual(markerMatches(m, { id: 'r', epoch: 3 }), true);
  assert.strictEqual(markerMatches({ ...m, epoch: 4 }, { id: 'r', epoch: 3 }), false);
});

// A headless run drives the real CLI with the fake orchestrator. Two launches on one run id and one orchestrator dir; between them the
// operator's earlier interactive life leaves a marker (epoch 1) and a transcript. The second launch must not let them answer.
function headless(dir, runId, name = 'orch') {
  const specPath = `${dir}/spec-${name}.json`;
  fs.writeFileSync(specPath, JSON.stringify({ on_embedder_failure: 'continue', worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, run_id: runId, orchestrator_dir: `${dir}/${name}`, poll_ms: 300, startup_timeout_ms: 20000 }));
  const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-runstart', CLAUDE_CONFIG_DIR: `${dir}/claude-config` };
  return spawnSync(process.execPath, [CLI, 'run', specPath, '--data', `${dir}/.belay`, '--json'], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
}

test('end, then a headless re-run on the same run id and directory: the old marker is gone and no session answers', () => {
  const dir = mk();
  try {
    fs.mkdirSync(`${dir}/wt`);
    fs.writeFileSync(`${dir}/prompt.txt`, 'hi\n');
    const runId = `runstart-${Date.now()}`;
    const first = headless(dir, runId);
    assert.strictEqual(first.status, 0, (first.stderr || '').slice(-600));
    const projects = `${dir}/claude-config/projects/p`;
    fs.mkdirSync(projects, { recursive: true });
    const stale = `${projects}/old.jsonl`;
    fs.writeFileSync(stale, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T11:59:00.000Z', message: { model: 'claude-opus-5-5', id: 'm1', usage: { input_tokens: 5, output_tokens: 5 } } })}\n`);
    fs.writeFileSync(`${dir}/orch/run-start.json`, JSON.stringify({ run_id: runId, epoch: 1, mode: 'interactive', started_at: 1, launcher_pid: 1, session_id: 'old', session_file: stale }));
    const second = headless(dir, runId);
    assert.strictEqual(second.status, 0, (second.stderr || '').slice(-600));
    assert.ok(!fs.existsSync(`${dir}/orch/run-start.json`), 'the headless launch left the earlier life\'s marker in place');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: `${dir}/claude-config` };
    const a = spawnSync(process.execPath, [CLI, 'agents', runId, '--dir', `${dir}/orch`, '--data', `${dir}/.belay`, '--json'], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.strictEqual(a.status, 0, a.stderr);
    const j = JSON.parse(a.stdout);
    assert.notStrictEqual(j.mode, 'interactive', j.mode_source);
    const orch = j.agents.find((x) => x.role === 'orchestrator');
    assert.strictEqual(orch.transcript_path, undefined, 'the old session answered for this life');
    assert.strictEqual(orch.transcript_usage, undefined);
  } finally { rm(dir); }
});

test('a launch that cannot remove the earlier marker fails loudly and names the file', () => {
  const dir = mk();
  try {
    fs.mkdirSync(`${dir}/wt`);
    fs.writeFileSync(`${dir}/prompt.txt`, 'hi\n');
    fs.mkdirSync(`${dir}/orch/run-start.json`, { recursive: true }); // unlink of a directory fails: not ENOENT
    const r = headless(dir, `runstart-fail-${Date.now()}`);
    assert.notStrictEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /run-start\.json/);
  } finally { rm(dir); }
});
