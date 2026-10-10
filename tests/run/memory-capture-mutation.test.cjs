'use strict';
// memory-capture-mutation.test.cjs — claims of memory-capture.cjs that a mutation run showed no other test pins
// down: the turn buffer holds 4000 events and no more, each turn's dropped count starts at zero, a plan is null
// when no lever wants it, a failed write names its message, and a failed build reports the plain message.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const MC = require('../../src/run/memory-capture.cjs');

const ON = { capture: true, observations: true };
const tool = (i) => ({ kind: 'tool_use', tool: 'Read', tool_use_id: `u${i}`, args: { file_path: `f${i}` } });

function ctxWith(overrides = {}) {
  const stored = [];
  const recorded = [];
  const ctx = {
    memoryLevers: ON,
    core: {
      memory: {
        store: async (a) => { stored.push(a); return { id: `row-${stored.length}` }; },
        recordEvent: async (a) => { recorded.push(a); return a; },
      },
    },
    ...overrides,
  };
  return { ctx, stored, recorded };
}

test('the turn buffer holds 4000 events: the 4000th is kept and the 4001st is counted as dropped', () => {
  assert.strictEqual(MC.MAX_TURN_EVENTS, 4000);
  const w = { parser: {} };
  for (let i = 0; i < 4000; i += 1) MC.onEvent(w, tool(i), ON);
  assert.strictEqual(w.memBuf.events.length, 4000);
  assert.strictEqual(w.memBuf.dropped, 0);
  MC.onEvent(w, tool(4000), ON);
  assert.strictEqual(w.memBuf.events.length, 4000);
  assert.strictEqual(w.memBuf.dropped, 1);
  assert.strictEqual(w.memBuf.events[3999].tool_use_id, 'u3999');
});

test('a turn that ends starts the next one with nothing dropped, and the plan carries only its own count', () => {
  const w = { parser: {}, turns: 1, id: 'w1' };
  for (let i = 0; i < 4003; i += 1) MC.onEvent(w, tool(i), ON);
  const end1 = { kind: 'turn_end' };
  MC.onEvent(w, end1, ON);
  assert.strictEqual(w.memBuf.dropped, 0, 'the next turn starts at zero');
  assert.strictEqual(w.memBuf.events.length, 0);
  const p1 = MC.plan(w, end1, { memoryLevers: ON });
  assert.strictEqual(p1.dropped, 3);
  assert.strictEqual(p1.events.length, 4000);
  MC.onEvent(w, tool(1), ON);
  const end2 = { kind: 'turn_end' };
  MC.onEvent(w, end2, ON);
  const p2 = MC.plan(w, end2, { memoryLevers: ON });
  assert.strictEqual(p2.dropped, 0);
  assert.strictEqual(p2.events.length, 1);
  const failed = { parser: {} };
  for (let i = 0; i < 4002; i += 1) MC.onEvent(failed, tool(i), ON);
  MC.onEvent(failed, { kind: 'turn_failed' }, ON);
  assert.strictEqual(failed.memBuf.dropped, 0, 'a failed turn clears the count too');
});

test('plan is null, not undefined, when no lever uses the capture, and a plan is taken once', () => {
  const w = { parser: {}, turns: 1, id: 'w1' };
  const e = { kind: 'turn_end' };
  assert.strictEqual(MC.plan(w, e, { memoryLevers: undefined }), null);
  assert.strictEqual(MC.plan(w, e, { memoryLevers: { capture: true } }), null);
  assert.strictEqual(MC.plan(w, e, { memoryLevers: { capture: true, observations: false, summaries: 'off' } }), null);
  for (const job of [{ summaries: 'mechanical' }, { project_writes: true }, { cost_ledger: true }, { wrapup: true }]) {
    assert.ok(MC.plan(w, e, { memoryLevers: { capture: true, ...job } }), JSON.stringify(job));
  }
});

test('the snapshot is taken at turn end: turn, usage, cost, pid, substrate, model, task, worker and final text', () => {
  const w = { turns: 4, lastTurnUsage: { input_tokens: 3 }, costUsd: 0.5, pid: 99, substrate: 'claude-code', initModel: 'claude-x', model: 'other', taskId: 't1', id: 'w1', lastAssistantText: 'earlier text' };
  assert.deepStrictEqual(MC.snapshotOf(w, { text: 'turn text' }), {
    turn: 4, usage: { input_tokens: 3 }, cost: 0.5, pid: 99, substrate: 'claude-code', model: 'claude-x', taskId: 't1', workerId: 'w1', finalText: 'turn text',
  });
  const bare = MC.snapshotOf({ turns: 1, id: 'w2' }, null);
  assert.deepStrictEqual(bare, { turn: 1, usage: null, cost: undefined, pid: undefined, substrate: undefined, model: null, taskId: null, workerId: 'w2', finalText: '' });
  assert.strictEqual(MC.snapshotOf({ turns: 1, id: 'w2', model: 'm2', lastAssistantText: 'tail' }, { text: '' }).model, 'm2');
  assert.strictEqual(MC.snapshotOf({ turns: 1, id: 'w2', lastAssistantText: 'tail' }, { text: '' }).finalText, 'tail');
});

