'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env);
// turn-rows-lever.test.cjs — the turn_rows lever: a turn row (type 'turn') is written only when it is true; the default writes none.

const test = require('node:test');
const assert = require('node:assert');

const TR = require('../../src/run/turn-record.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');
const { parseMemoryBlock } = require('../../src/core/memory-levers.cjs');

async function turn(levers) {
  const stored = [];
  const ctx = { core: { memory: { store: async (a) => { stored.push(a.type); return { id: 'm' + stored.length }; } } }, shutdownFlags: { closed: false }, memoryLevers: levers };
  const w = { id: 'w1', taskId: 't1', substrate: 'claude-code', pid: 1, turns: 1, costUsd: 0, lastTurnUsage: null, lastAssistantText: 'done' };
  TR.queueMemory(w, { kind: 'turn_end', text: 'done' }, ctx, 4000, null);
  await w.memoryQueue;
  return stored;
}

test('turn_rows is a memory lever that defaults to false', () => {
  assert.strictEqual(DEFAULTS.turn_rows, false);
  assert.strictEqual(parseMemoryBlock({ turn_rows: true }).value.turn_rows, true);
  assert.match(parseMemoryBlock({ turn_rows: 'yes' }).error, /memory\.turn_rows must be true or false/);
});

test('no turn row is written by default, with levers or without', async () => {
  assert.deepStrictEqual(await turn({ ...DEFAULTS }), []);
  assert.deepStrictEqual(await turn(null), []);
});

test('turn_rows true writes the turn row', async () => {
  assert.deepStrictEqual(await turn({ ...DEFAULTS, turn_rows: true }), ['turn']);
});
