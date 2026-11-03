'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// retrieval-surfaces.test.cjs — `belay notices` and `belay receipts` carry the run's retrieval: the pin's failures (what failed, the profile served,
// the next step), the pinned tier per role, and a run that pinned nothing says so. A real `belay run` with the fake orchestrator whose pinned CPU
// reranker has no model in the sandbox (the route run-routing.test.cjs uses), then both read commands over the store it left.

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
const cleanup = (dir) => { for (let i = 0; i < 5; i += 1) { try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } } };

function go(specExtra) {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-retr-surf-')));
  fs.mkdirSync(`${dir}/wt`);
  fs.writeFileSync(`${dir}/prompt.txt`, 'hello\n');
  const spec = `${dir}/spec.json`;
  fs.writeFileSync(spec, JSON.stringify({ worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, run_id: 'surf-run', orchestrator_dir: `${dir}/orch`, poll_ms: 300, startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...specExtra }));
  const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-surf', FAKE_RECV_FILE: `${dir}/recv.jsonl` };
  const r = spawnSync(process.execPath, [CLI, 'run', spec, '--data', `${dir}/.belay`, '--json'], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  assert.strictEqual(r.status, 0, `${r.status}: ${r.stderr}\n${r.stdout.slice(0, 600)}`);
  return dir;
}
const read = (dir, cmd, json = true) => {
  const r = spawnSync(process.execPath, [CLI, cmd, 'surf-run', '--data', `${dir}/.belay`, ...(json ? ['--json'] : [])], { cwd: dir, env: { ...process.env, BELAY_TEST_MODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.strictEqual(r.status, 0, `${cmd}: ${r.stderr}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
};

test('notices names the retrieval failure the pin recorded, with the profile served and the next step', () => {
  const dir = go({ memory: { profile: 'cpu-rerank-light' } });
  try {
    const events = read(dir, 'notices').events;
    const f = events.find((e) => e.kind === 'retrieval_warmup_failed');
    assert.ok(f, `kinds: ${events.map((e) => e.kind)}`);
    assert.strictEqual(f.retrieval, true);
    assert.strictEqual(f.fallback_from, 'cpu-rerank-light');
    assert.match(f.text, /belay embedder fetch --reranker/, 'the next step is in the message');
    assert.match(f.text, /served on the/);
    const text = read(dir, 'notices', false);
    assert.match(text, /retrieval_warmup_failed/);
    assert.match(text, /warming .* failed/);
  } finally { cleanup(dir); }
});

test('receipts carries the retrieval block: the pinned tier, the fallback and the failure; text too', () => {
  const dir = go({ memory: { profile: 'cpu-rerank-light' } });
  try {
    const r = read(dir, 'receipts').retrieval;
    assert.strictEqual(r.pinned, true);
    assert.strictEqual(r.profile, 'cpu-fast');
    assert.strictEqual(r.fallback_from, 'cpu-rerank-light');
    assert.strictEqual(r.failures[0].code, 'retrieval_warmup_failed');
    const text = read(dir, 'receipts', false);
    assert.match(text, /^retrieval {2}run tier cpu-fast[\s\S]*fell back from cpu-rerank-light/m);
    assert.match(text, /^ {2}failure retrieval_warmup_failed:$/m);
  } finally { cleanup(dir); }
});

test('a run that pinned nothing says so in its receipt', () => {
  const dir = go({});
  try {
    const r = read(dir, 'receipts').retrieval;
    assert.deepStrictEqual([r.pinned, r.profile, r.failures], [false, 'cpu-fast', []]);
    assert.match(read(dir, 'receipts', false), /^retrieval {2}nothing pinned/m);
  } finally { cleanup(dir); }
});

test('failures() names a heavy tier fallback in force and a failed reranker warm-up', () => {
  const RV = require('../../src/core/retrieval-view.cjs');
  const tier = { profile: 'gpu-rerank-fast', embedder: 'e', reranker: 'r', device: 'gpu' };
  const row = { epoch: 1, retrieval_routing: JSON.stringify({ routing: { run: tier, tiers: {} }, pinned_at: 5, notices: [], warmups: [{ model: 'r', state: 'failed', trigger: 'first_search', started_at: 6, ended_at: 7, error: 'boom' }], fallback: { epoch: 1, at: 9, cause: { code: 'E_X', message: 'child died' } } }) };
  const codes = RV.failures(RV.describe(row)).map((f) => f.code);
  assert.deepStrictEqual(codes, ['reranker_warm_failed', 'heavy_tier_fallback']);
  assert.deepStrictEqual(RV.failures(null), []);
});

test('a start refused by the pin says the orchestrator process had been started and was stopped before any prompt', () => {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-retr-surf-')));
  try {
    fs.mkdirSync(`${dir}/wt`);
    fs.writeFileSync(`${dir}/prompt.txt`, 'hello\n');
    fs.writeFileSync(`${dir}/spec.json`, JSON.stringify({ worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, run_id: 'surf-refused', orchestrator_dir: `${dir}/orch`, poll_ms: 300, startup_timeout_ms: 20000, on_embedder_failure: 'continue', memory: { profile: 'cpu-rerank-light', on_heavy_failure: 'pause' } }));
    const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-surf', FAKE_RECV_FILE: `${dir}/recv.jsonl` };
    const r = spawnSync(process.execPath, [CLI, 'run', `${dir}/spec.json`, '--data', `${dir}/.belay`, '--json'], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
    assert.strictEqual(r.status, 1, r.stderr);
    const rc = JSON.parse(r.stdout || r.stderr);
    assert.match(rc.ended_by, /could not be pinned/);
    assert.ok(rc.orchestrator.pid > 0);
    assert.ok(rc.ended_by.includes(`orchestrator process (pid ${rc.orchestrator.pid}) had been started`), rc.ended_by);
    assert.ok(!fs.existsSync(`${dir}/recv.jsonl`), 'no prompt reached it');
  } finally { cleanup(dir); }
});
