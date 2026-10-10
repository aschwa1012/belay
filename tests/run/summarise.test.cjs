'use strict';
// summarise.test.cjs — the summariser seam (ADR 0041 §4): the mechanical kind, the refusing model kind, the
// classifier, and the one-policy-per-class table.

const test = require('node:test');
const assert = require('node:assert');
const { summarise, classify, POLICY, FIELD_KEYS, MAX_BYTES } = require('../../src/run/summarise.cjs');
const { buildObservation } = require('../../src/run/observe.cjs');

const goodFields = () => ({ asked: 'do x', looked_at: ['a'], learned: 'worker-stated: y', done: { files_modified: [] }, next: '', notes: { errors: 0 } });

test('model kind rejects E_SUMMARISER_ABSENT by name', async () => {
  await assert.rejects(summarise({}, { kind: 'model' }), (e) => e.code === 'E_SUMMARISER_ABSENT' && /ADR 0041/.test(e.message));
  await assert.rejects(summarise({}, { kind: 'bogus' }), (e) => e.code === 'E_ARGS');
});

test('an empty input gives class empty, mechanical generator, no model', async () => {
  for (const input of [undefined, {}, { task: {}, observations: [], checkpoints: [], handoff: null }]) {
    const r = await summarise(input, { kind: 'mechanical' });
    assert.strictEqual(r.output_class, 'empty');
    assert.deepStrictEqual(r.generator, { kind: 'mechanical', version: 1, model: null });
    assert.deepStrictEqual(Object.keys(r.fields), FIELD_KEYS);
  }
  assert.strictEqual((await summarise({})).output_class, 'empty'); // kind defaults to mechanical
});

test('mechanical fields come from the task, observations, checkpoints and handoff', async () => {
  const obs1 = buildObservation({ turn: 1, events: [
    { type: 'tool_use', tool: 'Read', args: { file_path: 'a.cjs' }, tool_use_id: 'r' },
    { type: 'tool_use', tool: 'Bash', args: { command: 'npm test' }, tool_use_id: 'b', command: 'npm test' },
    { type: 'tool_result', tool: 'Bash', tool_use_id: 'b', exit_code: 1, exit_code_source: 'reported', is_error: true },
  ], final_text: 'looked' });
  const obs2 = buildObservation({ turn: 2, events: [
    { type: 'tool_use', tool: 'Edit', args: { file_path: 'b.cjs' }, tool_use_id: 'e' },
  ], final_text: 'edited' });
  const r = await summarise({
    task: { spec: 's'.repeat(500), state: 'done', verdict: 'holds' },
    observations: [{ body: JSON.stringify(obs1.body) }, { body: obs2.body }],
    checkpoints: [{ body: { next_step: 'first' } }],
    handoff: { findings: ['f1', 'f2'], next_step: 'second' },
  }, { kind: 'mechanical' });
  assert.strictEqual(r.output_class, 'ok');
  const f = r.fields;
  assert.strictEqual(Buffer.byteLength(f.asked), 400);
  assert.deepStrictEqual(f.looked_at, ['a.cjs']);
  assert.strictEqual(f.learned, 'worker-stated: f1; f2');
  assert.deepStrictEqual(f.done.files_modified, ['b.cjs']);
  assert.deepStrictEqual(f.done.commands, [{ command: 'npm test', exit_code: 1 }]);
  assert.strictEqual(f.done.task_state, 'done');
  assert.strictEqual(f.next, 'worker-stated: second');
  assert.deepStrictEqual(f.notes, { errors: 1, verdict: 'holds' });
});

test('learned says (not stated) without a worker finding; summary is the fallback', async () => {
  assert.strictEqual((await summarise({ task: { spec: 'x' } })).fields.learned, '(not stated)');
  assert.strictEqual((await summarise({ task: { spec: 'x' }, handoff: { summary: 'S' } })).fields.learned, 'worker-stated: S');
});

test('classify: one result per class', () => {
  assert.strictEqual(classify({ fields: goodFields() }), 'ok');
  for (const bad of [null, undefined, 'text', 7, [], {}, { fields: null }, { fields: [] }, { fields: { asked: 'x' } },
    { fields: { ...goodFields(), looked_at: 'a' } }, { fields: { ...goodFields(), done: null } }, { fields: { ...goodFields(), asked: 4 } }]) {
    assert.strictEqual(classify(bad), 'malformed', JSON.stringify(bad));
  }
  assert.strictEqual(classify({ fields: goodFields(), refused: true }), 'refused');
  assert.strictEqual(classify({ fields: { ...goodFields(), refusal: 'I cannot' } }), 'refused');
  assert.strictEqual(classify({ fields: { asked: '', looked_at: [], learned: '(not stated)', done: { files_modified: [] }, next: '', notes: { errors: 0, verdict: null } } }), 'empty');
  assert.strictEqual(classify({ fields: { ...goodFields(), learned: 'x'.repeat(MAX_BYTES) } }), 'over_budget');
});

test('every output class maps to exactly one policy; only ok stores', () => {
  assert.deepStrictEqual(Object.keys(POLICY).sort(), ['empty', 'malformed', 'ok', 'over_budget', 'refused']);
  assert.deepStrictEqual(POLICY.ok, { store: true, code: null });
  assert.strictEqual(POLICY.empty.code, 'E_SUMMARY_EMPTY');
  assert.strictEqual(POLICY.malformed.code, 'E_SUMMARY_MALFORMED');
  assert.strictEqual(POLICY.refused.code, 'E_SUMMARY_REFUSED');
  assert.strictEqual(POLICY.over_budget.code, 'E_SUMMARY_OVER_BUDGET');
  for (const [cls, p] of Object.entries(POLICY)) assert.strictEqual(p.store, cls === 'ok');
  assert.ok(Object.isFrozen(POLICY) && Object.isFrozen(POLICY.ok));
});

test('the mechanical kind can produce only ok or empty, whatever the input', async () => {
  const hostile = [{ task: 5, observations: 'x', checkpoints: [null, 3], handoff: 'h' }, { observations: [{ body: '{bad' }, null] },
    { handoff: { findings: { a: 1 } } }, { task: { spec: 'x'.repeat(100000) } }];
  for (const input of hostile) assert.ok(['ok', 'empty'].includes((await summarise(input)).output_class));
});

test('no clock and no input mutation', async () => {
  const input = { task: { spec: 'x', state: 'done' }, handoff: { summary: 's' } };
  const snap = JSON.stringify(input);
  const realNow = Date.now;
  try {
    Date.now = () => 1;
    const a = await summarise(input);
    Date.now = () => 9e12;
    const b = await summarise(input);
    assert.deepStrictEqual(a, b);
  } finally { Date.now = realNow; }
  assert.strictEqual(JSON.stringify(input), snap);
});
