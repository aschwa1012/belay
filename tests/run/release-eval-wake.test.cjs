'use strict';
// release-eval-wake.test.cjs — ADR 0058 decision 5: the evaluation facts a wake carries fit the interactive wake budget, so the
// mod (src/mod/hooks/wake/core.mjs) never cuts a wake. The budget is the mod's own number, read from the mod, not restated here.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RE = require('../../src/run/release-eval.cjs');
const { wakeText } = require('../../src/run/wake.cjs');

const mod = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'mod', 'hooks', 'wake', 'core.mjs')).href);
const LONG_ID = `w${'x'.repeat(63)}`; // the longest worker id the grammar allows (64 characters)
const UUID = '0b6f4a9e-3c1d-4f7a-9e2b-8d5c6a7f1e30';
const failing = (n) => Array.from({ length: n }, (_, i) => `command node scripts/check-${i}.cjs --all exit ${i + 1}`);
const evs = (k) => Array.from({ length: k }, (_, i) => ({ task_id: `${UUID.slice(0, 30)}-${i}`, state: 'released', failing: failing(4) }));

test('the wake budget is the mod\'s own: WAKE_TEXT_MAX equals maxTextBytes()', async () => {
  const { maxTextBytes } = await mod();
  assert.strictEqual(RE.WAKE_TEXT_MAX, maxTextBytes());
});

test('a turn_end wake with a maximal evaluation clause is not cut by the mod, for a uuid worker id and the longest id', async () => {
  const { capText, byteLength } = await mod();
  for (const worker_id of [UUID, LONG_ID]) {
    for (const evaluated of [evs(1), evs(6)]) {
      const text = wakeText({ worker_id, event: 'turn_end', turn: 99999, evaluated });
      assert.ok(byteLength(text) <= RE.WAKE_TEXT_MAX, `${byteLength(text)} bytes: ${text}`);
      assert.strictEqual(capText(text), text, 'the mod would cut this wake');
      assert.ok(text.startsWith(`belay: worker ${worker_id} finished turn 99999.`), 'the head is never cut');
      assert.ok(text.endsWith(' What it did is in the store: task_list, briefing or memory_search.'), 'the pointer is never cut');
    }
  }
  // With room, the clause is whole; without, it is cut and says so.
  const short = wakeText({ worker_id: 'w1', event: 'turn_end', turn: 1, evaluated: [{ task_id: 't1', state: 'done', failing: [] }] });
  assert.match(short, /task t1 evaluated at release: passed, done\. What it did/);
  assert.match(wakeText({ worker_id: UUID, event: 'turn_end', turn: 3, evaluated: evs(6) }), /\.\.\. What it did/);
});

test('a follow-up evaluated wake with a maximal clause is not cut by the mod', async () => {
  const { capText, byteLength } = await mod();
  const task = { id: `${UUID}`, run_id: 'r', state: 'released', handoff: { by: LONG_ID, at: 1 }, results: { trigger: 'release', evaluated_at: 2, passed: false, executable: true, checks: failing(8).map((x, i) => ({ kind: 'command', argv: ['node', `scripts/check-${i}.cjs`, '--all'], exit_code: i + 1, passed: false })) } };
  const core = { task: { list: async () => ({ tasks: [task] }) } };
  const seen = new Map();
  seen.pending = new Map([[task.id, { worker_id: LONG_ID, since: Date.now() }]]);
  const out = await RE.enrichWakes(core, 'r', [], seen);
  assert.strictEqual(out.length, 1);
  const text = wakeText(out[0]);
  assert.strictEqual(out[0].event, 'evaluated');
  assert.ok(byteLength(text) <= RE.WAKE_TEXT_MAX, `${byteLength(text)} bytes`);
  assert.strictEqual(capText(text), text, 'the mod would cut this wake');
  assert.deepStrictEqual(await RE.enrichWakes(core, 'r', [], seen), [], 'one follow-up only');
});

test('a turn_end wake that names evaluations still running fits the budget, with or without landed results', async () => {
  const { capText, byteLength } = await mod();
  for (const worker_id of [UUID, LONG_ID]) {
    for (const [evaluated, evaluating] of [[undefined, ['t1']], [undefined, Array.from({ length: 12 }, (_, i) => `t${i}`)], [evs(3), ['t9', 't10']]]) {
      const text = wakeText({ worker_id, event: 'turn_end', turn: 99999, evaluated, evaluating });
      assert.ok(byteLength(text) <= RE.WAKE_TEXT_MAX, `${byteLength(text)} bytes: ${text}`);
      assert.strictEqual(capText(text), text);
    }
  }
  assert.match(wakeText({ worker_id: 'w1', event: 'turn_end', turn: 2, evaluating: ['t1'] }), /Evaluating 1 hand-back at release; worker_wait has the result\./);
});

test('the headless idle close holds for a watched evaluation of a live worker of this run, and for nothing else', () => {
  const seen = new Map();
  seen.pending = new Map([['t1', { worker_id: 'w1', since: Date.now() }], ['t2', { worker_id: 'w2', since: Date.now() }], ['t3', { worker_id: 'w3', since: Date.now() }]]);
  const rows = [
    { id: 'w1', run_id: 'r', pid_alive: true, state: 'running' },
    { id: 'w2', run_id: 'r', pid_alive: true, state: 'stopped' },
    { id: 'w3', run_id: 'other', pid_alive: true, state: 'running' },
  ];
  assert.deepStrictEqual(RE.evaluatingHolds(seen, rows, 'r'), ['eval:t1']);
  assert.deepStrictEqual(RE.evaluatingHolds(new Map(), rows, 'r'), []);
});
