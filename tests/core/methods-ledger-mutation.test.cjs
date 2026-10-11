'use strict';
// methods-ledger-mutation.test.cjs — claims of methods-ledger.cjs that a mutation run showed no other test pins
// down: a count of zero is a count, the named refusals, and the empty totals of a store with no usage table.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine } = core('engine.cjs');
const { Store } = core('store.cjs');

let dir, store, E;
const orch = callerFor('orchestrator');
const call = (method, args = {}, caller = orch) => E.handle(method, { caller, ...args });
const message = (p, code, re) => assert.rejects(p, (e) => { assert.strictEqual(e.code, code); assert.match(e.message, re); return true; });

before(() => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
});
after(() => { store.close(); cleanup(dir); });

test('zero is a valid count for bytes, turn and tokens, and a negative or fractional one is refused', async () => {
  const ev = await call('memory.recordEvent', { kind: 'observation', bytes: 0, message: 'empty block' });
  assert.strictEqual(ev.bytes, 0);
  await message(call('memory.recordEvent', { kind: 'observation', bytes: -1 }), 'E_ARGS', /bytes must be a non-negative integer/);
  await message(call('memory.recordEvent', { kind: 'observation', bytes: 1.5 }), 'E_ARGS', /bytes/);
  const u = await call('usage.record', { turn: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0, substrate: 'claude-code' });
  assert.deepStrictEqual([u.turn, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens, u.cost_usd], [0, 0, 0, 0, 0, 0]);
  await message(call('usage.record', { turn: -1, cost_usd: 0 }), 'E_ARGS', /turn must be a non-negative integer/);
});

test('an ok event with a code, and a failed event with none, are refused with the reason', async () => {
  await message(call('memory.recordEvent', { kind: 'observation', ok: true, code: 'E_X' }), 'E_ARGS', /an ok event carries no code$/);
  await message(call('memory.recordEvent', { kind: 'observation', ok: false }), 'E_ARGS', /must name the code that failed it/);
  await message(call('memory.recordEvent', { kind: 'wrapup', run_id: 'r1' }), 'E_ARGS', /needs a key/);
  await message(call('memory.recordEvent', { kind: 'nonsense' }), 'E_ARGS', /one of observation/);
  await message(call('memory.recordEvent', { kind: 'observation', row_ids: 'a' }), 'E_ARGS', /row_ids/);
  await message(call('memory.recordEvent', { kind: 'observation', row_ids: [''] }), 'E_ARGS', /row_ids/);
  await message(call('memory.recordEvent', { kind: 'observation', dropped: 2 }), 'E_ARGS', /dropped must be a boolean or 0\/1/);
});

test('a store with no ledger tables answers an empty total for both shapes of usage.list', async () => {
  const d2 = sandbox();
  const s2 = new Store(`${d2}/memory.db`);
  try {
    s2.db.exec('DROP TABLE memory_event; DROP TABLE usage;');
    const E2 = new Engine({ dataDir: d2, store: s2, getEmbedder: null, owner: null, establishedBy: 'test' });
    const empty = { key: null, turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: null, cost_basis_mixed: false };
    const flat = await E2.handle('usage.list', { caller: orch });
    assert.deepStrictEqual(flat, { rows: [], totals: empty, table_absent: true });
    const grouped = await E2.handle('usage.list', { caller: orch, group_by: 'model' });
    assert.deepStrictEqual(grouped, { groups: [], totals: empty, table_absent: true });
  } finally { s2.close(); cleanup(d2); }
});

test('usage.list totals sum tokens, price only the priced rows, and null keys group together', async () => {
  await call('usage.record', { run_id: 'ul', turn: 1, input_tokens: 10, cost_usd: 0.5, substrate: 'claude-code' });
  await call('usage.record', { run_id: 'ul', turn: 2, input_tokens: 5, cost_usd: 0.25, substrate: 'claude-code', model: 'm1' });
  await call('usage.record', { run_id: 'ul', turn: 3, input_tokens: 1, substrate: 'codex', model: 'm1' });
  const flat = await call('usage.list', { run_id: 'ul' });
  assert.strictEqual(flat.totals.turns, 3);
  assert.strictEqual(flat.totals.input_tokens, 16);
  assert.strictEqual(flat.totals.cost_usd, 0.75);
  assert.strictEqual(flat.totals.cost_basis_mixed, true, 'a none row beside dollar rows makes the total partial');
  const byModel = await call('usage.list', { run_id: 'ul', group_by: 'model' });
  const keys = byModel.groups.map((g) => g.key);
  assert.deepStrictEqual(keys, [null, 'm1']);
  assert.strictEqual(byModel.groups[0].cost_basis_mixed, false);
  assert.strictEqual(byModel.groups[1].cost_basis_mixed, true);
  const priced = await call('usage.list', { run_id: 'ul', group_by: 'turn' });
  assert.deepStrictEqual(priced.groups.map((g) => g.key), [1, 2, 3]);
  assert.strictEqual(priced.groups[2].cost_usd, null);
});
