'use strict';
require('../helpers/tmp.cjs');
// run-wait-fix.test.cjs — the review round on the run wait: a worker's life is in the delivery key, a wait's delivery is in the receipt, one
// rule decides whether the run is planned, the digest reads every page of steps, a claim is released with its claimant, a claim error keeps the
// wake, and a wait whose items all went to another path keeps waiting.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunWait } = require('../../src/run/run-wait.cjs');
const { createPlanned } = require('../../src/run/planned.cjs');
const D = require('../../src/run/run-digest.cjs');
const { diffWorkers } = require('../../src/run/wake.cjs');

const RUN = 'r1';
let seqN = 900;
const step = (over = {}) => ({ seq: ++seqN, run_id: RUN, trigger_table: 'task', trigger_id: 'W', trigger_seq: 5, step: 'fix', task_id: 'W', outcome: 'done', row_ref: `task:fix${seqN}`, error: null, worker_id: 'coder', ...over });
const failed = (over = {}) => step({ outcome: 'exception', row_ref: null, error: 'E_ARGS: boom', ...over });
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'belay-rw-fix-')).split(path.sep).join('/');
function fakeCore(steps) {
  const calls = [];
  return {
    calls,
    task: { list: async () => ({ tasks: [] }) },
    integration: { list: async () => ({ integrations: [] }) },
    policy: { list: async (a = {}) => { calls.push(a); return { rows: steps.filter((s) => s.seq > (a.since_seq || 0)).slice(0, a.limit || 500).map((s) => ({ ...s })) }; } },
    memory: { events: async () => ({ events: [] }) },
  };
}
const clock = () => { const c = { t: 1000, sleeps: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; c.sleeps += 1; } }; return c; };
const args = (c, over = {}) => ({ ms: 400, t0: c.t, workers: [], ...over });
const dead = (pid, created, over = {}) => ({ id: 'w1', pid, pidCreated: created, launches: pid, settled: true, settledState: 'dead', state: 'dead', deathEstablishedBy: 'exit', exitCode: 1, exitSignal: null, turns: 3, ...over });
const me = { pid: 4000, created: '10' };

test('a second death of a relaunched worker at the same turn count is delivered: the life is in the key', async () => {
  const dir = dirOf(); const c = clock();
  const rw = createRunWait({ core: fakeCore([]), runId: RUN, dataDir: dir, pollMs: 100, clock: c, claimant: me });
  const first = await rw.wait(args(c, { workers: [dead(11, 5)] }));
  assert.deepStrictEqual(first.exceptions.map((e) => [e.worker_id, e.event, e.turn]), [['w1', 'dead', 3]]);
  const second = await rw.wait(args(c, { workers: [dead(12, 6)] }));
  assert.deepStrictEqual(second.exceptions.map((e) => [e.worker_id, e.event, e.turn]), [['w1', 'dead', 3]], 'the same turn, another life');
  const again = await rw.wait(args(c, { workers: [dead(12, 6)] }));
  assert.strictEqual(again.exceptions, undefined, 'and each life once');
  // The pipe and the headless run key the same death by the row's own process.
  const row = (pid, created) => ({ id: 'w1', run_id: RUN, state: 'dead', turns: 3, seq: 9, pid, pid_created: created });
  const ev = (pid, created) => diffWorkers({ prev: { w1: { turns: 3, state: 'running' } }, rows: [row(pid, created)], runId: RUN, nowMs: 0, graceMs: 0, sinceAt: 0 }).events.find((e) => e.event === 'death');
  assert.strictEqual(D.wakeUid(ev(11, 5)), D.deathUid('w1', 'death', D.lifeOf(11, 5)));
  assert.notStrictEqual(D.wakeUid(ev(11, 5)), D.wakeUid(ev(12, 6)));
});

