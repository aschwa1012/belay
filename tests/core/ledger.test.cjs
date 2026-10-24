'use strict';
// ledger.test.cjs — the memory_event and usage methods (ADR 0041 decisions 3 and 6), called through a
// real Engine over a real owner-stamped store. Registration in engine.cjs belongs to the search work;
// until it lands the test registers the methods with the roles the contract table names, and uses the
// real registration when it exists.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Engine, METHODS } = core('engine.cjs');
const { Store } = core('store.cjs');
const ledger = core('methods-ledger.cjs');

const ALL = ['operator', 'orchestrator', 'worker'];
const WRITERS = ['orchestrator', 'operator'];
const WANT = {
  'memory.recordEvent': { roles: WRITERS, kind: 'write', fn: ledger.recordEvent },
  'memory.events': { roles: ALL, kind: 'read', fn: ledger.events },
  'usage.record': { roles: WRITERS, kind: 'write', fn: ledger.usageRecord },
  'usage.list': { roles: ALL, kind: 'read', fn: ledger.usageList },
};
for (const [name, spec] of Object.entries(WANT)) if (!METHODS[name]) METHODS[name] = spec;

let dir, store, E;
const orch = callerFor('orchestrator');
const operator = callerFor('operator');
const worker = callerFor('worker', { worker_id: 'w-1' });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const refused = (p, code) => assert.rejects(p, e => e.code === code);

before(() => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
});
after(() => { store.close(); cleanup(dir); });

const count = t => store.p(`SELECT COUNT(*) n FROM ${t}`).get().n;

test('recordEvent returns the row it wrote, with identity from the caller and parsed row_ids', async () => {
  const row = await call('memory.recordEvent', orch, {
    kind: 'observation', task_id: 't-1', worker_id: 'w-1', row_ids: ['a', 'b'], newest_row_id: 'b', bytes: 120,
    sha256: 'ff', message: 'ok', written_by: 'evil', run_id: 'run-x',
  });
  assert.match(row.id, /^me-/);
  assert.strictEqual(row.written_by, 'orchestrator');
  assert.strictEqual(row.run_id, 'run-x');
  assert.deepStrictEqual(row.row_ids, ['a', 'b']);
  assert.strictEqual(row.ok, 1);
  assert.strictEqual(row.code, null);
  const [back] = (await call('memory.events', worker, { task_id: 't-1' })).events;
  assert.deepStrictEqual(back, row);
  assert.strictEqual((await call('memory.recordEvent', operator, { kind: 'bottle' })).run_id, 'test-run');
});

test('recordEvent: a failure carries its code, ok and code must agree, and bad arguments write nothing', async () => {
  const bad = await call('memory.recordEvent', orch, { kind: 'summary', code: 'E_SUMMARY_EMPTY', task_id: 't-2' });
  assert.strictEqual(bad.ok, 0);
  assert.strictEqual(bad.code, 'E_SUMMARY_EMPTY');
  const n = count('memory_event');
  await refused(call('memory.recordEvent', orch, { kind: 'summary', ok: false }), 'E_ARGS');
  await refused(call('memory.recordEvent', orch, { kind: 'summary', ok: true, code: 'E_X' }), 'E_ARGS');
  await refused(call('memory.recordEvent', orch, { kind: 'nonsense' }), 'E_ARGS');
  await refused(call('memory.recordEvent', orch, { kind: 'bottle', row_ids: 'a' }), 'E_ARGS');
  await refused(call('memory.recordEvent', orch, { kind: 'bottle', bytes: -1 }), 'E_ARGS');
  await refused(call('memory.recordEvent', orch, { kind: 'wrapup' }), 'E_ARGS');
  assert.strictEqual(count('memory_event'), n);
});

test('recordEvent: a second wrapup for the same (run, key) gives E_EXISTS naming the first, and writes nothing', async () => {
  const first = await call('memory.recordEvent', orch, { kind: 'wrapup', run_id: 'r-w', key: 'task:t-1', bytes: 90 });
  const n = count('memory_event');
  await assert.rejects(call('memory.recordEvent', orch, { kind: 'wrapup', run_id: 'r-w', key: 'task:t-1' }), e => {
    assert.strictEqual(e.code, 'E_EXISTS');
    assert.strictEqual(e.detail.existing.id, first.id);
    return true;
  });
  assert.strictEqual(count('memory_event'), n);
  await call('memory.recordEvent', orch, { kind: 'wrapup', run_id: 'r-w', key: 'run' });
  await call('memory.recordEvent', orch, { kind: 'wrapup', run_id: 'r-w2', key: 'task:t-1' });
  // The index is partial: other kinds repeat freely under the same key.
  await call('memory.recordEvent', orch, { kind: 'summary', run_id: 'r-w', key: 'task:t-1' });
  await call('memory.recordEvent', orch, { kind: 'summary', run_id: 'r-w', key: 'task:t-1' });
});

