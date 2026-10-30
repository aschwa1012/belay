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
      assert.ok(!text.includes('What it did is in the store'), 'the pointer to a search that finds nothing is gone (wording audit)');
    }
  }
  // With room, the clause is whole; without, it is cut and says so.
  const short = wakeText({ worker_id: 'w1', event: 'turn_end', turn: 1, evaluated: [{ task_id: 't1', state: 'done', failing: [] }] });
  assert.match(short, /task t1 evaluated at release: passed, done\.$/);
  assert.match(wakeText({ worker_id: UUID, event: 'turn_end', turn: 3, evaluated: evs(6) }), /\.\.\.$/);
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
  assert.match(wakeText({ worker_id: 'w1', event: 'turn_end', turn: 2, evaluating: ['t1'] }), /Evaluating 1 hand-back at release; a wake follows with the result\./);
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

test('a refuted review wakes and the worker_wait answer carry the work fix rounds; with UUID ids and a long worker id the fact survives the cut', async () => {
  const { capText, byteLength } = await mod();
  const verdict = { kind: 'verdict', executable: true, passed: false };
  const WORK = '1c2d3e4f-0000-4000-8000-aaaaaaaaaaaa';
  const WID = 'T01-reviewer-1';
  const review = { id: UUID, run_id: 'r', state: 'released', depends_on: [WORK], handoff: { by: WID, at: 1 }, results: { trigger: 'release', evaluated_at: 2, passed: false, executable: true, checks: [verdict, ...failing(3).map((x) => ({ kind: 'command', passed: false, argv: ['node', x], exit_code: 1 }))] } };
  const work = { id: WORK, run_id: 'r', state: 'done', review: { state: 'refuted', rounds: 2, fix_rounds_used: 2, max_fix_rounds: 2 } };
  const core = { task: { list: async () => ({ tasks: [review, work] }) } };
  const seen = new Map(); seen.pending = new Map([[review.id, { worker_id: WID, since: Date.now() }]]);
  const text = wakeText((await RE.enrichWakes(core, 'r', [], seen))[0]);
  assert.match(text, /not done; fix rounds 2 of max 2; failing: /, text);
  assert.ok(byteLength(text) <= RE.WAKE_TEXT_MAX && capText(text) === text, text);
  const capped = { ...work, review: { ...work.review, fix_hard_cap: 5 } };
  const s3 = new Map(); s3.pending = new Map([[review.id, { worker_id: WID, since: Date.now() }]]);
  const withCap = wakeText((await RE.enrichWakes({ task: { list: async () => ({ tasks: [review, capped] }) } }, 'r', [], s3))[0]);
  assert.match(withCap, /fix rounds 2 of max 2, hard cap 5; failing: /, withCap);
  assert.ok(byteLength(withCap) <= RE.WAKE_TEXT_MAX && capText(withCap) === withCap);
  // a run that sets no max_fix_rounds says nothing about rounds
  const none = { ...work, review: { ...work.review, max_fix_rounds: null } };
  const s2 = new Map(); s2.pending = new Map([[review.id, { worker_id: WID, since: Date.now() }]]);
  assert.ok(!/fix rounds/.test(wakeText((await RE.enrichWakes({ task: { list: async () => ({ tasks: [review, none] }) } }, 'r', [], s2))[0])));
  // worker_wait: the turn's own evaluated summary (evalOf, which wait.cjs spreads into its answer) carries the count
  const w = { id: WID, turns: 1, op: null, parkRequested: false, stopRequested: false, worktree: 'C:/x', releaseIds: { turn: 1, ids: [review.id] } };
  const ctx = { runId: 'r', core: { task: { list: async () => ({ tasks: [] }), get: async () => work, evaluate: async () => review } } };
  const ev = RE.startRelease(w, ctx);
  await ev.promise;
  assert.deepStrictEqual(RE.evalOf(w).evaluated[0].fix_rounds, { work: WORK, used: 2, max: 2, hard: null });
});

test('a stand-down reaches the orchestrator once, on the worker\'s turn_end, and is never evaluated', async () => {
  const task = { id: 't9', run_id: 'r', state: 'released', handoff: { result: null, by: 'w1', at: 5, lease_id: 'L', stood_down: 'cannot build here' } };
  assert.ok(!RE.unevaluated(task, 'r', 'w1'), 'no release evaluation for a stand-down');
  const core = { task: { list: async () => ({ tasks: [task] }) } };
  const seen = new Map();
  const [ev] = await RE.enrichWakes(core, 'r', [{ worker_id: 'w1', event: 'turn_end', turn: 2 }], seen);
  assert.deepStrictEqual(ev.evaluated, [{ task_id: 't9', stood_down: 'cannot build here' }]);
  assert.match(wakeText(ev), /task t9: the worker stood down with no result \(cannot build here\); nothing was evaluated\./);
  const [again] = await RE.enrichWakes(core, 'r', [{ worker_id: 'w1', event: 'turn_end', turn: 3 }], seen);
  assert.ok(!again.evaluated, 'said once');
});