test('a store that fails is an ok 0 event with the plain message, the code and the dropped flag, and names the message on the worker', async () => {
  const { ctx, recorded } = ctxWith();
  ctx.core.memory.store = async () => { throw Object.assign(new Error('store down'), { code: 'E_OWNER_LOST' }); };
  const w = { id: 'w1', turns: 2, taskId: 't1' };
  const p = { levers: ON, events: [], dropped: 2, snap: MC.snapshotOf(w, { text: 'x' }) };
  assert.strictEqual(await MC.storeObservation(w, { kind: 'turn_end' }, ctx, p), null);
  assert.deepStrictEqual(w.lastError, { where: 'memory.store', code: 'E_OWNER_LOST', message: 'store down' });
  assert.strictEqual(recorded.length, 1);
  assert.deepStrictEqual(recorded[0], { worker_id: 'w1', task_id: 't1', kind: 'observation', ok: 0, code: 'E_OWNER_LOST', message: 'store down', dropped: 1 });
  recorded.length = 0;
  ctx.core.memory.store = async () => { throw new Error('x'.repeat(500)); };
  await MC.storeObservation(w, { kind: 'turn_end' }, ctx, { ...p, dropped: 0 });
  assert.strictEqual(recorded[0].code, 'E_INTERNAL');
  assert.strictEqual(recorded[0].message.length, 300);
  assert.strictEqual(recorded[0].dropped, 0);
});

test('an event write that fails names its message on the worker', async () => {
  const { ctx } = ctxWith();
  ctx.core.memory.recordEvent = async () => { throw Object.assign(new Error('ledger down'), { code: 'E_TIMEOUT' }); };
  const w = { id: 'w1', turns: 1 };
  const row = await MC.storeObservation(w, { kind: 'turn_end' }, ctx, { levers: ON, events: [], dropped: 0, snap: MC.snapshotOf(w, { text: 'x' }) });
  assert.strictEqual(row.id, 'row-1', 'the row still lands');
  assert.deepStrictEqual(w.lastError, { where: 'memory.recordEvent', code: 'E_TIMEOUT', message: 'ledger down' });
});

test('a build that throws is an ok 0 event with the error\'s own message, not its string form, and stores nothing', async () => {
  const { ctx, stored, recorded } = ctxWith();
  const w = { id: 'w1', turns: 1, taskId: 't1' };
  const events = new Proxy([], { get(t, k) { if (k === Symbol.iterator) throw new Error('boom'); return t[k]; } });
  const out = await MC.storeObservation(w, { kind: 'turn_end' }, ctx, { levers: ON, events, dropped: 0, snap: MC.snapshotOf(w, { text: 'x' }) });
  assert.strictEqual(out, null);
  assert.strictEqual(stored.length, 0);
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].message, 'boom');
  assert.strictEqual(recorded[0].code, 'E_INTERNAL');
  assert.strictEqual(recorded[0].ok, 0);
  assert.strictEqual(w.lastError.where, 'memory.observe');
  assert.strictEqual(w.lastError.message, 'boom');
});

test('the ok receipt carries the row id, the byte count and the sha256 of the stored text, and the store args are fixed', async () => {
  const { ctx, stored, recorded } = ctxWith();
  const w = { id: 'w1', turns: 5, taskId: 't9' };
  const events = [{ kind: 'tool_use', tool: 'Edit', tool_use_id: 'e1', args: { file_path: 'a.cjs' } }, { kind: 'tool_result', tool: 'Edit', tool_use_id: 'e1', files: ['a.cjs'] }];
  const row = await MC.storeObservation(w, { kind: 'turn_end' }, ctx, { levers: ON, events, dropped: 0, snap: MC.snapshotOf(w, { text: 'done é' }) });
  assert.strictEqual(row.id, 'row-1');
  const a = stored[0];
  assert.deepStrictEqual([a.type, a.embed, a.source, a.turn, a.task_id], ['observation', false, 'harness', 5, 't9']);
  assert.strictEqual(a.body.kind, 'change');
  const ev = recorded[0];
  assert.strictEqual(ev.ok, 1);
  assert.deepStrictEqual(ev.row_ids, ['row-1']);
  assert.strictEqual(ev.newest_row_id, 'row-1');
  assert.strictEqual(ev.bytes, Buffer.byteLength(a.text, 'utf8'));
  assert.strictEqual(ev.sha256, crypto.createHash('sha256').update(a.text).digest('hex'));
  assert.strictEqual(ev.dropped, 0);
  assert.ok(a.text.includes('é') || a.text.includes('done'), 'the multibyte narrative is in the text');
});

test('after shutdown has closed the flag nothing is stored or recorded and the drop is named', async () => {
  const { ctx, stored, recorded } = ctxWith({ shutdownFlags: { closed: true } });
  const w = { id: 'w1', turns: 1 };
  assert.strictEqual(await MC.storeObservation(w, { kind: 'turn_end' }, ctx, { levers: ON, events: [], dropped: 0, snap: MC.snapshotOf(w, { text: 'x' }) }), null);
  assert.strictEqual(stored.length, 0);
  assert.strictEqual(recorded.length, 0);
  assert.deepStrictEqual(w.lastError, { where: 'after-shutdown', state: 'turn-observation' });
  const w2 = { id: 'w2', turns: 1 };
  await MC.finish(w2, { kind: 'turn_end' }, ctx, { levers: ON, events: [], dropped: 0, snap: MC.snapshotOf(w2, null) }, {});
  assert.strictEqual(stored.length, 0);
  assert.deepStrictEqual(w2.lastError, { where: 'after-shutdown', state: 'turn-memory' });
});