test('events filters by run, worker, task and kinds, in write order, and validates its arguments', async () => {
  for (const [kind, worker_id, task_id] of [['observation', 'wa', 'ta'], ['summary', 'wa', 'tb'], ['bottle', 'wb', 'ta']]) {
    await call('memory.recordEvent', orch, { kind, worker_id, task_id, run_id: 'r-f' });
  }
  const all = (await call('memory.events', orch, { run_id: 'r-f' })).events;
  assert.deepStrictEqual(all.map(e => e.kind), ['observation', 'summary', 'bottle']);
  assert.strictEqual((await call('memory.events', orch, { run_id: 'r-f', worker_id: 'wa' })).events.length, 2);
  assert.strictEqual((await call('memory.events', orch, { run_id: 'r-f', task_id: 'ta', kinds: ['bottle', 'summary'] })).events.length, 1);
  assert.strictEqual((await call('memory.events', orch, { run_id: 'r-f', limit: 1 })).events.length, 1);
  await refused(call('memory.events', orch, { kinds: [] }), 'E_ARGS');
  await refused(call('memory.events', orch, { kinds: ['nope'] }), 'E_ARGS');
  await refused(call('memory.events', orch, { limit: 0 }), 'E_ARGS');
});

test('role refusals: a worker cannot record an event or a usage row, every role can read', async () => {
  const n = count('memory_event') + count('usage');
  await refused(call('memory.recordEvent', worker, { kind: 'bottle' }), 'E_ROLE');
  await refused(call('usage.record', worker, { substrate: 'codex' }), 'E_ROLE');
  assert.strictEqual(count('memory_event') + count('usage'), n);
  for (const c of [worker, orch, operator]) {
    await call('memory.events', c, {});
    await call('usage.list', c, {});
  }
});

test('usageRecord returns the row, defaults the basis from the substrate and refuses a basis that contradicts the cost', async () => {
  const cl = await call('usage.record', orch, {
    run_id: 'r-u', worker_id: 'w-1', task_id: 't-1', turn: 1, substrate: 'claude-code', model: 'm',
    input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_creation_tokens: 7, cost_usd: 0.5, at: 1234,
  });
  assert.match(cl.id, /^us-/);
  assert.strictEqual(cl.cost_basis, 'delta-of-cumulative');
  assert.strictEqual(cl.at, 1234);
  assert.strictEqual(cl.written_by, 'orchestrator');
  const cx = await call('usage.record', operator, { run_id: 'r-u', turn: 1, substrate: 'codex', input_tokens: 3 });
  assert.strictEqual(cx.cost_basis, 'none');
  assert.strictEqual(cx.cost_usd, null);
  assert.strictEqual(cx.written_by, 'operator');
  const n = count('usage');
  await refused(call('usage.record', orch, { substrate: 'codex', cost_basis: 'none', cost_usd: 1 }), 'E_ARGS');
  await refused(call('usage.record', orch, { substrate: 'claude-code' }), 'E_ARGS');
  await refused(call('usage.record', orch, { substrate: 'gpt' }), 'E_ARGS');
  await refused(call('usage.record', orch, { substrate: 'codex', cost_basis: 'guess' }), 'E_ARGS');
  await refused(call('usage.record', orch, { substrate: 'codex', input_tokens: 1.5 }), 'E_ARGS');
  await refused(call('usage.record', orch, { substrate: 'claude-code', cost_usd: -1 }), 'E_ARGS');
  assert.strictEqual(count('usage'), n);
});

