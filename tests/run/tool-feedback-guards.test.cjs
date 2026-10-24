'use strict';
// tool-feedback-guards.test.cjs — ADR 0058: the guards of the tool-feedback code, each in isolation, so a mutation of any one fails
// here rather than surviving: the compaction queue's drops, stop_idle_on_done's idleness checks, worker_last_reply's role and cut,
// the release evaluation's filters and start guard, and a cancel that lands while a command is being spawned.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CP = require('../../src/run/compaction.cjs');
const RE = require('../../src/run/release-eval.cjs');
const { stopIfIdleDone } = require('../../src/run/idle-stop.cjs');
const tools = require('../../src/mcp/tools.cjs');
const LR = require('../../src/mcp/last-reply.cjs');
const { runAcceptance } = require('../../src/core/evaluate.cjs');

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `belay-guard-${tag}-`));
const fail = (code, msg, detail) => { throw Object.assign(new Error(msg), { code, detail }); };
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('M6: a relaunch drops a queued message on the record', () => {
  const dir = tmp('relaunch');
  const w = { id: 'w', substrate: 'claude-code', dir, cp: { inflight: { at: Date.now() }, pending: null, hookLines: 0, sent: 1, records: [], sentIdx: new Set() } };
  CP.queueIfCompacting(w, 'held', fail);
  CP.onAttach(w, { compactAt: 100 });
  assert.deepStrictEqual([w.cp.queue.length, w.queuedDropped.length, w.queuedDropped[0].count], [0, 1, 1]);
  assert.match(w.queuedDropped[0].reason, /relaunched/);
  assert.deepStrictEqual(lines(path.join(dir, 'queued-messages.jsonl')).map((r) => r.event), ['queued', 'dropped']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M7: a park during the compaction drops the queue, and writes no row and no message', async () => {
  const dir = tmp('park');
  const writes = [];
  let rows = 0;
  const w = { id: 'w', substrate: 'claude-code', dir, parkRequested: { at: 1 }, child: { stdin: { destroyed: false, write: (l) => writes.push(l) } }, cp: { inflight: null, queue: [{ text: 'held', bytes: 4, at: 1 }] } };
  await CP.afterCompact(w, { compactAt: 100, writeRow: async () => { rows += 1; } }, () => { throw new Error('no turn may start'); });
  assert.deepStrictEqual([w.cp.queue.length, rows, writes.length], [0, 0, 0]);
  assert.match(w.queuedDropped[0].reason, /pause parked/);
  fs.rmSync(dir, { recursive: true, force: true });
});

function idleCase(over = {}, tasks = [], onList = null) {
  const stops = [];
  let lists = 0;
  const w = { id: 'w1', turnEnded: true, settled: false, stopRequested: false, parkRequested: null, queue: Promise.resolve(), ...over };
  const manager = { _worker: (id) => (id === 'w1' ? w : null), stop: async (a) => { stops.push(a); return { worker_id: a.worker_id, graceful: true }; } };
  const ctx = { stopIdleOnDone: true, core: { task: { list: async () => { lists += 1; if (onList) onList(w); return { tasks }; } } } };
  return { stops, lists: () => lists, run: () => stopIfIdleDone(manager, ctx, { id: 't1', state: 'done', handoff: { by: 'w1' } }) };
}

test('M11/M12: stop_idle_on_done stops an idle worker that holds nothing else, and not one mid-turn or holding another lease', async () => {
  const ok = idleCase();
  assert.deepStrictEqual([(await ok.run()).stopped, ok.stops.length], [true, 1]);
  const busy = idleCase({ turnEnded: false });
  const b = await busy.run();
  assert.deepStrictEqual([b.stopped, busy.stops.length], [false, 0]);
  assert.match(b.reason, /not idle/);
  assert.strictEqual(busy.lists(), 0, 'a worker mid-turn is refused before its leases are read');
  // A message that starts a turn while the leases are read: the second check sees it.
  const raced = idleCase({}, [], (w) => { w.turnEnded = false; });
  const rc = await raced.run();
  assert.deepStrictEqual([rc.stopped, raced.stops.length, raced.lists()], [false, 0, 1]);
  assert.match(rc.reason, /not idle/);
  const held = idleCase({}, [{ id: 't2', lease: { holder: 'w1', holder_role: 'worker', expired: false } }]);
  const h = await held.run();
  assert.deepStrictEqual([h.stopped, held.stops.length], [false, 0]);
  assert.match(h.reason, /holds the lease on task t2/);
  const expired = idleCase({}, [{ id: 't2', lease: { holder: 'w1', holder_role: 'worker', expired: true } }]);
  assert.strictEqual((await expired.run()).stopped, true, 'an expired lease is not more work');
});

test('M14: worker_last_reply is the orchestrator\'s alone', () => {
  assert.strictEqual(tools.roleOf('worker_last_reply'), 'orchestrator');
  assert.strictEqual(tools.allows('worker', 'worker_last_reply', 'wk-1'), false);
  assert.strictEqual(tools.allows('orchestrator', 'worker_last_reply'), true);
  assert.ok(!tools.toolsFor('worker').some((t) => t.name === 'worker_last_reply'));
  assert.ok(!tools.toolsFor('worker', { notes: true }).some((t) => t.name === 'worker_last_reply'));
});

test('M15: worker_last_reply cuts a long reply at 4 KB and says so', () => {
  const dir = tmp('reply');
  fs.mkdirSync(path.join(dir, 'workers', 'w1'), { recursive: true });
  const long = 'y'.repeat(5000);
  fs.writeFileSync(path.join(dir, 'workers', 'w1', 'stream.jsonl'), `${JSON.stringify({ type: 'result', result: 'short' })}\n${JSON.stringify({ type: 'result', result: long, subtype: 'success' })}\n`);
  const r = LR.read(dir, 'w1');
  assert.deepStrictEqual([r.found, r.truncated, r.bytes, Buffer.byteLength(r.text, 'utf8')], [true, true, 5000, LR.TEXT_MAX]);
  fs.writeFileSync(path.join(dir, 'workers', 'w1', 'stream.jsonl'), `${JSON.stringify({ type: 'result', result: 'fits' })}\n`);
  assert.deepStrictEqual([LR.read(dir, 'w1').text, LR.read(dir, 'w1').truncated], ['fits', false]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('M16/M21: only a released, not yet evaluated hand-back of this worker in this run is evaluated', () => {
  const t = { run_id: 'r', state: 'released', handoff: { by: 'w1', at: 10 }, results: null };
  assert.ok(RE.unevaluated(t, 'r', 'w1'));
  assert.ok(!RE.unevaluated({ ...t, results: { evaluated_at: 10 } }, 'r', 'w1'), 'evaluated since the hand-back');
  assert.ok(!RE.unevaluated({ ...t, results: { evaluated_at: 11 } }, 'r', 'w1'));
  assert.ok(RE.unevaluated({ ...t, results: { evaluated_at: 9 } }, 'r', 'w1'), 'an evaluation before the hand-back does not count');
  assert.ok(!RE.unevaluated({ ...t, run_id: 'other' }, 'r', 'w1'), 'another run');
  assert.ok(!RE.unevaluated(t, 'r', 'w2'), 'another worker');
  assert.ok(!RE.unevaluated({ ...t, state: 'done' }, 'r', 'w1'));
  assert.ok(!RE.unevaluated({ ...t, handoff: null }, 'r', 'w1'), 'no hand-back');
});

test('M32: startRelease starts nothing while an operation, a park, a stop or the close holds the worker, or with nothing pending', async () => {
  const calls = [];
  const ctx = { runId: 'r', core: { task: { list: async () => ({ tasks: [] }), evaluate: async (a) => { calls.push(a); return { id: a.task_id, state: 'released', results: {} }; } } }, shutdownFlags: {} };
  const base = () => ({ id: 'w1', turns: 1, releaseIds: { turn: 1, ids: ['t1'] }, evaluation: null, op: null, parkRequested: null, stopRequested: false, worktree: '/w' });
  for (const [why, over, c] of [['an operation', { op: { name: 'stop' } }, ctx], ['a park', { parkRequested: { at: 1 } }, ctx], ['a stop', { stopRequested: true }, ctx],
    ['the close', {}, { ...ctx, shutdownFlags: { closing: true } }], ['nothing pending', { releaseIds: null }, ctx], ['a stale turn', { releaseIds: { turn: 0, ids: ['t1'] } }, ctx]]) {
    const w = { ...base(), ...over };
    assert.strictEqual(RE.startRelease(w, c), null, why);
    assert.strictEqual(w.evaluation, null, why);
  }
  const w = base();
  const ev = RE.startRelease(w, ctx);
  assert.ok(ev && w.evaluation === ev);
  await ev.promise;
  assert.deepStrictEqual(calls.map((a) => [a.task_id, a.trigger, a.worktree]), [['t1', 'release', '/w']]);
  assert.strictEqual(w.evaluation, null, 'cleared once it lands');
});

test('M27: a cancel that lands while a command is being spawned kills that command at once', async () => {
  const dir = tmp('spawn-cancel');
  let reads = 0;
  // Not cancelled at the loop's check, cancelled by the time the child exists: the window between the two.
  const cancel = { live: new Set(), by: 'test', get cancelled() { reads += 1; return reads > 1; } };
  const t0 = Date.now();
  const checks = await runAcceptance({ commands: [{ argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'], timeout_ms: 60000 }] }, dir, [], { cancel });
  const ms = Date.now() - t0;
  assert.ok(ms < 15000, `the command ran ${ms} ms: the cancel did not kill it`);
  assert.strictEqual(checks[0].passed, false);
  assert.strictEqual(cancel.live.size, 0, 'the handle is let go once the command ends');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an early cancel starts its evaluation cancelled, and an early cancel whose evaluation never came expires', async () => {
  const EC = require('../../src/core/evaluate-cancel.cjs');
  const r = await EC.evaluateCancel(null, null, { cancel_key: 'k-early', by: 'stop of worker w9' });
  assert.deepStrictEqual([r.cancelled, r.remembered], [false, true]);
  const c = EC.register('k-early');
  assert.deepStrictEqual([c.cancelled, c.by, EC.EARLY.has('k-early')], [true, 'stop of worker w9', false]);
  await EC.evaluateCancel(null, null, { cancel_key: 'k-stale' });
  EC.pruneEarly(Date.now() + EC.EARLY_TTL_MS + 1);
  assert.strictEqual(EC.EARLY.has('k-stale'), false, 'expired');
});

test('a hand-back that will not be evaluated is not announced: notePending says nothing while an operation, a park or a stop holds the worker', async () => {
  const tasks = [{ id: 't1', run_id: 'r', state: 'released', handoff: { by: 'w1', at: 1 }, results: null }];
  const ctx = { runId: 'r', shutdownFlags: {}, core: { task: { list: async () => ({ tasks }), evaluate: async () => ({}) } } };
  for (const over of [{ op: { name: 'stop' } }, { parkRequested: { at: 1 } }, { stopRequested: true }]) {
    const w = { id: 'w1', turns: 2, ...over };
    assert.strictEqual(await RE.notePending(w, ctx), null, JSON.stringify(over));
    assert.strictEqual(w.releaseIds, null);
  }
  const w = { id: 'w1', turns: 2 };
  assert.deepStrictEqual(await RE.notePending(w, ctx), { turn: 2, ids: ['t1'] });
  assert.deepStrictEqual(RE.evalOf(w), { evaluating: ['t1'] }, 'announced, about to start');
});

test('startRelease puts a later hand-back behind the evaluation that runs, and evaluates both in order', async () => {
  let releaseA;
  const aDone = new Promise((r) => { releaseA = r; });
  const order = [];
  const ctx = { runId: 'r', shutdownFlags: {}, core: { task: { list: async () => ({ tasks: [] }), evaluate: async (a) => { order.push(a.task_id); if (a.task_id === 'tA') await aDone; return { id: a.task_id, state: 'done', results: { passed: true, executable: true, checks: [] } }; } } } };
  const w = { id: 'w1', turns: 1, releaseIds: { turn: 1, ids: ['tA'] }, evaluation: null, worktree: '/w' };
  const ev = RE.startRelease(w, ctx);
  w.turns = 2; w.releaseIds = { turn: 2, ids: ['tB'] };
  assert.strictEqual(RE.startRelease(w, ctx), ev, 'joined the running chain');
  assert.deepStrictEqual(RE.evalOf(w), { evaluating: ['tA', 'tB'] });
  releaseA();
  const out = await ev.promise;
  assert.deepStrictEqual([order, out.map((e) => e.task_id), w.turnEvaluatedTurn], [['tA', 'tB'], ['tA', 'tB'], 2]);
  assert.deepStrictEqual(RE.evalOf(w), { evaluated: out });
});
