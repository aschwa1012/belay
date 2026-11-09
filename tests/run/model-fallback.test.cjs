'use strict';
require('../helpers/git-env.cjs');
// model-fallback.test.cjs: Claude Code can move a session to another model after a safeguard refusal (a `model_refusal_fallback` system event).
// belay records the fact on the agent's row and shows it; it decides nothing. The fixture line is the real event, captured from Claude Code 2.1.293.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createParser } = require('../../src/run/parsers.cjs');
const { createUsage } = require('../../src/run/orchestrator-usage.cjs');
const MS = require('../../src/core/model-switch.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { releaseCore } = require('../cli/stop-helpers.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).replace(/\\/g, '/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const USER_SETTINGS = fwd(path.join(__dirname, 'fixtures', 'user-settings.json'));
const CLI = fwd(path.join(__dirname, '..', '..', 'src', 'cli', 'belay.cjs'));
const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-model-refusal-fallback.jsonl'), 'utf8').trim().split('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the parser turns the real model_refusal_fallback line into one model_fallback event', () => {
  const p = createParser('claude-code');
  const events = lines.flatMap((l) => p.pushLine(l));
  const fb = events.filter((e) => e.kind === 'model_fallback');
  assert.equal(fb.length, 1, JSON.stringify(events.map((e) => e.kind)));
  assert.equal(fb[0].from, 'claude-opus-5-5');
  assert.equal(fb[0].to, 'claude-opus-4-8');
  assert.equal(fb[0].trigger, 'refusal');
  assert.equal(fb[0].scope, 'session');
  assert.equal(fb[0].category, 'cyber');
});

test('the orchestrator accumulator carries the switch into its usage, and only when there was one', () => {
  const u = createUsage();
  assert.ok(!('orch_model_fallback' in u.snapshot()));
  const p = createParser('claude-code');
  u.onModelFallback(p.pushLine(lines[0])[0]);
  const s = u.snapshot().orch_model_fallback;
  assert.equal(s.from, 'claude-opus-5-5');
  assert.equal(s.to, 'claude-opus-4-8');
});

test('the line is one short sentence naming both models', () => {
  const l = MS.line('worker w1', { at: Date.UTC(2026, 10, 8, 5, 0, 0), from: 'claude-opus-5-5', to: 'claude-opus-4-8', trigger: 'refusal' });
  assert.equal(l, 'worker w1: model switched: opus-5-5 -> opus-4-8 (refusal fallback) at 2026-11-08T05:00:00.000Z');
});

test('a worker whose session is moved to another model has the fact on its row, in status, workers and receipts', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-model-fb-'));
  const worktree = fwd(path.join(d, 'wt'));
  fs.mkdirSync(worktree, { recursive: true });
  const core = await openCore({ dataDir: `${fwd(d)}/.belay`, caller: { role: 'orchestrator', run_id: 'run-fb', pid: process.pid } });
  await core.run.attach({ adapter_pid: process.pid });
  const m = createRunManager({ core, dataDir: fwd(d), runId: 'run-fb', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: USER_SETTINGS } });
  const env = { FAKE_MODEL: 'fake-model-a', FAKE_MODEL_FALLBACK: 'fake-model-b' };
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  try {
    await m.spawn({ substrate: 'claude-code', worktree, prompt: 'one', worker_id: 'w-fb' });
    await m._waitTurn('w-fb', 8000);
    let row = null;
    for (let i = 0; i < 200 && !(row && row.model_fallback); i += 1) { row = await core.worker.get({ worker_id: 'w-fb' }); if (!row.model_fallback) await sleep(25); }
    assert.ok(row && row.model_fallback, `no fallback on the row: ${JSON.stringify(row)}`);
    assert.equal(row.model_fallback.from, 'fake-model-a');
    assert.equal(row.model_fallback.to, 'fake-model-b');
    assert.equal(row.model, 'fake-model-b', 'the row names the model the session runs on now');
    const cli = (...a) => spawnSync(process.execPath, [CLI, ...a, '--data', `${fwd(d)}/.belay`], { encoding: 'utf8', windowsHide: true }).stdout;
    for (const cmd of ['status', 'workers', 'receipts']) {
      assert.match(cli(cmd), /model switched: fake-model-a -> fake-model-b \(refusal fallback\)/, `belay ${cmd} did not show the switch`);
    }
  } finally {
    for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    await m.shutdown(); await releaseCore(core); cleanup(fwd(d));
  }
});