test('a wait\'s delivery is a receipt entry (via wait, with exception, key, task and trigger) and a release takes it back', async () => {
  const dir = dirOf(); const c = clock();
  const core = fakeCore([failed({ task_id: 'W' })]);
  const rw = createRunWait({ core, runId: RUN, dataDir: dir, pollMs: 100, clock: c, claimant: me });
  const r = await rw.wait(args(c));
  assert.strictEqual(r.exceptions.length, 1);
  const rec = D.readDeliveries(dir, RUN, 500);
  assert.strictEqual(rec.length, 1);
  assert.deepStrictEqual([rec[0].via, rec[0].exception, rec[0].task_id], ['wait', 'E8', 'W']);
  assert.ok(rec[0].key && /^task:/.test(rec[0].trigger), JSON.stringify(rec[0]));
  const d = await rw.wait(args(c, { workers: [dead(11, 5)] }));
  assert.strictEqual(D.readDeliveries(dir, RUN).length, 2, 'a death is a receipt entry too');
  assert.deepStrictEqual(D.readDeliveries(dir, RUN).map((x) => x.exception).sort(), ['E4', 'E8']);
  assert.ok(d.exceptions);
});

test('one rule says whether the run is planned, from the store, and a yes is kept', async () => {
  const tasks = [];
  const runRow = { policy_default: null };
  const core = { run: { get: async () => ({ run: runRow }) }, task: { list: async () => ({ tasks }) } };
  const p = createPlanned({ core, runId: RUN });
  assert.strictEqual(await p.check(), false);
  assert.strictEqual(p.value(), false);
  tasks.push({ id: 'T', run_id: RUN, policy: { fix: 'builder' } }); // a planned task_create
  assert.strictEqual(await p.check(), true);
  tasks.length = 0;
  assert.strictEqual(await p.check(), true, 'kept');
  const viaDefault = createPlanned({ core: { run: { get: async () => ({ run: { policy_default: '{"fix":"builder"}' } }) }, task: { list: async () => ({ tasks: [] }) } }, runId: RUN });
  assert.strictEqual(await viaDefault.check(), true);
  const other = createPlanned({ core: { task: { list: async () => ({ tasks: [{ id: 'X', run_id: 'other', policy: {} }] }) } }, runId: RUN });
  assert.strictEqual(await other.check(), false, 'another run\'s plan is not this run\'s');
});

test('2,001 steps: every one is shown or counted, the last page included', async () => {
  const dir = dirOf(); const c = clock();
  const all = Array.from({ length: 2001 }, (_, i) => ({ seq: i + 1, run_id: RUN, step: 'fix', task_id: 'T', outcome: 'done', row_ref: null, error: null, worker_id: null }));
  const core = fakeCore(all);
  const rw = createRunWait({ core, runId: RUN, dataDir: dir, pollMs: 100, clock: c, claimant: me });
  await rw.wait(args(c, { ms: 100 }));
  const seen = new Set(); let dropped = 0;
  for (const d of D.readDigests(dir, RUN)) { for (const l of d.lines) seen.add(l.step_seq); dropped += d.dropped.count; }
  assert.strictEqual(seen.size + dropped, 2001);
  assert.ok(seen.has(2001), 'the newest is shown');
  assert.deepStrictEqual(core.calls.filter((a) => a.limit === 2000).map((a) => [a.run_id, a.since_seq, a.limit]), [[RUN, 0, 2000], [RUN, 2000, 2000]], 'two pages, the second after the first\'s last seq');
});

test('a claim whose reply was never confirmed and whose adapter is gone is released at the next adapter\'s start; a confirmed one stands', async () => {
  const dir = dirOf(); const c = clock();
  const core = fakeCore([failed({ task_id: 'W' })]);
  const gone = { pid: 999001, created: '77' };
  const rw1 = createRunWait({ core, runId: RUN, dataDir: dir, pollMs: 100, clock: c, claimant: gone });
  const r = await rw1.wait(args(c));
  assert.strictEqual(r.exceptions.length, 1);
  assert.strictEqual(r.digest.steps, 1);
  const keep = createRunWait({ core: fakeCore([failed({ task_id: 'K' })]), runId: RUN, dataDir: dir, pollMs: 100, clock: c, claimant: gone });
  const k = await keep.wait(args(c));
  const kept = k.exceptions[0];
  // K's delivery was written to the client: confirmed.
  D.confirm({ dataDir: dir, runId: RUN, digestN: k.digest.n, uids: D.readDeliveries(dir, RUN).filter((x) => x.task_id === 'K').map((x) => `${x.worker_id}:${x.key}`) });
  const rw2 = createRunWait({ core, runId: RUN, dataDir: dir, pollMs: 100, clock: c, claimant: me, alive: async () => false });
  const freed = await rw2.releaseOrphans();
  assert.ok(freed.uids.length >= 1 && freed.digests.length >= 1, JSON.stringify(freed));
  assert.deepStrictEqual(D.readDigests(dir, RUN).map((d) => d.n), [k.digest.n], 'the confirmed digest stands');
  assert.deepStrictEqual(D.readDeliveries(dir, RUN).map((x) => x.task_id), ['K'], 'and its delivery');
  const again = await rw2.wait(args(c, { ms: 100 }));
  assert.deepStrictEqual(again.exceptions.map((e) => e.task_id), ['W'], 'the lost exception is offered again');
  assert.ok(kept);
  // A live adapter's unconfirmed claim is not touched.
  const live = createRunWait({ core: fakeCore([failed({ task_id: 'L' })]), runId: RUN, dataDir: dir, pollMs: 100, clock: c, claimant: me, alive: async () => true });
  await live.wait(args(c));
  const none = await live.releaseOrphans();
  assert.deepStrictEqual(none, { digests: [], uids: [] });
});

