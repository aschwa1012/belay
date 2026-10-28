'use strict';
// release-eval-hold.test.cjs — ADR 0058 amendment 4: one wake per release. A turn_end whose hand-back is still being evaluated is
// held until the evaluation lands and goes out once, carrying the result; past the hold it goes out saying evaluating and the one
// evaluated wake follows. Another event about the worker sends the held wake first. Fake task lists and a fake clock: no sleeps.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const RE = require('../../src/run/release-eval.cjs');
const { wakeText } = require('../../src/run/wake.cjs');
const { startWakePublisher } = require('../../src/run/wake-pipe.cjs');

const HOLD = 30000;
const released = (id, by = 'w1') => ({ id, run_id: 'r', state: 'released', handoff: { by, at: 10 }, results: null });
const evaluated = (id, state = 'done', by = 'w1', at = 20) => ({ id, run_id: 'r', state, handoff: { by, at: 10 },
  results: { trigger: 'release', evaluated_at: at, passed: state === 'done', executable: true, checks: state === 'done' ? [] : [{ kind: 'command', argv: ['npm', 'test'], exit_code: 1, passed: false }] } });
const coreOf = (s) => ({ task: { list: async () => ({ tasks: s.tasks }) } });
const turnEnd = (worker_id = 'w1', turn = 1) => ({ worker_id, event: 'turn_end', turn, seq: turn });

function harness(tasks) {
  const s = { tasks, t: 1000 };
  const seen = new Map();
  const poll = (events = []) => RE.enrichWakes(coreOf(s), 'r', events, seen, { holdMs: HOLD, now: () => s.t });
  return { s, seen, poll };
}

test('a turn_end held for its evaluation goes out once, with the result, when the evaluation lands', async () => {
  const h = harness([released('t1')]);
  assert.deepStrictEqual(await h.poll([turnEnd()]), [], 'held while the evaluation runs');
  assert.deepStrictEqual(RE.evaluatingHolds(h.seen, [], 'r'), ['wake:w1'], 'a held wake holds the headless close');
  h.s.t += 5000;
  assert.deepStrictEqual(await h.poll(), [], 'still held');
  h.s.tasks = [evaluated('t1')];
  const out = await h.poll();
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].event, 'turn_end');
  assert.match(wakeText(out[0]), /^belay: worker w1 finished turn 1\. task t1 evaluated at release: passed, done\.$/);
  assert.strictEqual(out[0].evaluating, undefined);
  h.s.t += 60000;
  assert.deepStrictEqual(await h.poll(), [], 'no second wake for the same release');
  assert.deepStrictEqual(RE.evaluatingHolds(h.seen, [], 'r'), []);
});

test('past the hold the turn_end goes out saying evaluating, and one evaluated wake follows', async () => {
  const h = harness([released('t1'), released('t2')]);
  assert.deepStrictEqual(await h.poll([turnEnd()]), []);
  h.s.t += HOLD;
  const first = await h.poll();
  assert.deepStrictEqual(first.map((e) => [e.event, e.evaluating]), [['turn_end', ['t1', 't2']]]);
  assert.match(wakeText(first[0]), /Evaluating 2 hand-backs at release; a wake follows with the result\./);
  h.s.tasks = [evaluated('t1'), evaluated('t2', 'released', 'w1', 21)];
  const second = await h.poll();
  assert.strictEqual(second.length, 1, 'both results in one wake');
  assert.deepStrictEqual([second[0].event, second[0].task_ids, second[0].seq], ['evaluated', ['t1', 't2'], 21]);
  assert.match(wakeText(second[0]), /task t1 evaluated at release: passed, done; task t2 evaluated at release: not done; failing: command npm test exit 1/);
  assert.deepStrictEqual(await h.poll(), []);
});

test('another event about the held worker sends the held wake first; other workers are untouched', async () => {
  const h = harness([released('t1'), released('t9', 'w2')]);
  assert.deepStrictEqual(await h.poll([turnEnd('w1'), turnEnd('w2')]), []);
  const death = { worker_id: 'w1', event: 'death', turn: 1, seq: 5 };
  const out = await h.poll([death]);
  assert.deepStrictEqual(out.map((e) => [e.worker_id, e.event, e.evaluating]), [['w1', 'turn_end', ['t1']], ['w1', 'death', undefined]]);
  assert.deepStrictEqual(RE.evaluatingHolds(h.seen, [], 'r'), ['wake:w2'], 'w2 is still held');
  h.s.tasks = [released('t1'), evaluated('t9', 'done', 'w2')];
  assert.deepStrictEqual((await h.poll()).map((e) => [e.worker_id, e.event]), [['w2', 'turn_end']]);
});

test('a hand-back no longer awaiting evaluation (cancelled) frees its held wake at once', async () => {
  const h = harness([released('t1')]);
  assert.deepStrictEqual(await h.poll([turnEnd()]), []);
  h.s.tasks = [{ ...released('t1'), state: 'cancelled' }];
  const out = await h.poll();
  assert.deepStrictEqual(out.map((e) => [e.event, e.evaluated, e.evaluating]), [['turn_end', undefined, undefined]]);
});

