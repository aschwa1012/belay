'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1'; // ADR 0034: a run here has no model to warm; the one suite that tests the warm-up opts in
// orchestrator-usage.test.cjs — build step W2-3, S4b: the
// orchestrator's own token, cache and cost receipt, from the accumulator to the run row. (r8) drives a
// fake `belay run` through the CLI as tests/cli/run.test.cjs does and reads the run row from a copy of
// the store (invariant 6); (r9) drives the core's own refusal.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { createUsage } = require('../../src/run/orchestrator-usage.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { releaseCore } = require('../cli/stop-helpers.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).replace(/\\/g, '/');
const ROOT = fwd(path.resolve(__dirname, '..', '..'));
const CLI = `${ROOT}/src/cli/belay.cjs`;
const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;

function sandbox() { return fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-orch-usage-'))); }

// The result-event shape of tests/run/fixtures/claude-stream.jsonl, per-turn usage and a cumulative cost.
const turn = (input, output, read, creation, cost) => ({
  kind: 'turn_end', cost_usd: cost,
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: creation },
});

// ---------------------------------------------------------------- (r7)
test('orchestrator usage: the accumulator sums tokens, sets cost and takes model from init', () => {
  const u = createUsage();
  assert.deepStrictEqual(u.snapshot(), {
    orch_model: null, orch_input_tokens: 0, orch_output_tokens: 0,
    orch_cache_read_tokens: 0, orch_cache_creation_tokens: 0, orch_cost_usd: 0, orch_turns: 0,
  }, 'nothing seen yet: zeros and a null model');
  u.onInit({ kind: 'ready', model: 'claude-haiku-4-5-20251001' });
  u.onTurnEnd(turn(18, 284, 51269, 7949, 0.02246));
  u.onTurnEnd(turn(10, 31, 29740, 133, 0.02587)); // the cumulative total moved by this turn's own share
  u.onTurnEnd({ kind: 'turn_end', usage: null, cost_usd: null }); // an error result: counted, adds nothing
  assert.deepStrictEqual(u.snapshot(), {
    orch_model: 'claude-haiku-4-5-20251001', orch_input_tokens: 28, orch_output_tokens: 315,
    orch_cache_read_tokens: 81009, orch_cache_creation_tokens: 8082, orch_cost_usd: 0.02587, orch_turns: 3,
  }, 'tokens are summed, cost is the latest cumulative value, not 0.04833');
  u.onInit({ kind: 'ready', model: null }); // an init that names no model does not erase the one taken
  assert.strictEqual(u.snapshot().orch_model, 'claude-haiku-4-5-20251001');
  const a = createUsage(); const b = createUsage();
  a.onTurnEnd(turn(1, 1, 1, 1, 1));
  assert.strictEqual(b.snapshot().orch_turns, 0, 'each accumulator has its own state');
});

// ---------------------------------------------------------------- (r8)
function readRunRow(dataDir, runId) {
  const src = `${dataDir}/memory.db`;
  const tmp = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-orch-usage-copy-')));
  try {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, `${tmp}/memory.db${suffix}`);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(`${tmp}/memory.db`);
    try { return db.prepare('SELECT * FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').get(runId) || null; } finally { db.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('orchestrator usage: a fake belay run ends with the orch_* columns on its run row and usage in its orchestrator block', () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const wt = `${dir}/wt`;
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(`${dir}/prompt.txt`, 'one turn, then the run ends\n');
  const runId = `run-usage-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const orchestratorDir = `${dir}/orch`;
  fs.writeFileSync(`${dir}/spec.json`, JSON.stringify({ on_embedder_failure: 'continue', worktree: wt, prompt_file: `${dir}/prompt.txt`, run_id: runId, orchestrator_dir: orchestratorDir, poll_ms: 500, startup_timeout_ms: 20000 }));
  try {
    const r = spawnSync(process.execPath, [CLI, 'run', `${dir}/spec.json`, '--data', dataDir, '--json'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 90000,
      env: { ...process.env, BELAY_CLAUDE_EXE: FAKE_CLAUDE, FAKE_MODEL: 'fake-orch-model-r8' },
    });
    assert.strictEqual(r.status, 0, `the run exited ${r.status}: ${r.stderr}`);
    const receipt = JSON.parse(r.stdout);
    // The fake's one turn: input 100 / output 20 (its cumulative counters after turn one), per-turn cache
    // 1900 read / 7 created, cost 0.001.
    const expected = {
      orch_model: 'fake-orch-model-r8', orch_input_tokens: 100, orch_output_tokens: 20,
      orch_cache_read_tokens: 1900, orch_cache_creation_tokens: 7, orch_cost_usd: 0.001, orch_turns: 1,
    };
    assert.deepStrictEqual(receipt.orchestrator.usage, expected, 'the orchestrator block surfaces the snapshot as usage');
    const row = readRunRow(dataDir, runId);
    assert.ok(row && row.ended_at, 'the run row was not ended');
    for (const [k, v] of Object.entries(expected)) assert.strictEqual(row[k], v, `run row ${k}`);
    const runJson = JSON.parse(fs.readFileSync(`${orchestratorDir}/run.json`, 'utf8'));
    assert.deepStrictEqual(runJson.orchestrator.usage, expected);
    assert.ok(!fs.existsSync(`${dataDir}/owner.lock`), 'no owner left behind');
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------- (r9)
test('run.end: a non-numeric usage field is dropped and named in invalid_usage, and the run is still ended', async () => {
  const dir = sandbox();
  const core = await openCore({ dataDir: `${dir}/.belay`, caller: { role: 'operator', run_id: 'run-r9', pid: process.pid } });
  try {
    // A usage problem never stops a run ending (amendment 1, SF2): each bad case ends its own epoch.
    const endWith = async (usage, field) => {
      await core.run.attach({ adapter_pid: process.pid });
      const ended = await core.run.end({ exit_reason: 'test', usage });
      assert.ok(Number.isInteger(ended.ended_at), 'the run is ended');
      assert.strictEqual(ended.exit_reason, 'test');
      assert.ok(Array.isArray(ended.invalid_usage) && ended.invalid_usage.some((x) => x.field === field), `invalid_usage names ${field}: ${JSON.stringify(ended.invalid_usage)}`);
      const got = await core.run.get();
      assert.ok(got.run.ended_at, 'the store row is ended too');
      return ended;
    };
    const a = await endWith({ orch_input_tokens: 'many', orch_turns: 2 }, 'orch_input_tokens');
    assert.strictEqual(a.orch_input_tokens, null, 'the bad field is dropped');
    assert.strictEqual(a.orch_turns, 2, 'the valid ones are kept');
    await endWith({ orch_cost_usd: NaN }, 'orch_cost_usd');
    await endWith({ orch_model: 7 }, 'orch_model');
    await endWith({ orch_bogus: 1 }, 'orch_bogus');
    await endWith('not an object', 'usage');
    await core.run.attach({ adapter_pid: process.pid });
    const ended = await core.run.end({ exit_reason: 'test', usage: { orch_model: 'm', orch_input_tokens: 5, orch_cost_usd: 0.5, orch_turns: 2 } });
    assert.strictEqual(ended.orch_input_tokens, 5);
    assert.strictEqual(ended.orch_model, 'm');
    assert.strictEqual(ended.orch_cost_usd, 0.5);
    assert.strictEqual(ended.orch_output_tokens, null, 'a field not given stays null');
    assert.strictEqual(ended.invalid_usage, undefined, 'a clean usage names nothing');
  } finally { await releaseCore(core); cleanup(dir); }
});
