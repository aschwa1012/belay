'use strict';
// The wake-correlation fix: the parser turns
// the substrate's `command_lifecycle` `completed` into `write_done` for a write it was given a uuid
// for, and pending-writes.cjs answers a write by either route and expires one that neither answers.
// The line shapes below are the ones the real binary emitted in receipts/midturn/stream.jsonl.

const test = require('node:test');
const assert = require('node:assert');
const { createParser } = require('../../src/run/parsers.cjs');
const PW = require('../../src/run/pending-writes.cjs');

const J = (o) => JSON.stringify(o);
const lifecycle = (uuid, state) => J({ type: 'command_lifecycle', command_uuid: uuid, state, session_id: 's' });
const init = J({ type: 'system', subtype: 'init', session_id: 's', mcp_servers: [] });
const result = J({ type: 'result', subtype: 'success', is_error: false, session_id: 's', num_turns: 1, usage: {} });

test('parser: a folded write is answered by its command_lifecycle, and the next init still matches its own write', () => {
  const p = createParser('claude-code');
  const push = (l) => p.pushLine(l);
  const w1 = p.noteStdinWrite('u1');
  push(lifecycle('u1', 'queued')); push(lifecycle('u1', 'started')); push(init);
  const w2 = p.noteStdinWrite('u2'); // arrives mid-turn and is folded: no init of its own
  push(lifecycle('u2', 'queued')); push(lifecycle('u2', 'started'));
  const end = push(result).find((e) => e.kind === 'turn_end');
  assert.strictEqual(end.answers_write, w1);
  const done = [...push(lifecycle('u2', 'completed')), ...push(lifecycle('u1', 'completed'))].filter((e) => e.kind === 'write_done');
  assert.deepStrictEqual(done.map((e) => e.answers_write), [w2, w1]);
  // Without the removal, the folded w2 would be the oldest unanswered write and take w3's init.
  const w3 = p.noteStdinWrite('u3');
  const ready = push(init).find((e) => e.kind === 'ready');
  assert.strictEqual(ready.answers_write, w3);
});

test('parser: lifecycle events for an unknown uuid, or in any state but completed, produce nothing', () => {
  const p = createParser('claude-code');
  p.noteStdinWrite('u1');
  assert.deepStrictEqual(p.pushLine(lifecycle('u1', 'queued')), []);
  assert.deepStrictEqual(p.pushLine(lifecycle('u1', 'started')), []);
  assert.deepStrictEqual(p.pushLine(lifecycle('someone-else', 'completed')), []);
  assert.strictEqual(p.pushLine(lifecycle('u1', 'completed'))[0].kind, 'write_done');
  assert.deepStrictEqual(p.pushLine(lifecycle('u1', 'completed')), [], 'a write completes once');
});

test('pending-writes: answer stamps the wake record once with its route, a second answer is a no-op, and expiry takes only what aged out', () => {
  const rec1 = {}; const rec2 = {};
  const state = { pendingWrites: [
    { index: 1, worker_id: null, at_ms: 0, wakeRecord: null },
    { index: 2, worker_id: 'w1', at_ms: 100, wakeRecord: rec1 },
    { index: 3, worker_id: 'w2', at_ms: 5000, wakeRecord: rec2 },
  ], wakesExpired: [] };
  assert.strictEqual(PW.answer(state, 2, 900, 'command_lifecycle'), true);
  assert.deepStrictEqual(rec1, { answered_at_ms: 900, answered_by: 'command_lifecycle' });
  assert.strictEqual(PW.answer(state, 2, 950, 'init-order'), false);
  assert.deepStrictEqual(rec1, { answered_at_ms: 900, answered_by: 'command_lifecycle' });
  assert.deepStrictEqual(PW.awaitingIds(state, 6000, 2000), ['w2']);
  assert.deepStrictEqual(state.wakesExpired, [{ worker_id: null, written_at_ms: 0, waited_ms: 6000 }]);
  assert.deepStrictEqual(PW.awaitingIds(state, 8000, 2000), []);
  assert.strictEqual(rec2.expired, true);
});
