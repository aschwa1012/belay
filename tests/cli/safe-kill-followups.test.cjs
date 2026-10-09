'use strict';
process.env.BELAY_TEST_MODE = '1'; process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP = '1';
// safe-kill-followups.test.cjs — ADR 0039 review follow-ups at the CLI kill sites: a fast close with no budget
// for a snapshot is refused as no_budget (never as an unreadable snapshot), the receipt keeps each refusal's
// kind, and a row whose identity was never verified is refused with the pid, the image and the way to end it
// by hand. Every process here is a sleeper this test spawned; each must survive its refusal.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { sandbox, cleanup } = require('./stop-helpers.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { closeRunWorkers, workersClosedBlock } = require('../../src/cli/run-close.cjs');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;
const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
const running = (c) => c.exitCode === null && c.signalCode === null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const coreOf = (rows) => ({ run: { get: async () => ({ run: { adapter_pid: process.pid } }) }, worker: { list: async () => ({ workers: rows }) } });

test('fast close without budget for a snapshot: refused as no_budget, no snapshot taken, the log says no_budget, the process survives', async () => {
  const s = sleeper();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-fc-'));
  const log = path.join(dir, 'kills.jsonl');
  const prev = process.env.BELAY_KILL_LOG;
  process.env.BELAY_KILL_LOG = log;
  try {
    const row = { id: 'w1', run_id: 'r1', substrate: 'claude-code', state: 'running', pid: s.pid, pid_created: 123, pid_image: 'node.exe' };
    let snaps = 0;
    const fast = { requested: () => true, leftMs: () => 400, snapshot: () => { snaps++; return Promise.resolve(null); }, snapshotPending: () => false };
    const out = await closeRunWorkers({ core: coreOf([row]), runId: 'r1', graceMs: 100, fast });
    const k = out.killed[0];
    assert.strictEqual(k.kind, 'no_budget', JSON.stringify(k));
    assert.match(k.detail, /no budget for a fresh snapshot in the fast close/);
    assert.doesNotMatch(k.detail, /unreadable/);
    assert.strictEqual(snaps, 0, 'no snapshot is started without the budget for one');
    assert.strictEqual(k.signalled, false);
    assert.match(k.manual, /Stop-Process -Id/);
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines.map((l) => [l.kind, l.fn, l.ok]), [['no_budget', 'fastCloseSkip', false]]);
    assert.match(lines[0].caller, /^src\/cli\/run-close\.cjs:/);
    const block = workersClosedBlock(out, []);
    assert.strictEqual(block.killed[0].kind, 'no_budget', 'the receipt keeps the kind');
    await sleep(150);
    assert.strictEqual(running(s), true);
  } finally {
    if (prev === undefined) delete process.env.BELAY_KILL_LOG; else process.env.BELAY_KILL_LOG = prev;
    s.kill(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fast close with little budget but a young snapshot in hand: the kill proceeds on it, checked by creation time', async () => {
  const s = sleeper();
  try {
    const snap = await require('../../src/core/proc-identity.cjs').processSnapshot();
    const made = snap && snap.get(s.pid);
    assert.ok(made, 'the sleeper is not in the snapshot');
    const row = { id: 'w1', run_id: 'r1', substrate: 'claude-code', state: 'running', pid: s.pid, pid_created: made.created, pid_image: 'node.exe' };
    const fast = { requested: () => true, leftMs: () => 400, snapshot: () => Promise.resolve(snap), snapshotPending: () => true };
    const out = await closeRunWorkers({ core: coreOf([row]), runId: 'r1', graceMs: 100, fast });
    assert.ok(!out.killed[0].refused, JSON.stringify(out.killed));
    assert.strictEqual(out.killed[0].identity.via, 'created');
    assert.strictEqual(out.killed[0].gone, true);
  } finally { if (running(s)) s.kill(); }
});

test('run close: the receipt block keeps a refusal\'s kind, and an unverified row names how to end it by hand', async () => {
  const s = sleeper();
  try {
    const rows = [
      { id: 'w-mis', run_id: 'r1', substrate: 'claude-code', state: 'running', pid: s.pid, pid_created: 1, pid_image: 'node.exe' },
      { id: 'w-unv', run_id: 'r1', substrate: 'claude-code', state: 'running', pid: s.pid, pid_image: 'node.exe', pid_created_error: 'the process snapshot had no creation time' },
    ];
    const out = await closeRunWorkers({ core: coreOf(rows), runId: 'r1', graceMs: 100 });
    const block = workersClosedBlock(out, []);
    const byId = Object.fromEntries(block.killed.map((k) => [k.worker_id, k]));
    assert.strictEqual(byId['w-mis'].kind, 'mismatch', JSON.stringify(block.killed));
    assert.strictEqual(byId['w-unv'].kind, 'unverifiable');
    assert.match(byId['w-unv'].manual, new RegExp(`pid ${s.pid}.*node\\.exe.*Stop-Process -Id ${s.pid}`));
    assert.ok(out.still_alive.find((x) => x.worker_id === 'w-unv').manual, 'still_alive carries the hint for the run\'s failure line');
    assert.strictEqual(running(s), true);
  } finally { s.kill(); }
});

test('worker kill: an unverified live row is refused, and the text names the pid, the image and Stop-Process', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const s = sleeper();
  try {
    const plant = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: 'run-a', pid: process.pid } });
    try {
      await plant.worker.write({ id: 'w1', substrate: 'claude-code', pid: s.pid, pid_image: 'node.exe', pid_created_error: 'the process snapshot had no creation time', state: 'running', turns: 0, started_at: Date.now() });
    } finally { await plant.shutdownOwner(); await plant.close(); }
    const r = spawnSync(process.execPath, [CLI, 'worker', 'kill', 'w1', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    const text = `${r.stdout}${r.stderr}`;
    assert.strictEqual(r.status, 1, text);
    assert.match(text, new RegExp(`pid ${s.pid}`));
    assert.match(text, /node\.exe/);
    assert.match(text, /Task Manager > Details/);
    assert.match(text, new RegExp(`Stop-Process -Id ${s.pid}`));
    assert.strictEqual(running(s), true);
  } finally { s.kill(); await sleep(100); cleanup(dir); }
});
