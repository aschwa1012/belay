'use strict';
// close-stages-wiring.test.cjs — what run close hands the stages, the reserved job ids, the harness-channel roles the stages' child
// needs, and the lever checks.

const { test } = require('node:test');
const assert = require('node:assert');
const { runCloseStages } = require('../../src/cli/run-close-stages.cjs');
const { isJobId } = require('../../src/run/job-prefixes.cjs');
const { toolsFor, validateArgs } = require('../../src/mcp/tools.cjs');
const { parseMemoryBlock, DEFAULTS, TYPES } = require('../../src/core/memory-levers.cjs');
const { Engine } = require('../../src/core/engine.cjs');
const { Store } = require('../../src/core/store.cjs');
const { callerFor } = require('../core/helpers.cjs');

test('runCloseStages: notes off loads nothing; notes on hands the stages the harness view and the run\'s facts', async () => {
  const boom = { closeStages: () => assert.fail('no stage with notes off') };
  assert.strictEqual(await runCloseStages({ core: {}, runId: 'r', levers: { memory_levers: { notes: false } }, dataDir: 'd', stages: boom }), null);
  assert.strictEqual(await runCloseStages({ core: {}, runId: 'r', levers: {}, dataDir: 'd', stages: boom }), null);
  const harness = { harness: true };
  let seen;
  const out = await runCloseStages({ core: { harness: () => harness }, runId: 'r1', levers: { memory_levers: { notes: true } }, dataDir: 'd', worktree: 'w', goal: 'g', stages: { closeStages: async (a) => { seen = a; return { ok: 1 }; } } });
  assert.deepStrictEqual(out, { ok: 1 });
  assert.deepStrictEqual([seen.core, seen.runId, seen.worktree, seen.goal, seen.levers.notes], [harness, 'r1', 'w', 'g', true]);
});

test('job ids: the scrubber and the reviewer are reserved, get no belay tool, and cannot be spawned by a model', () => {
  for (const id of ['notereview-t1', 'scrub-r1-x', 'archreview-r1-x']) assert.ok(isJobId(id), id);
  for (const id of ['w1', 'scrubber', 'review-1', null, 3]) assert.ok(!isJobId(id), String(id));
  const bare = toolsFor('worker', { workerId: 'notereview-t1' });
  assert.deepStrictEqual(toolsFor('worker', { workerId: 'scrub-r1-x' }), bare);
  assert.deepStrictEqual(toolsFor('worker', { workerId: 'archreview-r1-x' }), bare);
  assert.ok(toolsFor('worker', { workerId: 'w1' }).length > bare.length);
  for (const id of ['scrub-x', 'archreview-x']) {
    assert.throws(() => validateArgs('worker_spawn', { substrate: 'claude-code', worktree: '/w', prompt: 'p', worker_id: id }), (e) => e.code === 'E_ARGS' && /reserved/.test(e.message), id);
  }
});

test('levers: the stage levers parse, are typed, and refuse bad values and non-5.5 models', () => {
  assert.strictEqual(parseMemoryBlock({}).value.review_cost_cap_usd, 2);
  for (const [k, v] of [['scrub_wall_s', 0], ['scrub_cost_cap_usd', 0], ['scrub_cost_cap_usd', 99], ['review_min_held', 0], ['review_max_age_runs', 1.5], ['review_wall_s', 'x'], ['review_cost_cap_usd', -1], ['scrub_model', 'claude-haiku-4-5'], ['archive_review_model', 'gpt-5'], ['scrub_model', 7]]) {
    assert.match(parseMemoryBlock({ [k]: v }).error, new RegExp(`memory.${k}`), `${k}=${v}`);
  }
  assert.strictEqual(parseMemoryBlock({ scrub_model: 'claude-sonnet-5-5', archive_review_model: 'claude-opus-5-5' }).error, undefined);
  for (const k of ['scrub_wall_s', 'scrub_cost_cap_usd', 'scrub_model', 'review_min_held', 'review_max_age_runs', 'review_wall_s', 'review_cost_cap_usd', 'archive_review_model']) assert.ok(TYPES[k] && k in DEFAULTS, k);
  assert.deepStrictEqual([DEFAULTS.archive_review_auto, TYPES.archive_review_auto.type], [false, 'boolean']);
  assert.match(parseMemoryBlock({ archive_review_auto: 'yes' }).error, /archive_review_auto must be true or false/);
  assert.match(parseMemoryBlock({ archive_review_auto: true }).error, /needs memory.notes/);
  assert.strictEqual(parseMemoryBlock({ project: 'p', notes: true, archive_review_auto: true }).value.archive_review_auto, true);
});