test('a failed task read sends every held wake as it is, never drops it', async () => {
  const h = harness([released('t1')]);
  assert.deepStrictEqual(await h.poll([turnEnd()]), []);
  h.s.tasks = null;
  const broken = { task: { list: async () => { throw new Error('owner gone'); } } };
  const out = await RE.enrichWakes(broken, 'r', [], h.seen, { holdMs: HOLD, now: () => h.s.t });
  assert.deepStrictEqual(out.map((e) => e.event), ['turn_end']);
});

test('holdMs reads BELAY_RELEASE_WAKE_HOLD_MS, else 30 s', () => {
  const saved = process.env.BELAY_RELEASE_WAKE_HOLD_MS;
  try {
    delete process.env.BELAY_RELEASE_WAKE_HOLD_MS;
    assert.strictEqual(RE.holdMs(), 30000);
    process.env.BELAY_RELEASE_WAKE_HOLD_MS = '0';
    assert.strictEqual(RE.holdMs(), 0);
    process.env.BELAY_RELEASE_WAKE_HOLD_MS = 'soon';
    assert.strictEqual(RE.holdMs(), 30000);
  } finally { if (saved === undefined) delete process.env.BELAY_RELEASE_WAKE_HOLD_MS; else process.env.BELAY_RELEASE_WAKE_HOLD_MS = saved; }
});

