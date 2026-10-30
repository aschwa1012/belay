'use strict';
require('../helpers/tmp.cjs'); // a plain `node --test` of this file keeps its temp dirs out of the real temp dir
// release-eval-forecast.test.cjs — the conflict forecast on the release wake: a passed hand-back whose branch would conflict with the
// integration branch says so, once, inside WAKE_TEXT_MAX; a clean, absent or failing forecast adds nothing and never gates the wake.
// Fake task lists and a fake forecaster: no git, no sleeps. (The forecast itself is tested in tests/core/conflict-forecast.test.cjs.)

const test = require('node:test');
const assert = require('node:assert');

const RE = require('../../src/run/release-eval.cjs');
const { wakeText } = require('../../src/run/wake.cjs');

const done = (id, by = 'w1') => ({ id, run_id: 'r', state: 'done', handoff: { by, at: 10 }, worktree: { repo: '/nowhere', branch: `belay/${id}` },
  results: { trigger: 'release', evaluated_at: 20, passed: true, executable: true, checks: [] } });
const failed = (id) => ({ ...done(id), state: 'open', results: { trigger: 'release', evaluated_at: 20, passed: false, executable: true, checks: [{ kind: 'command', argv: ['npm', 'test'], exit_code: 1, passed: false }] } });
const turnEnd = { worker_id: 'w1', event: 'turn_end', turn: 1, seq: 1 };
const coreOf = (tasks) => ({ task: { list: async () => ({ tasks }) } });
const poll = (tasks, forecaster, seen = new Map()) => RE.enrichWakes(coreOf(tasks), 'r', [turnEnd], seen, { holdMs: 0, forecaster });

test('a conflicting forecast rides on the wake as a short clause, and the whole text stays within WAKE_TEXT_MAX', async () => {
  const files = ['src/very/long/path/to/registry.js', 'lib/timer.js', 'README.md', 'docs/a.md', 'docs/b.md'];
  const [ev] = await poll([done('t1')], async () => ({ files, against: 'abc', ms: 400 }));
  assert.deepStrictEqual(ev.evaluated[0].forecast, { files, against: 'abc', ms: 400 });
  const text = wakeText(ev);
  assert.match(text, /forecast: conflicts with the integration branch in src\/very\/long\/path\/to\/registry\.js, lib\/timer\.js/);
  assert.ok(Buffer.byteLength(text, 'utf8') <= RE.WAKE_TEXT_MAX, `${Buffer.byteLength(text, 'utf8')} bytes: ${text}`);
});

test('the clause is cut before the head or the pointer, even with a long task id', async () => {
  const id = `task-${'x'.repeat(60)}`;
  const [ev] = await poll([done(id)], async () => ({ files: ['a'.repeat(120) + '.js'], against: 'abc', ms: 1 }));
  const text = wakeText(ev);
  assert.ok(Buffer.byteLength(text, 'utf8') <= RE.WAKE_TEXT_MAX, text);
  assert.match(text, /^belay: worker w1 finished turn 1\. task task-x+ evaluated at release: passed, done/);
});

test('a clean forecast, no integration branch, or an unavailable one adds nothing to the text but stays on the summary', async () => {
  const base = wakeText((await poll([done('t1')], async () => null))[0]);
  assert.strictEqual(base, 'belay: worker w1 finished turn 1. task t1 evaluated at release: passed, done.');
  for (const f of [{ clean: true, against: 'abc', ms: 3 }, { against: null, ms: 0 }, { unavailable: 'timed out', against: 'abc', ms: 4000 }]) {
    const [ev] = await poll([done('t1')], async () => f);
    assert.strictEqual(wakeText(ev), base);
    assert.deepStrictEqual(ev.evaluated[0].forecast, f);
  }
});

test('a forecaster that throws, or a hand-back that did not pass, leaves the wake as it was and is never retried to block it', async () => {
  const [ev] = await poll([done('t1')], async () => { throw new Error('git exploded'); });
  assert.strictEqual(wakeText(ev), 'belay: worker w1 finished turn 1. task t1 evaluated at release: passed, done.');
  let calls = 0;
  const [bad] = await poll([failed('t2')], async () => { calls += 1; return { files: ['x'], against: 'a', ms: 1 }; });
  assert.strictEqual(calls, 0, 'only a passed, done hand-back is forecast');
  assert.ok(!/forecast/.test(wakeText(bad)));
});

test('one forecast per evaluation: a later poll of the same landed result does not run it again', async () => {
  const seen = new Map();
  let calls = 0;
  const f = async () => { calls += 1; return { clean: true, against: 'a', ms: 1 }; };
  await poll([done('t1')], f, seen);
  await poll([done('t1')], f, seen);
  assert.strictEqual(calls, 1);
});