test('a claim that errors keeps the wake as delivered, for the second of three too', async () => {
  const dir = dirOf(); const c = clock();
  const core = fakeCore([failed({ task_id: 'A' }), failed({ task_id: 'B' }), failed({ task_id: 'C' })]);
  const rw = createRunWait({ core, runId: RUN, dataDir: dir, pollMs: 100, clock: c, claimant: me });
  const real = D.claimException; let n = 0;
  D.claimException = (a) => { n += 1; if (n === 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return real(a); };
  try {
    const r = await rw.wait(args(c));
    assert.deepStrictEqual(r.exceptions.map((e) => e.task_id).sort(), ['A', 'B', 'C']);
  } finally { D.claimException = real; }
});

test('items that all went to another path do not end the wait: it carries on to its deadline', async () => {
  const dir = dirOf(); const c = clock();
  const core = fakeCore([failed({ task_id: 'W' })]);
  const probe = (await require('../../src/run/policy-wakes.cjs').createPolicyWatcher({ core, runId: RUN, enabled: true }).poll())[0];
  const uid = `${probe.worker_id}:${probe.key}`;
  // Claimed before the wait polls: the wait does not stop for it.
  assert.ok(D.claimException({ dataDir: dir, runId: RUN, uid }));
  const rw = createRunWait({ core, runId: RUN, dataDir: dir, pollMs: 100, clock: c, claimant: me });
  const r = await rw.wait(args(c));
  assert.strictEqual(r.timed_out, true);
  assert.ok(r.waited_ms >= 400, `waited ${r.waited_ms}`);
  // Claimed between the poll and the claim (after the rows were read): still no early return.
  const dir2 = dirOf(); const c2 = clock();
  const core2 = fakeCore([failed({ task_id: 'W2' })]);
  const probe2 = (await require('../../src/run/policy-wakes.cjs').createPolicyWatcher({ core: core2, runId: RUN, enabled: true }).poll())[0];
  let taken = false;
  const rw2 = createRunWait({ core: core2, runId: RUN, dataDir: dir2, pollMs: 100, clock: c2, claimant: me, hooks: { afterRows: async () => { if (!taken) { taken = true; D.claimException({ dataDir: dir2, runId: RUN, uid: `${probe2.worker_id}:${probe2.key}` }); } } } });
  const r2 = await rw2.wait(args(c2));
  assert.strictEqual(r2.exceptions, undefined);
  assert.strictEqual(r2.timed_out, true);
  assert.ok(r2.waited_ms >= 400, `waited ${r2.waited_ms}`);
});

test('the interactive digest line is short: step, task and outcome, no row or error text', () => {
  const rows = [step({ task_id: 'A' }), failed({ task_id: 'B' })];
  const b = D.build(rows, 221, { head: 'belay: policy steps since the last wake: ', sep: '; ', short: true });
  assert.ok(!/->|E_ARGS|task:fix/.test(b.text), b.text);
  assert.match(b.text, /#\d+ fix A done; #\d+ fix B exception$/);
});

test('the receipt field asks for this run\'s steps by name', async () => {
  const core = fakeCore([step()]);
  await D.receiptField(core, dirOf(), RUN);
  assert.strictEqual(core.calls.find((a) => a.limit === 1).run_id, RUN);
});