// The interactive publisher holds by default: one wake for a release whose evaluation lands two polls after the turn.
const uniquePipe = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\belay-test-hold-${crypto.randomBytes(5).toString('hex')}`
  : path.join(os.tmpdir(), `belay-test-hold-${crypto.randomBytes(5).toString('hex')}.sock`));

test('the wake publisher sends one wake per release', async () => {
  const s = { rows: [{ id: 'w1', run_id: 'r', state: 'running', turns: 0, seq: 1, pid_alive: true, mid_turn: 0 }], tasks: [], polls: 0 };
  const core = { worker: { list: async () => { s.polls += 1; return { workers: s.rows.map((r) => ({ ...r })) }; } }, task: { list: async () => ({ tasks: s.tasks }) } };
  const pipe = uniquePipe();
  const pub = startWakePublisher({ core, runId: 'r', pipeName: pipe, pollMs: 20 });
  await pub.listening;
  const lines = [];
  const sock = net.connect(pipe);
  let buf = '';
  sock.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  sock.on('error', () => {});
  const until = async (fn) => { for (const end = Date.now() + 10000; Date.now() < end;) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
  try {
    assert.ok(await until(() => s.polls >= 2), 'baseline taken');
    s.tasks = [released('t1')];
    s.rows = [{ ...s.rows[0], turns: 1, seq: 2 }];
    const at = s.polls;
    assert.ok(await until(() => s.polls >= at + 3), 'the turn end seen and held over polls');
    assert.deepStrictEqual(lines.filter((l) => l.id), [], 'nothing sent while the evaluation runs');
    s.tasks = [evaluated('t1')];
    assert.ok(await until(() => lines.some((l) => l.id)), 'the wake goes out once the evaluation lands');
    const later = s.polls;
    assert.ok(await until(() => s.polls >= later + 3));
    const wakes = lines.filter((l) => l.id);
    assert.strictEqual(wakes.length, 1, JSON.stringify(wakes));
    assert.match(wakes[0].text, /finished turn 1\. task t1 evaluated at release: passed, done\./);
  } finally {
    sock.destroy();
    await pub.stop();
  }
});

test('a watched release evaluation of a live worker outlives PENDING_MAX_MS while queued, holds the idle close, then lands and the wake is sent', async () => {
  const h = harness([released('t1')]);
  const live = [{ id: 'w1', run_id: 'r', state: 'idle', pid_alive: true }];
  const poll = (events = []) => RE.enrichWakes(coreOf(h.s), 'r', events, h.seen, { holdMs: HOLD, now: () => h.s.t, workers: live });
  await poll([turnEnd()]);
  h.s.t += HOLD;
  assert.deepStrictEqual((await poll()).map((e) => e.event), ['turn_end']);
  h.s.t += RE.PENDING_MAX_MS * 3; // queued behind several 540 s runs
  assert.deepStrictEqual(await poll(), []);
  assert.deepStrictEqual(RE.evaluatingHolds(h.seen, live, 'r'), ['eval:t1'], 'the headless idle close is still held');
  h.s.tasks = [evaluated('t1')];
  const out = await poll();
  assert.deepStrictEqual(out.map((e) => e.event), ['evaluated']);
  assert.match(wakeText(out[0]), /task t1 evaluated at release: passed, done/);
  assert.deepStrictEqual(RE.evaluatingHolds(h.seen, live, 'r'), []);
});

test('a watched hand-back whose worker is not live is still forgotten past PENDING_MAX_MS', async () => {
  const h = harness([released('t1')]);
  const dead = [{ id: 'w1', run_id: 'r', state: 'dead', pid_alive: false }];
  await RE.enrichWakes(coreOf(h.s), 'r', [turnEnd()], h.seen, { holdMs: 0, now: () => h.s.t, workers: dead });
  h.s.t += RE.PENDING_MAX_MS + 1;
  await RE.enrichWakes(coreOf(h.s), 'r', [], h.seen, { holdMs: 0, now: () => h.s.t, workers: dead });
  assert.strictEqual(h.seen.pending.size, 0);
});

const failedEv = (task_id, code, at = 30, seq = 5, id = `f${seq}`) => ({ id, seq, kind: 'release_failed', ok: 0, code, task_id, worker_id: 'w1', written_at: at });
const coreWithFails = (s) => ({ task: { list: async () => ({ tasks: s.tasks }) }, memory: { events: async () => ({ events: s.fails || [] }) } });
const liveW = [{ id: 'w1', run_id: 'r', state: 'idle', pid_alive: true }];

test('a release evaluation that ended without a result while its worker stays live drops the entry, wakes the orchestrator, and frees the idle close', async () => {
  for (const code of ['E_ARGS', 'E_OWNER_LOST', 'E_TIMEOUT', 'E_GIT']) {
    const s = { tasks: [released('t1')], t: 1000, fails: [] };
    const seen = new Map();
    const poll = (events = []) => RE.enrichWakes(coreWithFails(s), 'r', events, seen, { holdMs: HOLD, now: () => s.t, workers: liveW });
    await poll([turnEnd()]);
    s.t += HOLD;
    assert.deepStrictEqual((await poll()).map((e) => e.event), ['turn_end']);
    s.t += RE.PENDING_MAX_MS * 2;
    assert.deepStrictEqual(await poll(), [], 'still watched: no owner fact yet');
    assert.deepStrictEqual(RE.evaluatingHolds(seen, liveW, 'r'), ['eval:t1']);
    s.fails = [failedEv('t1', code)];
    const out = await poll();
    assert.deepStrictEqual(out.map((e) => e.event), ['evaluated'], code);
    assert.ok(wakeText(out[0]).includes(`task t1 could not be evaluated at release (${code}); call task_evaluate to run it`), wakeText(out[0]));
    assert.deepStrictEqual(RE.evaluatingHolds(seen, liveW, 'r'), [], 'the idle close proceeds');
    assert.deepStrictEqual(await poll(), [], 'one wake only');
  }
});

test('a failure that landed before the turn_end poll rides on the held wake; a failure of an earlier hand-back is ignored; a cancel drops the entry silently', async () => {
  const s = { tasks: [released('t1')], t: 1000, fails: [failedEv('t1', 'E_ARGS', 5, 1)] }; // written before this hand-back (at 10)
  const seen = new Map();
  const poll = (events = []) => RE.enrichWakes(coreWithFails(s), 'r', events, seen, { holdMs: HOLD, now: () => s.t, workers: liveW });
  assert.deepStrictEqual(await poll([turnEnd()]), [], 'the stale failure is not this hand-back\'s');
  s.fails.push(failedEv('t1', 'E_INTERNAL', 12, 2));
  const out = await poll();
  assert.deepStrictEqual(out.map((e) => e.event), ['turn_end']);
  assert.match(wakeText(out[0]), /task t1 could not be evaluated at release \(E_INTERNAL\); call task_evaluate/);
  assert.deepStrictEqual(RE.evaluatingHolds(seen, liveW, 'r'), []);

  const c = { tasks: [released('t2')], t: 1000, fails: [] };
  const seenC = new Map();
  const pollC = (events = []) => RE.enrichWakes(coreWithFails(c), 'r', events, seenC, { holdMs: 0, now: () => c.t, workers: liveW });
  await pollC([turnEnd()]);
  assert.deepStrictEqual(RE.evaluatingHolds(seenC, liveW, 'r'), ['eval:t2']);
  c.fails = [failedEv('t2', 'E_CANCELLED', 20, 3)];
  assert.deepStrictEqual(await pollC(), [], 'a lifecycle cancel is no news');
  assert.deepStrictEqual(RE.evaluatingHolds(seenC, liveW, 'r'), []);
});

test('the run manager records an event naming the code when a release evaluation ends without a result, and for a cancel', async () => {
  const recorded = [];
  const core = { task: { list: async () => ({ tasks: [] }), evaluate: async ({ task_id }) => { throw Object.assign(new Error('owner gone'), { code: 'E_OWNER_LOST' }); } }, memory: { recordEvent: async (a) => { recorded.push(a); return a; } } };
  const w = { id: 'w1', turns: 1, worktree: '/x', releaseIds: { turn: 1, ids: ['t1', 't2'] } };
  const ev = RE.startRelease(w, { core, runId: 'r', shutdownFlags: {} });
  await ev.promise;
  assert.deepStrictEqual(recorded.map((a) => [a.kind, a.ok, a.code, a.task_id, a.worker_id]), [['release_failed', 0, 'E_OWNER_LOST', 't1', 'w1'], ['release_failed', 0, 'E_OWNER_LOST', 't2', 'w1']]);
});
