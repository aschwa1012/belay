'use strict';
// memory-levers.test.cjs — ADR 0041 decision 1: the defaults, the block parser, and leversFor's one cached read.

const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, parseMemoryBlock, leversFor, isDefault } = require('../../src/run/memory-levers.cjs');

function coreWith(memoryLevers, { fail = 0 } = {}) {
  const calls = { n: 0 };
  return {
    calls,
    run: {
      async get() {
        calls.n += 1;
        if (calls.n <= fail) throw new Error('owner busy');
        return { run: memoryLevers === undefined ? null : { memory_levers: memoryLevers }, epochs: [] };
      },
    },
  };
}

test('DEFAULTS: every lever that does something new is off, redaction is on', () => {
  assert.strictEqual(DEFAULTS.redact, true);
  for (const k of ['rules', 'capture', 'observations', 'project_writes', 'cost_ledger', 'first_message_index', 'bottle', 'wrapup', 'knowledge_agent']) {
    assert.strictEqual(DEFAULTS[k], false, k);
  }
  assert.strictEqual(DEFAULTS.summaries, 'off');
  assert.strictEqual(DEFAULTS.project, null);
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.ok(isDefault(parseMemoryBlock(undefined).value));
  assert.ok(isDefault(parseMemoryBlock(null).value));
  assert.ok(!isDefault({ ...DEFAULTS, bottle: true }));
});

test('leversFor: defaults when the row has none or there is no row, and one read is cached per manager', async () => {
  assert.deepStrictEqual(await leversFor(coreWith(null), 'r1'), DEFAULTS);
  assert.deepStrictEqual(await leversFor(coreWith(undefined), 'r1'), DEFAULTS);

  const c = coreWith(JSON.stringify({ ...DEFAULTS, capture: true, observations: true }));
  const [a, b] = await Promise.all([leversFor(c, 'r1'), leversFor(c, 'r1')]);
  assert.strictEqual(a.capture, true);
  assert.strictEqual(a, b, 'concurrent callers share one read');
  await leversFor(c, 'r1');
  assert.strictEqual(c.calls.n, 1, 'read once');
  await leversFor(c, 'r2');
  assert.strictEqual(c.calls.n, 2, 'a different run id is its own read');
});

test('leversFor: a partial stored block is filled with defaults, an unreadable one is the defaults, and a failed read is retried', async () => {
  assert.deepStrictEqual(await leversFor(coreWith(JSON.stringify({ capture: true })), 'r'), { ...DEFAULTS, capture: true });
  assert.deepStrictEqual(await leversFor(coreWith('{not json'), 'r'), DEFAULTS);
  assert.deepStrictEqual(await leversFor(coreWith(JSON.stringify({ observations: true })), 'r'), DEFAULTS, 'an invalid stored block is not half applied');
  const flaky = coreWith(JSON.stringify({ bottle: true }), { fail: 1 });
  await assert.rejects(leversFor(flaky, 'r'), /owner busy/);
  assert.strictEqual((await leversFor(flaky, 'r')).bottle, true, 'the failure was not cached');
});
