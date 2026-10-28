'use strict';
// run-budget-levers.test.cjs — the run's dollar budget lever: spec over config over off, null turns a default off,
// the usage ledger is forced on for a budgeted run only, and a run without a budget has the levers it always had.

const test = require('node:test');
const assert = require('node:assert');
const { parseLevers } = require('../../src/cli/run-levers.cjs');
const { KNOWN_KEYS } = require('../../src/cli/run-spec.cjs');

const cfg = (run) => ({ config: { path: '/p/belay.config.json', memory: undefined, run } });

test('off when absent: no budget keys, no memory levers recorded', () => {
  const l = parseLevers({});
  assert.strictEqual(l.budget_usd, undefined);
  assert.strictEqual(l.memory_levers, undefined);
});

test('the spec key is known, validated, and turns the ledger on', () => {
  assert.ok(KNOWN_KEYS.has('budget_usd'));
  for (const bad of [0, -1, '5', NaN, true]) assert.match(parseLevers({ budget_usd: bad }).error, /budget_usd must be a positive number/);
  const l = parseLevers({ budget_usd: 5 });
  assert.strictEqual(l.budget_usd, 5);
  assert.strictEqual(l.budget_source, 'spec');
  assert.strictEqual(l.memory_levers.cost_ledger, true);
  assert.strictEqual(l.memory_levers.notes, false, 'nothing else about memory changes');
});

test('the config run block is the default, the spec wins, and null turns the default off for one run', () => {
  const c = cfg({ budget_usd: 20 });
  const d = parseLevers({}, c);
  assert.strictEqual(d.budget_usd, 20);
  assert.strictEqual(d.budget_source, '/p/belay.config.json');
  assert.strictEqual(parseLevers({ budget_usd: 3 }, c).budget_usd, 3);
  const off = parseLevers({ budget_usd: null }, c);
  assert.strictEqual(off.budget_usd, undefined);
  assert.strictEqual(off.memory_levers, undefined);
  assert.match(parseLevers({}, cfg({ budget_usd: 'x' })).error, /run\.budget_usd in \/p\/belay\.config\.json/);
});

test('a memory block already on keeps its levers and only gains the ledger', () => {
  const l = parseLevers({ budget_usd: 2, memory: { capture: true, observations: true } });
  assert.strictEqual(l.memory_levers.capture, true);
  assert.strictEqual(l.memory_levers.cost_ledger, true);
});

test('a spec null is recorded as stated, so a restart does not read it as not stated', () => {
  const l = parseLevers({ budget_usd: null }, { config: { path: '/p/belay.config.json', run: { budget_usd: 20 } } });
  assert.strictEqual(l.budget_usd, undefined);
  assert.strictEqual(l.budget_source, 'spec (off)');
});
