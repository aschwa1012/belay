'use strict';
// routing-spawn.test.cjs — the retrieval routing at spawn (ADR 0050 decision 3, ADR 0045): a worker's agent type is written on its row by the
// harness at spawn (never taken from a request) and kept across a relaunch, so the store owner can read the tier a search runs on from the
// row; and `belay run` pins the routing at its start, draining a heavy backlog first under on_heavy_behind wait. A real RunManager over
// tests/run/fakes/fake-claude.cjs and the fake core; no GPU, no model.

require('../helpers/tmp.cjs'); // this file starts processes: its own spawn register (spawn-register-isolation.test.cjs)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const W = require('../../src/run/worker.cjs');
const RR = require('../../src/cli/run-routing.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-routing-spawn-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
};
const mgr = (sb, core) => createRunManager({ core, dataDir: sb.data, runId: 'run-routing-spawn', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });

test('a spawn writes its agent type on the worker row, and a spawn without one writes null', async () => {
  const sb = mk();
  const core = createFakeCore();
  const m = mgr(sb, core);
  try {
    const rev = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-rev', agent_type: 'reviewer' });
    assert.strictEqual(rev.agent_type, 'reviewer');
    const none = await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-none' });
    assert.strictEqual(none.agent_type, null);
    assert.strictEqual((await core.worker.get({ worker_id: 'w-rev' })).agent_type, 'reviewer', 'the store row says it, not only the answer');
    const adopted = await W.adopt({ core, workerId: 'w-rev', dataDir: sb.data });
    assert.strictEqual(adopted.agentType, 'reviewer', 'an adopting adapter keeps the type from the harness row');
    await assert.rejects(m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'w-bad', agent_type: 'orchestrator' }), (e) => e.code === 'E_ARGS', 'a worker cannot be spawned as the orchestrator type');
  } finally { await m.shutdown().catch(() => {}); cleanup(sb.data); }
});

test('every later row of a worker carries its agent type', () => {
  const sb = mk();
  try {
    const w = W.newWorkerRecord({ id: 'w1', substrate: 'claude-code', worktree: sb.worktree, dataDir: sb.data, agentType: 'coder' });
    for (const state of ['starting', 'running', 'stopped']) assert.strictEqual(W.rowOf(w, state, { runId: 'r', adapterPid: process.pid }).agent_type, 'coder', state);
    const none = W.newWorkerRecord({ id: 'w2', substrate: 'claude-code', worktree: sb.worktree, dataDir: sb.data });
    assert.strictEqual(W.rowOf(none, 'running', { runId: 'r', adapterPid: process.pid }).agent_type, null);
  } finally { cleanup(sb.data); }
});

// A core that answers run.pinRouting and memory.drainHeavy from scripts, and records what it was asked.
function pinCore(script) {
  const calls = [];
  const next = (name) => { const q = script[name]; const r = q.length > 1 ? q.shift() : q[0]; if (r instanceof Error) throw r; return r; };
  return { calls, run: { pinRouting: async (a) => { calls.push(['pin', a]); return next('pin'); } }, memory: { drainHeavy: async (a) => { calls.push(['drain', a]); return next('drain'); } } };
}

test('a run with the default levers pins nothing; a routed one does', async () => {
  const core = pinCore({ pin: [{ pinned: true, notices: [] }], drain: [{}] });
  assert.strictEqual(await RR.pinAtStart(core, { levers: { memory_levers: null } }), null);
  assert.strictEqual(await RR.pinAtStart(core, { levers: { memory_levers: { profile: 'cpu-fast' } } }), null);
  assert.deepStrictEqual(core.calls, [], 'nothing was asked of the owner');
  assert.strictEqual(RR.needsPin({ profile: 'cpu-rerank-light' }), true);
  assert.strictEqual(RR.needsPin({ routing: { reviewer: 'gpu-rerank' } }), true);
  const r = await RR.pinAtStart(core, { levers: { memory_levers: { profile: 'cpu-rerank-light' } } });
  assert.strictEqual(r.pinned, true);
  assert.strictEqual(core.calls.length, 1);
});

test('on_heavy_behind wait: the start drains the backlog with progress, then pins, before any agent', async () => {
  const behind = [{ embedder: 'Qwen/Qwen3-Embedding-4B-GGUF', rows: 5, namespaces: ['project/p', 'run/r'] }];
  const core = pinCore({
    pin: [{ pinned: false, action: 'drain', behind, notices: [] }, { pinned: true, action: 'pinned', notices: [], routing: { run: {} } }],
    drain: [{ total: 5, written: 3, remaining: 2, done: false, ms: 10 }, { total: 2, written: 2, remaining: 0, done: true, ms: 5 }],
  });
  const lines = [];
  const r = await RR.pinAtStart(core, { levers: { memory_levers: { profile: 'gpu-balanced' } }, write: (m) => lines.push(m) });
  assert.strictEqual(r.pinned, true);
  assert.deepStrictEqual(core.calls.map(c => c[0]), ['pin', 'drain', 'drain', 'pin'], 'pin, drain until done, pin again');
  assert.deepStrictEqual(core.calls[1][1], { model: behind[0].embedder, namespaces: behind[0].namespaces });
  assert.ok(lines.some(l => /5 notes behind.*embedding them before the run starts/.test(l)), lines.join(''));
  assert.ok(lines.some(l => /3 of 5 embedded this pass, 2 left/.test(l)) && lines.some(l => /2 of 2 embedded this pass, 0 left/.test(l)), 'progress per pass');
});

