'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// run-routing.test.cjs — `belay run` pins the retrieval routing before the orchestrator's first prompt (ADR 0050 decision 3), and the receipt
// carries a `retrieval` block. Driven as a subprocess with the fake orchestrator, the way run-levers.test.cjs is; the pinned CPU reranker has no
// model in the sandbox, so the pin's warm-up fails and (on_heavy_failure fallback, the default) the run starts on the fallback profile with ONE
// notice: the route a real run takes on a machine without the model, and the proof that the pin ran.

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

function go(specExtra, json = true) {
  const dir = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-routing-')));
  fs.mkdirSync(`${dir}/wt`);
  fs.writeFileSync(`${dir}/prompt.txt`, 'hello\n');
  const spec = `${dir}/spec.json`, recv = `${dir}/recv.jsonl`;
  fs.writeFileSync(spec, JSON.stringify({ worktree: `${dir}/wt`, prompt_file: `${dir}/prompt.txt`, run_id: `routing-${Date.now()}`, orchestrator_dir: `${dir}/orch`, poll_ms: 300, startup_timeout_ms: 20000, on_embedder_failure: 'continue', ...specExtra }));
  const env = { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_SESSION_ID: 'fake-routing', FAKE_RECV_FILE: recv };
  const r = spawnSync(process.execPath, [CLI, 'run', spec, '--data', `${dir}/.belay`, ...(json ? ['--json'] : [])], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
  return { dir, recv, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('a routed run pins before the first prompt and the receipt carries the retrieval block; --json keeps stderr clean', () => {
  const r = go({ memory: { profile: 'cpu-rerank-light' } });
  try {
    assert.strictEqual(r.status, 0, `${r.status}: ${r.stderr}\n${r.stdout.slice(0, 600)}`);
    const receipt = JSON.parse(r.stdout);
    assert.ok(receipt.retrieval, 'the receipt names the retrieval routing');
    assert.strictEqual(receipt.retrieval.notices.length, 1, 'one notice');
    assert.strictEqual(receipt.retrieval.notices[0].code, 'retrieval_warmup_failed');
    assert.ok(receipt.retrieval.start_progress.some(l => /probing the GPU and warming the pinned models/.test(l)), 'the start-up progress is in the receipt under --json');
    assert.doesNotMatch(r.stderr, /retrieval routing/, 'under --json stderr carries failure receipts only');
    // Before the first prompt: the fake orchestrator's receive file is created when the prompt arrives, after the pin was written.
    assert.ok(fs.existsSync(r.recv), 'the orchestrator did get its prompt');
    assert.ok(fs.statSync(r.recv).birthtimeMs + 2 >= receipt.retrieval.pinned_at, 'the routing was pinned at or before the prompt arrived');
    // `belay status` shows the pinned routing from the run row.
    const st = spawnSync(process.execPath, [CLI, 'status', '--data', `${r.dir}/.belay`], { cwd: r.dir, env: { ...process.env, BELAY_TEST_MODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.match(st.stdout, /retrieval: profile cpu-fast/, st.stdout + st.stderr);
    assert.match(st.stdout, /retrieval notice [(]retrieval_warmup_failed[)]/);
  } finally { cleanup(r.dir); }
});

test('a default run pins nothing: no retrieval block in its receipt', () => {
  const r = go({});
  try {
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).retrieval, undefined);
  } finally { cleanup(r.dir); }
});

test('without --json the progress and the notice go to stderr', () => {
  const r = go({ memory: { profile: 'cpu-rerank-light' } }, false);
  try {
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /belay: resolving the retrieval routing/);
    assert.match(r.stderr, /belay: notice \(retrieval_warmup_failed\)/);
  } finally { cleanup(r.dir); }
});