test('usageList groups by task, worker, model and turn with totals, and flags a mixed cost basis', async () => {
  const run_id = 'r-g';
  const rec = a => call('usage.record', orch, { run_id, ...a });
  await rec({ worker_id: 'w1', task_id: 't1', turn: 1, substrate: 'claude-code', model: 'son', input_tokens: 10, output_tokens: 1, cost_usd: 0.25 });
  await rec({ worker_id: 'w1', task_id: 't1', turn: 2, substrate: 'claude-code', model: 'son', input_tokens: 20, output_tokens: 2, cost_usd: 0.5, cost_basis: 'delta-of-cumulative (new process)' });
  await rec({ worker_id: 'w2', task_id: 't2', turn: 1, substrate: 'codex', model: 'gpt', input_tokens: 5, output_tokens: 5 });
  await rec({ worker_id: 'w3', turn: 1, substrate: 'claude-code', model: 'son', input_tokens: 1, cost_usd: 1 });

  const flat = await call('usage.list', worker, { run_id });
  assert.strictEqual(flat.rows.length, 4);
  assert.strictEqual(flat.totals.turns, 4);
  assert.strictEqual(flat.totals.input_tokens, 36);
  assert.strictEqual(flat.totals.cost_usd, 1.75);
  assert.strictEqual(flat.totals.cost_basis_mixed, true, 'a codex row carries no dollars, so the dollar total is partial');

  const byTask = (await call('usage.list', orch, { run_id, group_by: 'task' })).groups;
  const t1 = byTask.find(g => g.key === 't1');
  assert.deepStrictEqual([t1.turns, t1.input_tokens, t1.output_tokens, t1.cost_usd, t1.cost_basis_mixed], [2, 30, 3, 0.75, false],
    'the new-process suffix marks a restart, not a different meaning');
  assert.strictEqual(byTask.find(g => g.key === 't2').cost_usd, null);
  assert.strictEqual(byTask.find(g => g.key === 't2').cost_basis_mixed, false);
  assert.ok(byTask.find(g => g.key === null), 'a row with no task is grouped under a null key, not dropped');

  const byModel = (await call('usage.list', orch, { run_id, group_by: 'model' })).groups;
  assert.strictEqual(byModel.find(g => g.key === 'son').turns, 3);
  assert.strictEqual(byModel.find(g => g.key === 'gpt').turns, 1);
  assert.strictEqual((await call('usage.list', orch, { run_id, group_by: 'worker' })).groups.length, 3);
  const byTurn = (await call('usage.list', orch, { run_id, group_by: 'turn' })).groups;
  assert.deepStrictEqual(byTurn.map(g => [g.key, g.turns]), [[1, 3], [2, 1]]);
  assert.strictEqual((await call('usage.list', orch, { run_id: 'no-such-run' })).totals.turns, 0);
  await refused(call('usage.list', orch, { group_by: 'colour' }), 'E_ARGS');
});

test('reads write nothing: the tables and the database file are untouched by events and usage.list', async () => {
  const fs = require('node:fs');
  const before = [count('memory_event'), count('usage'), fs.statSync(`${dir}/memory.db`).mtimeMs];
  await call('memory.events', orch, {});
  await call('usage.list', orch, { group_by: 'task' });
  assert.deepStrictEqual([count('memory_event'), count('usage'), fs.statSync(`${dir}/memory.db`).mtimeMs], before);
});

test('a store without the tables reads as an empty ledger that says so', async () => {
  const d2 = sandbox();
  const s2 = new Store(`${d2}/memory.db`);
  try {
    s2.db.exec('DROP TABLE memory_event; DROP TABLE usage;');
    const E2 = new Engine({ dataDir: d2, store: s2, getEmbedder: null, owner: null, establishedBy: 'test' });
    assert.deepStrictEqual(await E2.handle('memory.events', { caller: orch }), { events: [], table_absent: true });
    const u = await E2.handle('usage.list', { caller: orch, group_by: 'task' });
    assert.strictEqual(u.table_absent, true);
    assert.deepStrictEqual(u.groups, []);
  } finally { s2.close(); cleanup(d2); }
});

test('recordEvent: a failed wrapup does not block the retry, and only a successful one claims the key', async () => {
  const failed = await call('memory.recordEvent', orch, { kind: 'wrapup', run_id: 'r-retry', key: 'task:t-1', ok: 0, code: 'E_INTERNAL' });
  assert.strictEqual(failed.ok, 0);
  await call('memory.recordEvent', orch, { kind: 'wrapup', run_id: 'r-retry', key: 'task:t-1', ok: 0, code: 'E_INTERNAL' }); // failures repeat
  const good = await call('memory.recordEvent', orch, { kind: 'wrapup', run_id: 'r-retry', key: 'task:t-1' });
  assert.strictEqual(good.ok, 1);
  await assert.rejects(call('memory.recordEvent', orch, { kind: 'wrapup', run_id: 'r-retry', key: 'task:t-1' }), e => {
    assert.strictEqual(e.code, 'E_EXISTS');
    assert.strictEqual(e.detail.existing.id, good.id, 'E_EXISTS names the successful wrap-up, not a failed one');
    return true;
  });
});

test('recordEvent scrubs the message as a stored row is scrubbed, and keeps it as written with the redact lever off', async () => {
  const { SECRET } = require('../run/redact-shim.cjs');
  const said = `verdict holds; token ${SECRET} was in the handoff`;
  const on = await call('memory.recordEvent', orch, { kind: 'wrapup', run_id: 'r-red', key: 'task:t-red', message: said });
  assert.ok(!on.message.includes(SECRET), 'the secret is not stored');
  assert.ok(on.message.startsWith('verdict holds; token ') && on.message.endsWith(' was in the handoff'));
  const off = callerFor('orchestrator', { run_id: 'run-redact-off' });
  await call('run.attach', off, { adapter_pid: process.pid, memory_levers: JSON.stringify({ redact: false }) });
  const kept = await call('memory.recordEvent', off, { kind: 'bottle', ok: false, code: 'E_X', message: said });
  assert.strictEqual(kept.message, said, 'the run asked for text as written');
  assert.strictEqual((await call('memory.recordEvent', orch, { kind: 'bottle' })).message, null, 'no message stays null');
});