test('a drain that makes no progress stops the start by name, and a notice is written once', async () => {
  const behind = [{ embedder: 'Qwen/Qwen3-Embedding-4B-GGUF', rows: 5, namespaces: ['project/p'] }];
  const stuck = pinCore({ pin: [{ pinned: false, action: 'drain', behind, notices: [] }], drain: [{ total: 5, written: 0, remaining: 5, done: false, ms: 1 }] });
  await assert.rejects(RR.pinAtStart(stuck, { levers: { memory_levers: { profile: 'gpu-balanced' } } }), /did not shrink.*belay memory embed --model Qwen\/Qwen3-Embedding-4B-GGUF/);
  const notice = { code: 'gpu_probe_refused', message: 'the GPU probe refused this run routing (no_gpu)' };
  const noisy = pinCore({ pin: [{ pinned: true, action: 'pinned', notices: [notice], routing: { run: {} } }], drain: [{}] });
  const lines = [];
  await RR.pinAtStart(noisy, { levers: { memory_levers: { profile: 'gpu-balanced' } }, write: (m) => lines.push(m) });
  assert.deepStrictEqual(lines.filter(l => /notice/.test(l)), ['belay: notice (gpu_probe_refused): the GPU probe refused this run routing (no_gpu)\n']);
});

const BEHIND = [{ embedder: 'Qwen/Qwen3-Embedding-4B-GGUF', rows: 4, namespaces: ['project/p'] }];
const LEVERS = (extra = {}) => ({ memory_levers: { profile: 'gpu-balanced', ...extra } });
const boom = () => Object.assign(new Error('the GPU process exited with exit code 3'), { code: 'E_MODEL_ABSENT' });

test('B2: a GPU failure during the start-wait drain under on_heavy_failure fallback pins the demoted routing with ONE notice and starts', async () => {
  const core = pinCore({
    pin: [{ pinned: false, action: 'drain', behind: BEHIND, notices: [] }, { pinned: true, action: 'pinned', routing: { run: { profile: 'custom' } }, notices: [{ code: 'heavy_drain_failed', message: 'the embedder failed while draining' }] }],
    drain: [boom()],
  });
  const lines = [];
  const r = await RR.pinAtStart(core, { levers: LEVERS(), write: (m) => lines.push(m) });
  assert.strictEqual(r.pinned, true);
  assert.deepStrictEqual(core.calls.map(c => c[0]), ['pin', 'drain', 'pin']);
  assert.strictEqual(core.calls[2][1].drain_failed[0].embedder, BEHIND[0].embedder, 'the owner is told which drain failed');
  assert.strictEqual(core.calls[2][1].drain_failed[0].code, 'E_MODEL_ABSENT');
  assert.strictEqual(lines.filter(l => /notice \(heavy_drain_failed\)/.test(l)).length, 1, 'one notice');
});

test('B2: under on_heavy_failure pause the same failure refuses the start with a message naming the pin, not the attach', async () => {
  const core = pinCore({ pin: [{ pinned: false, action: 'drain', behind: BEHIND, notices: [] }], drain: [boom()] });
  await assert.rejects(RR.pinAtStart(core, { levers: LEVERS({ on_heavy_failure: 'pause' }) }), (e) => /failed while draining its backlog/.test(e.message) && /on_heavy_failure is pause, so the run was not started/.test(e.message) && !/attach/.test(e.message));
  assert.deepStrictEqual(core.calls.map(c => c[0]), ['pin', 'drain'], 'nothing was pinned');
});

test('S7: under --json (no write sink) every start-up line is kept in start_progress for the receipt', async () => {
  const core = pinCore({
    pin: [{ pinned: false, action: 'drain', behind: BEHIND, notices: [] }, { pinned: true, action: 'pinned', routing: { run: {} }, notices: [] }],
    drain: [{ total: 4, written: 4, remaining: 0, done: true, ms: 5 }],
  });
  const r = await RR.pinAtStart(core, { levers: LEVERS(), write: null });
  assert.ok(r.start_progress.some(l => /embedding them before the run starts/.test(l)));
  assert.ok(r.start_progress.some(l => /4 of 4 embedded this pass/.test(l)));
});
