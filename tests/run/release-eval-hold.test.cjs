'use strict';
// release-eval-hold.test.cjs — ADR 0058 amendment 2: one wake per release. A turn_end whose hand-back is still being evaluated is
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
  assert.match(wakeText(out[0]), /^belay: worker w1 finished turn 1\. task t1 evaluated at release: passed, done\. What it did/);
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
