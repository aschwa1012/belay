'use strict';
// call-wake.cjs — a call that ended with an error: a refusal that wrote nothing says so; an unknown outcome (ADR 0033) does not,
// keeps the hold, and wakes again when the store shows the call settled. The bound counts from the detached event's written_at.
const test = require('node:test');
const assert = require('node:assert');

const { createCallWatcher } = require('../../src/run/call-wake.cjs');
const RE = require('../../src/run/release-eval.cjs');

const RUN = 'run-call';
const detached = (key, tool, ids, startedAt, writtenAt) => ({ id: `d-${key}`, seq: 1, kind: 'call_detached', key, ok: 1, row_ids: ids, written_at: writtenAt, message: JSON.stringify({ tool, started_at: startedAt }) });
const ended = (key, ids, extra = {}) => ({ id: `e-${key}`, seq: 2, kind: 'call_ended', key, ok: 1, row_ids: ids, message: '{}', ...extra });

test('a refusal says nothing was written; an unknown outcome says so, holds, and wakes again once the store shows it settled', async () => {
  const unknown = JSON.stringify({ error: 'owner lost', outcome: 'unknown' });
  const evs = [
    detached('r', 'task_evaluate', ['t1'], 1000, 1000), ended('r', ['t1'], { ok: 0, code: 'E_BUSY', message: JSON.stringify({ error: 'queued too long' }) }),
    detached('u', 'task_evaluate', ['t2'], 1000, 1000), ended('u', ['t2'], { ok: 0, code: 'E_OWNER_LOST', message: unknown }),
    detached('v', 'integrate', ['t3'], 1000, 1000), ended('v', ['t3'], { ok: 0, code: 'E_INTERNAL', message: unknown }),
    detached('t', 'task_evaluate', ['t4'], 1000, 1000), ended('t', ['t4'], { ok: 0, code: 'E_TIMEOUT', message: '{}' }),
  ].map((e, i) => ({ ...e, id: `${e.id}-${i}`, seq: i + 1 }));
  let evaluatedAt = 0;
  let integrations = [];
  const core = {
    memory: { events: async () => ({ events: evs }) },
    task: { get: async ({ task_id }) => ({ id: task_id, state: 'open', results: { evaluated_at: task_id === 't4' ? 0 : evaluatedAt, executable: true, passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], passed: false, exit_code: 1 }] } }) },
    integration: { list: async () => ({ integrations }), get: async () => ({ id: 'i9', state: 'merged', passed: true, checks: [] }) },
  };
  let now = 2000;
  const w = createCallWatcher({ core, runId: RUN, now: () => now });
  const wakes = await w.poll();
  const text = (list, id) => list.find((x) => x.worker_id === `call:${id}`).text;
  assert.match(text(wakes, 'r'), /failed: E_BUSY, queued too long; nothing was written/);
  for (const k of ['u', 'v', 't']) {
    assert.match(text(wakes, k), /outcome unknown; read task_list with task_ids/);
    assert.ok(!/nothing was written/.test(text(wakes, k)), text(wakes, k));
  }
  assert.deepStrictEqual(w.holds().sort(), ['call:t', 'call:u', 'call:v'], 'the unknown outcomes keep the hold; the refusal does not');
  assert.deepStrictEqual(await w.poll(), [], 'nothing settled yet, so no second wake');
  evaluatedAt = 3000;
  integrations = [{ id: 'i9', state: 'merged', written_at: 2500, task_ids: ['t3'] }];
  const later = await w.poll();
  assert.match(text(later, 'u'), /task_evaluate of t2 ended: not done/);
  assert.match(text(later, 'v'), /integrate of t3 ended: merged/);
  assert.deepStrictEqual(w.holds(), ['call:t'], 'the settled ones release; the one the store never shows settled still holds');
  now += RE.PENDING_MAX_MS + 1;
  assert.deepStrictEqual(w.holds(), [], 'past the bound the last hold is released');
});

test('the hold is bounded by the detached event written_at, not by a started_at the message names', async () => {
  let now = 5000000;
  const core = { memory: { events: async () => ({ events: [detached('w', 'integrate', ['t1'], 1, 5000000)] }) } }; // the message started_at is long ago
  const w = createCallWatcher({ core, runId: RUN, now: () => now });
  await w.poll();
  assert.deepStrictEqual(w.holds(), ['call:w'], 'the message started_at does not shorten the hold');
  now += RE.PENDING_MAX_MS + 1;
  assert.deepStrictEqual(w.holds(), []);
});
