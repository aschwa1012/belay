'use strict';
require('../helpers/tmp.cjs'); // a plain `node --test` of this file keeps its temp dirs out of the real temp dir
// release-eval-forecast.test.cjs — the conflict forecast on the release wake. It is started when a hand-back is first watched and never
// awaited: a wake is written at once whatever git is doing, carries the forecast only if it has settled, and runs once per hand-back.
// A passed hand-back's conflict is one short clause inside WAKE_TEXT_MAX, made of whole file names. Fake task lists and a fake
// forecaster: no git, no sleeps. (The forecast itself is tested in tests/core/conflict-forecast.test.cjs.)

const test = require('node:test');
const assert = require('node:assert');

const RE = require('../../src/run/release-eval.cjs');

const wt = (id) => ({ repo: '/nowhere', branch: `belay/${id}` });
const released = (id, by = 'w1') => ({ id, run_id: 'r', state: 'released', handoff: { by, at: 10 }, worktree: wt(id), results: null });
const done = (id, by = 'w1') => ({ ...released(id, by), state: 'done', results: { trigger: 'release', evaluated_at: 20, passed: true, executable: true, checks: [] } });
const failed = (id) => ({ ...done(id), state: 'open', results: { trigger: 'release', evaluated_at: 20, passed: false, executable: true, checks: [{ kind: 'command', argv: ['npm', 'test'], exit_code: 1, passed: false }] } });
const turnEnd = (worker_id = 'w1') => ({ worker_id, event: 'turn_end', turn: 1, seq: 1 });
const settle = () => new Promise((r) => setImmediate(r));
const BASE = 'belay: worker w1\'s hand-back: task t1 evaluated at release: passed, done.';

// One session: the tasks the store lists now, the forecaster, and polls that share `seen`.
function session(tasks, forecaster) {
  const s = { tasks }; const seen = new Map();
  const core = { task: { list: async () => ({ tasks: s.tasks }) } };
  return { s, seen, poll: (events = [turnEnd()]) => RE.enrichWakes(core, 'r', events, seen, { holdMs: 0, forecaster }) };
}
// Watch the hand-back, let its forecast settle, then land the evaluation: the wake that carries the result.
async function landed(id, forecaster, evaluated = done(id)) {
  const h = session([released(id)], forecaster);
  await h.poll(); await settle();
  h.s.tasks = [evaluated];
  const out = await h.poll([]);
  return { h, ev: out.find((e) => e.event === 'evaluated') };
}

test('a conflicting forecast that settled before the evaluation landed rides on the wake, within WAKE_TEXT_MAX', async () => {
  const files = ['src/lib/registry.js', 'lib/timer.js', 'README.md', 'docs/a.md', 'docs/b.md'];
  const { ev } = await landed('t1', async () => ({ files, against: 'abc', ms: 400 }));
  assert.match(ev.text, /task t1 evaluated at release: passed, done; forecast: conflicts with the integration branch in src\/lib\/registry\.js/);
  assert.ok(Buffer.byteLength(ev.text, 'utf8') <= RE.WAKE_TEXT_MAX, `${Buffer.byteLength(ev.text, 'utf8')} bytes: ${ev.text}`);
});

test('the tail is whole file names, then a count: never part of a name, and it gives way before the head', async () => {
  const names = Array.from({ length: 6 }, (_, i) => `packages/some/long/directory/name/file-number-${i}.js`);
  const { ev } = await landed('t1', async () => ({ files: names, against: 'abc', ms: 1 }));
  assert.ok(Buffer.byteLength(ev.text, 'utf8') <= RE.WAKE_TEXT_MAX, ev.text);
  const said = ev.text.match(/packages\/\S*/g) || [];
  assert.ok(said.length >= 1, ev.text);
  for (const m of said) assert.ok(names.includes(m.replace(/[,.;]+$/, '')), `a cut file name: ${m} in ${ev.text}`);
  assert.match(ev.text, /\+\d/);
  const id = `task-${'x'.repeat(120)}`;
  const { ev: long } = await landed(id, async () => ({ files: [`${'a'.repeat(100)}.js`], against: 'abc', ms: 1 }));
  assert.ok(Buffer.byteLength(long.text, 'utf8') <= RE.WAKE_TEXT_MAX, long.text);
  assert.ok(!/a{20}/.test(long.text), `part of a name: ${long.text}`);
});

test('a clean, absent or unavailable forecast adds nothing to the text', async () => {
  assert.strictEqual((await landed('t1', async () => null)).ev.text, BASE);
  for (const f of [{ clean: true, against: 'abc', ms: 3 }, { against: null, ms: 0 }, { unavailable: 'timed out', against: 'abc', ms: 4000 }]) {
    assert.strictEqual((await landed('t1', async () => f)).ev.text, BASE);
  }
});

test('a slow forecast never holds a wake: the poll writes at once whatever the forecaster is doing, and the wake leaves without it', async () => {
  const never = () => new Promise(() => {});
  const h = session([released('t1'), done('t2', 'w2')], never);
  let t0 = Date.now();
  const out = await h.poll([turnEnd('w1'), turnEnd('w2')]);
  assert.ok(Date.now() - t0 < 100, `the poll took ${Date.now() - t0} ms`);
  assert.deepStrictEqual(out.map((e) => e.worker_id).sort(), ['w1', 'w2'], 'an unrelated worker\'s turn_end is not held');
  h.s.tasks = [done('t1'), done('t2', 'w2')];
  t0 = Date.now();
  const next = await h.poll([]);
  assert.ok(Date.now() - t0 < 100);
  assert.strictEqual(next.length, 1);
  assert.strictEqual(next[0].text, BASE);
});

test('a forecaster that throws or rejects leaves the wake as it was; a hand-back that did not pass shows no forecast', async () => {
  for (const f of [async () => { throw new Error('git exploded'); }, () => { throw new Error('sync'); }]) {
    assert.strictEqual((await landed('t1', f)).ev.text, BASE);
  }
  const { ev } = await landed('t2', async () => ({ files: ['x.js'], against: 'a', ms: 1 }), failed('t2'));
  assert.ok(!/forecast/.test(ev.text));
});

test('one forecast per hand-back: later polls do not run it again; at most four run at once', async () => {
  let calls = 0;
  const h = session([released('t1')], async () => { calls += 1; return { clean: true, against: 'a', ms: 1 }; });
  await h.poll(); await h.poll(); await h.poll([]);
  h.s.tasks = [done('t1')];
  await h.poll(); await h.poll();
  assert.strictEqual(calls, 1);
  let started = 0;
  const many = session(Array.from({ length: 7 }, (_, i) => released(`m${i}`, `w${i}`)), () => { started += 1; return new Promise(() => {}); });
  await many.poll(Array.from({ length: 7 }, (_, i) => turnEnd(`w${i}`)));
  assert.strictEqual(started, 4);
});