test('a run that ends with the orchestrator switched records it on the run row', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-model-fb-run-'));
  const core = await openCore({ dataDir: `${fwd(d)}/.belay`, caller: { role: 'operator', run_id: 'run-fb2', pid: process.pid } });
  try {
    await core.run.attach({ adapter_pid: process.pid });
    const u = createUsage();
    u.onInit({ model: 'claude-opus-5-5' });
    u.onModelFallback({ at: 1, from: 'claude-opus-5-5', to: 'claude-opus-4-8', trigger: 'refusal', scope: 'session', category: 'cyber' });
    u.onInit({ model: 'claude-opus-4-8' });
    const ended = await core.run.end({ exit_reason: 'done', usage: u.snapshot() });
    assert.equal(ended.invalid_usage, undefined, JSON.stringify(ended.invalid_usage));
    const row = (await core.run.get({})).run;
    assert.equal(row.orch_model, 'claude-opus-4-8');
    assert.equal(row.orch_model_fallback.to, 'claude-opus-4-8');
    const out = spawnSync(process.execPath, [CLI, 'status', 'run-fb2', '--data', `${fwd(d)}/.belay`], { encoding: 'utf8', windowsHide: true }).stdout;
    assert.match(out, /orchestrator: model switched: opus-5-5 -> opus-4-8 \(refusal fallback\)/);
  } finally { await releaseCore(core); cleanup(fwd(d)); }
});

const SWITCH = { at: 1794000000000, from: 'claude-opus-5-5', to: 'claude-opus-4-8', trigger: 'refusal', scope: 'session', category: 'cyber' };

test('a live run shows the orchestrator switch in status and agents before it ends, and an ended run refuses the write', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-model-fb-live-'));
  const data = `${fwd(d)}/.belay`;
  const core = await openCore({ dataDir: data, caller: { role: 'orchestrator', run_id: 'run-live', pid: process.pid } });
  try {
    await core.run.attach({ adapter_pid: process.pid });
    await assert.rejects(core.run.setModelFallback({ from: 'a' }), /to/);
    const row = await core.run.setModelFallback(SWITCH);
    assert.equal(row.ended_at, null);
    assert.equal(row.orch_model, 'claude-opus-4-8');
    assert.equal(row.orch_model_fallback.from, 'claude-opus-5-5');
    const cli = (...a) => spawnSync(process.execPath, [CLI, ...a, '--data', data], { encoding: 'utf8', windowsHide: true }).stdout;
    assert.match(cli('status', 'run-live'), /orchestrator: model switched: opus-5-5 -> opus-4-8 \(refusal fallback\)/);
    assert.match(cli('agents', 'run-live'), /model switched: opus-5-5 -> opus-4-8 \(refusal fallback\)/);
    await core.run.end({ exit_reason: 'done' });
    await assert.rejects(core.run.setModelFallback(SWITCH), /already ended/);
  } finally { await releaseCore(core); cleanup(fwd(d)); }
});

test('a failed run-row write is logged and never throws into the orchestrator loop', async () => {
  const { noteOrchestratorFallback } = require('../../src/run/model-fallback-note.cjs');
  const logged = [];
  await noteOrchestratorFallback({ run: { setModelFallback: async () => { throw new Error('owner gone'); } } }, SWITCH, (m) => logged.push(m));
  await noteOrchestratorFallback({ run: { setModelFallback: () => { throw new Error('sync boom'); } } }, SWITCH, (m) => logged.push(m));
  assert.equal(logged.length, 2);
  assert.match(logged[0], /owner gone/);
});

test('belay run writes the orchestrator switch to the run row while the run is still open', () => {
  const d = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-model-fb-run2-')));
  const wt = `${d}/wt`;
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(`${d}/prompt.txt`, 'one turn, then the run ends\n');
  fs.writeFileSync(`${d}/spec.json`, JSON.stringify({ on_embedder_failure: 'continue', worktree: wt, prompt_file: `${d}/prompt.txt`, run_id: 'run-fb-live', orchestrator_dir: `${d}/orch`, poll_ms: 500, startup_timeout_ms: 20000 }));
  try {
    const r = spawnSync(process.execPath, [CLI, 'run', `${d}/spec.json`, '--data', `${d}/.belay`, '--json'], {
      encoding: 'utf8', windowsHide: true, timeout: 90000,
      env: { ...process.env, BELAY_CLAUDE_EXE: FAKE, FAKE_MODEL: 'fake-orch-a', FAKE_MODEL_FALLBACK: 'fake-orch-b' },
    });
    assert.equal(r.status, 0, r.stderr);
    const tmp = fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-model-fb-copy-')));
    try {
      for (const sfx of ['', '-wal', '-shm']) if (fs.existsSync(`${d}/.belay/memory.db${sfx}`)) fs.copyFileSync(`${d}/.belay/memory.db${sfx}`, `${tmp}/memory.db${sfx}`);
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(`${tmp}/memory.db`);
      try {
        const open = db.prepare('SELECT orch_model, orch_model_fallback FROM run WHERE id = ? AND ended_at IS NULL AND orch_model_fallback IS NOT NULL').all('run-fb-live');
        assert.equal(open.length, 1, 'no still-open run row carried the switch');
        assert.equal(open[0].orch_model, 'fake-orch-b');
        assert.equal(JSON.parse(open[0].orch_model_fallback).from, 'fake-orch-a');
      } finally { db.close(); }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } finally { cleanup(d); }
});
