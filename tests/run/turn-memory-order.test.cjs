'use strict';
// turn-memory-order.test.cjs — the turn's queued memory work (ADR 0041 decisions 3, 6 and 7) against two races.
// (1) A later turn_end lands while an earlier turn's memory store (an embed) is still in flight: each turn's
// observation and usage row must carry that turn's own numbers, snapshotted when it ended, never the counters
// the record holds by the time the queued work runs. (2) Shutdown closes the flag while a turn store is in
// flight: nothing after it may reach the core (a write would elect a new owner once the old one is stopped), and
// the drop is named on the record.

const test = require('node:test');
const assert = require('node:assert');

const TR = require('../../src/run/turn-record.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function core({ turnStoreMs = 200, ctxRef }) {
  const calls = [];
  let n = 0;
  return {
    calls,
    memory: {
      store: async (a) => {
        calls.push({ m: 'store', type: a.type, turn: a.turn, closed: ctxRef().shutdownFlags.closed });
        if (a.type === 'observation') await sleep(turnStoreMs); // with observations on the observation is the turn's only row
        n += 1;
        return { id: 'm' + n };
      },
      recordEvent: async (a) => { calls.push({ m: 'recordEvent', kind: a.kind, closed: ctxRef().shutdownFlags.closed }); return a; },
      get: async ({ id }) => ({ id, type: 'observation', text: 'x' }),
    },
    usage: { record: async (a) => { calls.push({ m: 'usage', turn: a.turn, out: a.output_tokens, cost: a.cost_usd, closed: ctxRef().shutdownFlags.closed }); return a; } },
    task: { get: async () => { calls.push({ m: 'task.get' }); return { state: 'assigned' }; } },
  };
}

function setup(levers, opts = {}) {
  let ctx;
  const c = core({ ...opts, ctxRef: () => ctx });
  ctx = { core: c, shutdownFlags: { closed: false }, memoryLevers: { ...DEFAULTS, ...levers } };
  const w = { id: 'w1', taskId: 't1', substrate: 'claude-code', pid: 42, turns: 0, costUsd: 0, lastTurnUsage: null };
  return { ctx, c, w };
}

async function drain(w) {
  for (let i = 0; i < 5; i += 1) { await w.memoryQueue; await sleep(20); }
}

test('a turn that ends while the previous turn store is in flight: each turn keeps its own number, usage and cost', async () => {
  const { ctx, c, w } = setup({ capture: true, observations: true, cost_ledger: true });
  w.turns = 1; w.lastTurnUsage = { input_tokens: 10, output_tokens: 111 }; w.costUsd = 0.1; w.lastAssistantText = 'turn one text';
  TR.queueMemory(w, { kind: 'turn_end', text: 'turn one text' }, ctx, 4000, null);
  await sleep(50); // turn 2 ends while turn 1's store is still in flight
  w.turns = 2; w.lastTurnUsage = { input_tokens: 20, output_tokens: 222 }; w.costUsd = 0.3; w.lastAssistantText = 'turn two text';
  TR.queueMemory(w, { kind: 'turn_end', text: 'turn two text' }, ctx, 4000, null);
  await drain(w);
  assert.deepStrictEqual(c.calls.filter((x) => x.m === 'store' && x.type === 'observation').map((x) => x.turn), [1, 2]);
  const usage = c.calls.filter((x) => x.m === 'usage');
  assert.deepStrictEqual(usage.map((u) => [u.turn, u.out]), [[1, 111], [2, 222]], 'one usage row per turn, with that turn\'s tokens');
  assert.strictEqual(usage[0].cost, 0.1);
  assert.ok(Math.abs(usage[1].cost - 0.2) < 1e-9, 'turn 2 is the delta of the cumulative cost, not the whole of it');
  assert.strictEqual(w.lastError, undefined);
});

test('the observation text is the turn\'s own final text even when the record has moved on', async () => {
  const { ctx, c, w } = setup({ capture: true, observations: true });
  const texts = [];
  c.memory.store = async (a) => { if (a.turn === 1) await sleep(100); texts.push([a.turn, a.text]); return { id: 'x' + a.type }; };
  w.turns = 1; w.lastAssistantText = 'ALPHA';
  TR.queueMemory(w, { kind: 'turn_end', text: 'ALPHA' }, ctx, 4000, null);
  w.turns = 2; w.lastAssistantText = 'BRAVO';
  TR.queueMemory(w, { kind: 'turn_end' }, ctx, 4000, null); // no text on the event: the record's text at turn end
  await drain(w);
  assert.strictEqual(texts.length, 2);
  assert.ok(texts[0][1].includes('ALPHA') && !texts[0][1].includes('BRAVO'));
  assert.ok(texts[1][1].includes('BRAVO'));
});

test('shutdown during the turn store: no observation, event or job reaches the core afterwards, and the drop is named', async () => {
  const { ctx, c, w } = setup({ capture: true, observations: true, cost_ledger: true, wrapup: true }, { turnStoreMs: 300 });
  w.turns = 1; w.lastTurnUsage = { output_tokens: 5 }; w.costUsd = 0.01;
  TR.queueMemory(w, { kind: 'turn_end', text: 'hello' }, ctx, 4000, null);
  await sleep(20);
  ctx.shutdownFlags.closed = true; // markClosed; the drain gives up after MEMORY_DRAIN_MS and the owner stops
  await drain(w);
  assert.deepStrictEqual(c.calls.map((x) => x.m), ['store'], 'only the observation store already in flight');
  assert.ok(c.calls.every((x) => x.closed === false), 'nothing was sent after the flag closed');
  assert.strictEqual(w.lastError.where, 'after-shutdown');
});

test('shutdown between the observation and the jobs: the jobs send nothing', async () => {
  const { ctx, c, w } = setup({ capture: true, observations: true, cost_ledger: true });
  c.memory.recordEvent = async (a) => { c.calls.push({ m: 'recordEvent', kind: a.kind, closed: ctx.shutdownFlags.closed }); ctx.shutdownFlags.closed = true; return a; };
  w.turns = 1; w.lastTurnUsage = { output_tokens: 5 }; w.costUsd = 0.01;
  TR.queueMemory(w, { kind: 'turn_end', text: 'hello' }, ctx, 4000, null);
  await drain(w);
  assert.deepStrictEqual(c.calls.map((x) => x.m), ['store', 'recordEvent'], 'no usage row after the flag closed');
  assert.deepStrictEqual(w.lastError, { where: 'after-shutdown', state: 'turn-memory-jobs' });
});