test('harness roles: the run process (operator) may write a job worker row on the harness channel only', async () => {
  const store = new Store(':memory:');
  const E = new Engine({ dataDir: '.', store, getEmbedder: null, owner: null, establishedBy: 'test' });
  try {
    const op = callerFor('operator', { run_id: 'r1' });
    const row = { id: 'scrub-r1-1', substrate: 'claude-code', pid: process.pid, state: 'running', last_event_at: Date.now() };
    await assert.rejects(E.handle('worker.write', { caller: op, ...row }), (e) => e.code === 'E_ROLE');
    await assert.rejects(E.handle('worker.write', { caller: callerFor('operator', { run_id: 'r1', channel: 'tool' }), ...row }), (e) => e.code === 'E_ROLE');
    await assert.rejects(E.handle('worker.write', { caller: callerFor('worker', { run_id: 'r1', worker_id: 'w1', channel: 'harness' }), ...row }), (e) => e.code === 'E_ARGS' || e.code === 'E_ROLE');
    await E.handle('run.attach', { caller: callerFor('operator', { run_id: 'r1' }), adapter_pid: process.pid });
    const w = await E.handle('worker.write', { caller: callerFor('operator', { run_id: 'r1', channel: 'harness' }), ...row });
    assert.strictEqual(w.id, 'scrub-r1-1');
  } finally { store.close(); }
});

test('harness guard: an operator on the harness channel may write only job rows of its own run', async () => {
  const store = new Store(':memory:');
  const E = new Engine({ dataDir: '.', store, getEmbedder: null, owner: null, establishedBy: 'test' });
  try {
    const h = (run) => callerFor('operator', { run_id: run, channel: 'harness' });
    const row = (id, extra = {}) => ({ id, substrate: 'claude-code', pid: process.pid, state: 'running', last_event_at: Date.now(), ...extra });
    for (const r of ['r1', 'r2']) await E.handle('run.attach', { caller: callerFor('operator', { run_id: r }), adapter_pid: process.pid });
    for (const id of ['scrub-r1-a', 'archreview-r1-a', 'notereview-t1']) assert.strictEqual((await E.handle('worker.write', { caller: h('r1'), ...row(id) })).id, id, id);
    for (const id of ['w-ordinary', 'scrubber', 'knowledge-x']) await assert.rejects(E.handle('worker.write', { caller: h('r1'), ...row(id) }), (e) => e.code === 'E_ROLE', id);
    await assert.rejects(E.handle('worker.write', { caller: h('r1'), ...row('scrub-r2-a', { run_id: 'r2' }) }), (e) => e.code === 'E_ROLE', 'another run named in the row');
    await assert.rejects(E.handle('worker.write', { caller: h('r2'), ...row('scrub-r1-a') }), (e) => e.code === 'E_ROLE', 'a job row that belongs to another run');
    await assert.rejects(E.handle('continuity.checkpoint', { caller: h('r1'), worker_id: 'scrub-r1-a', summary: 'x' }), (e) => e.code === 'E_ROLE', 'no checkpoint grant');
    await assert.rejects(E.handle('worker.write', { caller: callerFor('operator', { run_id: 'r1' }), ...row('scrub-r1-b') }), (e) => e.code === 'E_ROLE', 'not on the tool channel');
  } finally { store.close(); }
});
