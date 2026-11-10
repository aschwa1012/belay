'use strict';
require('../helpers/tmp.cjs');
// run-wait.test.cjs — ADR 0074 decisions 2 and 3: under a plan, worker_wait with no worker named waits for the run. It returns at the first
// exception or at its bound, carries the digest of belay's own steps since the last wait (capped at 2 KB, the drop counted), and puts each
// exception and each step in exactly one place. A clock with no timers drives it: no sleeps, no load, the order of events is the test's.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunWait, boundOf, POLICY_WAIT_DEFAULT_MS } = require('../../src/run/run-wait.cjs');
const D = require('../../src/run/run-digest.cjs');
const { createWait } = require('../../src/run/wait.cjs');

const RUN = 'r1';
const B = (s) => Buffer.byteLength(s, 'utf8');

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'belay-run-wait-')).replace(/\\/g, '/');
}

// The store's policy_step rows, as a core reads them. `steps` is the test's to change between calls.
function fakeCore(steps = []) {
  const calls = [];
  return {
    steps, calls,
    task: { list: async () => { calls.push('task.list'); return { tasks: [] }; } },
    integration: { list: async () => { calls.push('integration.list'); return { integrations: [] }; } },
    policy: { list: async () => { calls.push('policy.list'); return { rows: steps.map((s) => ({ ...s })), last_seq: steps.length }; } },
    memory: { events: async () => ({ events: [] }) },
  };
}
let seqN = 0;
const step = (over = {}) => ({ seq: ++seqN, run_id: RUN, step: 'fix', task_id: 'W', outcome: 'done', row_ref: `task:fix${seqN}`, error: null, worker_id: 'coder', ...over });
const failed = (over = {}) => step({ outcome: 'exception', row_ref: null, error: 'E_ARGS: boom', ...over });

// A clock that never waits: a sleep moves time forward and then lets the test act (`onSleep`) before the wait looks again.
function clock(onSleep = async () => {}) {
  const c = { t: 1000, sleeps: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; c.sleeps += 1; await onSleep(c); } };
  return c;
}
const make = (core, dataDir, over = {}) => createRunWait({ core, runId: RUN, dataDir, pollMs: 100, ...over });
const args = (c, over = {}) => ({ ms: 5000, t0: c.t, workers: [], ...over });

test('the bound: the default is today\'s 110 s, and MCP_TOOL_TIMEOUT less 10 s caps any request', () => {
  assert.strictEqual(POLICY_WAIT_DEFAULT_MS, 110000);
  assert.deepStrictEqual(boundOf(undefined, {}), { ms: 110000, capNote: null });
  assert.deepStrictEqual(boundOf(600000, { MCP_TOOL_TIMEOUT: '120000' }), { ms: 110000, capNote: { timeout_capped: { requested_ms: 600000, used_ms: 110000, by: 'MCP_TOOL_TIMEOUT 120000 ms less a 10,000 ms margin' } } });
  assert.strictEqual(boundOf(110000, { MCP_TOOL_TIMEOUT: '12000' }).ms, 2000);
  assert.strictEqual(boundOf(110000, { MCP_TOOL_TIMEOUT: '5000' }).ms, 1000, 'at least 1,000 ms');
  assert.strictEqual(boundOf(110000, { MCP_TOOL_TIMEOUT: 'soon' }).ms, 110000, 'a non-numeric variable changes nothing');
});

test('a wait with no plan is unchanged: the policy wait is never asked, and nothing is read from the core', async () => {
  const core = fakeCore([failed()]);
  let asked = 0;
  const rw = { active: () => { asked += 1; return false; }, wait: async () => { throw new Error('must not run'); } };
  const w = { id: 'w1', turnEnded: true, settled: false, turns: 1, state: 'running', lastCheckpointId: 'c1', launches: 1 };
  const wait = createWait({ workers: new Map([['w1', w]]), get: () => w, core: null, policyWait: () => rw });
  const r = await wait({ worker_ids: ['w1'], timeout_ms: 1000 });
  assert.strictEqual(r.event, 'turn_end');
  assert.strictEqual(r.already, true);
  assert.strictEqual(r.timed_out, false);
  const r2 = await wait({ timeout_ms: 1000 });
  assert.strictEqual(r2.event, 'turn_end', 'no worker named, no plan: the whole run manager is watched as before');
  assert.strictEqual(asked, 1, 'asked only for the call that names no worker');
  assert.deepStrictEqual(core.calls, []);
  const none = createWait({ workers: new Map(), get: () => null, core: null });
  await assert.rejects(() => none({ timeout_ms: 10 }), (e) => e.code === 'E_ARGS' && /launched none/.test(e.message));
});

test('a wait that names workers is as before even under a plan', async () => {
  let ran = 0;
  const rw = { active: () => true, wait: async () => { ran += 1; return {}; } };
  const w = { id: 'w1', turnEnded: true, settled: false, turns: 1, state: 'running', lastCheckpointId: 'c1', launches: 1 };
  const wait = createWait({ workers: new Map([['w1', w]]), get: () => w, core: null, policyWait: () => rw });
  assert.strictEqual((await wait({ worker_ids: ['w1'], timeout_ms: 1000 })).event, 'turn_end');
  assert.strictEqual(ran, 0);
  await wait({ timeout_ms: 1000 });
  assert.strictEqual(ran, 1, 'with none named the run is waited for');
});

test('under a plan the wait returns at the first exception, with the exception wake and the digest of the steps', async () => {
  const dir = sandbox();
  const core = fakeCore([step({ step: 'review', task_id: 'A', row_ref: 'task:rA' })]);
  let fired = false;
  const c = clock(async () => { if (!fired) { fired = true; core.steps.push(failed({ task_id: 'W' })); } }); // written while the wait sleeps
  const r = await make(core, dir, { clock: c }).wait(args(c));
  assert.strictEqual(c.sleeps, 1, 'the first look found nothing exceptional, the second did');
  assert.strictEqual(r.timed_out, false);
  assert.strictEqual(r.event, 'exception');
  assert.strictEqual(r.worker_id, null);
  assert.deepStrictEqual(r.watched, []);
  assert.strictEqual(r.exceptions.length, 1);
  assert.strictEqual(r.exceptions[0].exception, 'E8');
  assert.strictEqual(r.exceptions[0].task_id, 'W');
  assert.ok(B(r.exceptions[0].text) <= 221, 'the wake text keeps its cap');
  assert.ok(r.digest.steps === 2 && /#\d+ review A done -> task:rA/.test(r.digest.text), r.digest.text);
  assert.ok(/#\d+ fix W exception by coder: E_ARGS: boom/.test(r.digest.text), r.digest.text);
  assert.ok(B(r.digest.text) <= 2048);
});

test('with nothing to report the wait returns at its bound as a timeout, with the digest of what belay did', async () => {
  const dir = sandbox(); const c = clock();
  const core = fakeCore([step({ task_id: 'A' }), step({ task_id: 'B', outcome: 'started', row_ref: null })]);
  const rw = make(core, dir, { clock: c });
  const r = await rw.wait(args(c, { ms: 450, workers: [{ id: 'w1', state: 'running', pid: 0, turns: 2, lastEventAt: 800 }] }));
  assert.strictEqual(r.timed_out, true);
  assert.strictEqual(r.event, null);
  assert.ok(r.waited_ms >= 450 && r.waited_ms < 600, `waited ${r.waited_ms}`);
  assert.strictEqual(r.digest.steps, 1, 'a step still started is not in a digest yet');
  assert.deepStrictEqual(r.busy.map((b) => [b.worker_id, b.state, b.turns]), [['w1', 'running', 2]]);
  assert.strictEqual(c.sleeps, 5, 'five polls of 100 ms (the last one cut to the bound) and no timer');
  const r2 = await rw.wait(args(c, { ms: 200 }));
  assert.strictEqual(r2.digest, undefined, 'the same step is not shown again');
  core.steps[1].outcome = 'done'; core.steps[1].row_ref = 'task:rB';
  const r3 = await rw.wait(args(c, { ms: 200 }));
  assert.match(r3.digest.text, /B done -> task:rB/, 'a step that finished late is in the next digest');
});

test('the digest is capped at 2 KB: the oldest lines go first and the count says how many', async () => {
  const dir = sandbox(); const c = clock();
  const core = fakeCore(Array.from({ length: 80 }, (_, i) => step({ task_id: `task-${i}`, row_ref: `task:task-${i}-fix1` })));
  const r = await make(core, dir, { clock: c }).wait(args(c, { ms: 100 }));
  assert.ok(B(r.digest.text) <= 2048, `${B(r.digest.text)} B`);
  assert.ok(r.digest.dropped > 0 && r.digest.steps + r.digest.dropped === 80, JSON.stringify({ s: r.digest.steps, d: r.digest.dropped }));
  assert.match(r.digest.text, new RegExp(`^\\(\\+${r.digest.dropped} earlier policy steps not shown\\)\\n`));
  assert.ok(r.digest.text.includes('task-79') && !r.digest.text.includes('task-0 '), 'the newest are kept');
  const rec = D.readDigests(dir, RUN);
  assert.strictEqual(rec.length, 1);
  assert.strictEqual(rec[0].dropped.count, r.digest.dropped, 'the receipt counts what the cap left out');
  const again = await make(core, dir, { clock: c }).wait(args(c, { ms: 100 }));
  assert.strictEqual(again.digest, undefined, 'the dropped steps are counted, not carried over');
});

test('every step is in exactly one digest across consecutive waits, and the receipt field says so', async () => {
  const dir = sandbox(); const c = clock();
  const core = fakeCore([step(), step()]);
  const rw = make(core, dir, { clock: c });
  const all = [];
  all.push(await rw.wait(args(c, { ms: 100 })));
  core.steps.push(step(), failed({ task_id: 'X' }));
  all.push(await rw.wait(args(c, { ms: 100 })));
  core.steps.push(step());
  all.push(await rw.wait(args(c, { ms: 100 })));
  all.push(await rw.wait(args(c, { ms: 100 })));
  const field = await D.receiptField(core, dir, RUN);
  const seen = new Map();
  for (const d of field.digests) for (const l of d.lines) seen.set(l.step_seq, (seen.get(l.step_seq) || 0) + 1);
  assert.deepStrictEqual([...seen.keys()].sort((a, b) => a - b), core.steps.map((s) => s.seq).sort((a, b) => a - b), 'none lost');
  assert.ok([...seen.values()].every((n) => n === 1), 'none twice');
  assert.deepStrictEqual(field.digests.map((d) => d.n), [1, 2, 3]);
  assert.ok(field.digests.every((d) => d.dropped.count === 0 && d.lines.every((l) => Number.isInteger(l.step_seq))));
  assert.strictEqual(all[3].digest, undefined);
  assert.deepStrictEqual(await D.receiptField(fakeCore([]), sandbox(), RUN), {}, 'a run with no plan has no digests field');
});

test('a wait cancelled before it claims takes nothing: its exceptions and steps are in the next wait', async () => {
  const dir = sandbox(); const ac = new AbortController();
  const core = fakeCore([failed({ task_id: 'W' })]);
  const c = clock();
  const rw = make(core, dir, { clock: c, hooks: { afterRows: async () => { ac.abort(); } } });
  const r = await rw.wait(args(c, { signal: ac.signal }));
  assert.strictEqual(r.cancelled, true);
  assert.strictEqual(r.exceptions, undefined);
  assert.strictEqual(r.digest, undefined);
  assert.strictEqual(D.readDigests(dir, RUN).length, 0, 'no digest was claimed');
  assert.strictEqual(rw.pending().length, 1, 'the polled exception waits for the next return');
  const next = await rw.wait(args(c, { ms: 100 }));
  assert.strictEqual(next.exceptions.length, 1);
  assert.strictEqual(next.exceptions[0].exception, 'E8');
  assert.strictEqual(next.digest.steps, 1);
  const last = await rw.wait(args(c, { ms: 100 }));
  assert.strictEqual(last.exceptions, undefined, 'and it is not returned a third time');
  assert.strictEqual(last.digest, undefined);
});

test('a wait cancelled while it sleeps returns cancelled at once and a later wait is whole', async () => {
  const dir = sandbox(); const ac = new AbortController();
  const core = fakeCore([step()]);
  const c = clock(async () => { ac.abort(); });
  const rw = make(core, dir, { clock: c });
  const r = await rw.wait(args(c, { signal: ac.signal }));
  assert.strictEqual(r.cancelled, true);
  assert.strictEqual(c.sleeps, 1);
  const next = await rw.wait(args(clock(), { ms: 100 }));
  assert.strictEqual(next.digest.steps, 1);
});

test('an exception written while the digest is being built is in this return or the next, never both and never neither', async () => {
  const dir = sandbox(); const c = clock();
  const core = fakeCore([step({ task_id: 'A' })]);
  let wrote = false;
  const rw = make(core, dir, { clock: c, hooks: { afterRows: async () => { if (!wrote) { wrote = true; core.steps.push(failed({ task_id: 'LATE' })); } } } });
  const first = await rw.wait(args(c, { ms: 100 }));
  assert.strictEqual(first.exceptions, undefined, 'it was written after the exceptions were polled');
  assert.strictEqual(first.digest.steps, 1, 'and after the steps were read');
  const second = await rw.wait(args(c, { ms: 100 }));
  assert.strictEqual(second.exceptions.length, 1);
  assert.strictEqual(second.exceptions[0].task_id, 'LATE');
  assert.match(second.digest.text, /LATE exception/, 'its step is in this digest');
  const third = await rw.wait(args(c, { ms: 100 }));
  assert.strictEqual(third.exceptions, undefined);
  assert.strictEqual(third.digest, undefined);
});

test('two askers for one digest: the claim that loses the number builds again from what is left', () => {
  const dir = sandbox();
  const rows = [step(), step(), step()];
  let rival = null;
  const mine = D.claimDigest({
    dataDir: dir, runId: RUN, rows, via: 'wait',
    hooks: { beforeCreate: (rec) => { if (!rival) rival = D.claimDigest({ dataDir: dir, runId: RUN, rows: rows.slice(0, 2), via: 'wake' }); return rec; } },
  });
  assert.deepStrictEqual(rival.lines.map((l) => l.step_seq), [rows[0].seq, rows[1].seq]);
  assert.deepStrictEqual(mine.lines.map((l) => l.step_seq), [rows[2].seq], 'only the step the rival did not take');
  assert.deepStrictEqual([rival.n, mine.n], [1, 2]);
  assert.strictEqual(D.claimDigest({ dataDir: dir, runId: RUN, rows }), null);
});

test('a skip the executor reopens is not in a digest; the retake that finishes the same seq is', () => {
  const dir = sandbox();
  const skipped = step({ outcome: 'skipped', row_ref: null, error: 'E_NOT_NOW: the plan moved from rev 1 to rev 2 after the claim' });
  assert.strictEqual(D.claimDigest({ dataDir: dir, runId: RUN, rows: [skipped] }), null, 'a reopenable skip is not a finished step');
  const retaken = { ...skipped, outcome: 'done', row_ref: 'task:F', error: null };
  assert.deepStrictEqual(D.claimDigest({ dataDir: dir, runId: RUN, rows: [retaken] }).lines.map((l) => l.step_seq), [skipped.seq]);
});

test('an exception delivered by one path is not delivered by the other', async () => {
  const dir = sandbox(); const c = clock();
  const core = fakeCore([failed({ task_id: 'W' })]);
  const rw = make(core, dir, { clock: c });
  // The wake pipe took it first (it claims at the instant it publishes): the wait does not return it.
  const probe = (await require('../../src/run/policy-wakes.cjs').createPolicyWatcher({ core, runId: RUN, enabled: true }).poll())[0];
  assert.ok(D.claimException({ dataDir: dir, runId: RUN, uid: `${probe.worker_id}:${probe.key}` }));
  const r = await rw.wait(args(c, { ms: 100 }));
  assert.strictEqual(r.exceptions, undefined);
  assert.strictEqual(r.timed_out, true);
  assert.strictEqual(r.digest.steps, 1, 'the step is still in the digest');
  // And the other way round: the wait took it, so the claim is gone.
  const dir2 = sandbox();
  const core2 = fakeCore([failed({ task_id: 'W' })]);
  const got = await make(core2, dir2, { clock: clock() }).wait(args(c, { ms: 100 }));
  assert.strictEqual(got.exceptions.length, 1);
  const probe2 = (await require('../../src/run/policy-wakes.cjs').createPolicyWatcher({ core: core2, runId: RUN, enabled: true }).poll())[0];
  assert.strictEqual(D.claimException({ dataDir: dir2, runId: RUN, uid: `${probe2.worker_id}:${probe2.key}` }), false);
});

test('a worker that died is an exception once, named by what established it', async () => {
  const dir = sandbox(); const c = clock();
  const core = fakeCore([]);
  const rw = make(core, dir, { clock: c });
  const dead = { id: 'w9', launches: 1, settled: true, settledState: 'dead', deathEstablishedBy: 'pid check', exitCode: 3, exitSignal: null, turns: 4, state: 'dead' };
  const r = await rw.wait(args(c, { workers: [dead, { id: 'w8', launches: 1, settled: true, settledState: 'stopped', state: 'stopped' }] }));
  assert.deepStrictEqual(r.exceptions.map((e) => [e.exception, e.worker_id, e.event, e.established_by, e.exit_code]), [['E4', 'w9', 'dead', 'pid check', 3]]);
  const again = await rw.wait(args(c, { ms: 100, workers: [dead] }));
  assert.strictEqual(again.exceptions, undefined);
});

test('a digest that cannot be claimed is named, takes no step, and the exceptions still come', async () => {
  const dir = sandbox(); const c = clock();
  const core = fakeCore([failed({ task_id: 'W' })]);
  const rw = make(core, dir, { clock: c, hooks: { beforeCreate: () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); } } });
  const r = await rw.wait(args(c, { ms: 100 }));
  assert.strictEqual(r.exceptions.length, 1);
  assert.strictEqual(r.digest, undefined);
  assert.strictEqual(r.digest_error, 'EIO');
  assert.strictEqual(D.readDigests(dir, RUN).length, 0);
});

test('the run manager hands a no-argument wait to the policy wait once one is set, and a wait that names a worker still gets the worker', async () => {
  const { createRunManager } = require('../../src/run/index.cjs');
  const { createFakeCore } = require('./fake-core.cjs');
  const dir = sandbox();
  const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');
  const m = createRunManager({ core: createFakeCore(), dataDir: dir, runId: RUN, paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
  try {
    await assert.rejects(() => m.wait({ timeout_ms: 50 }), (e) => e.code === 'E_ARGS', 'no plan, no worker launched: as before');
    const c = clock(); c.t = Date.now(); // wait.cjs stamps t0 from the real clock
    const core = fakeCore([step({ task_id: 'M' })]);
    let armed = false;
    m.setPolicyWait(make(core, dir, { clock: c, armed: () => armed }));
    await assert.rejects(() => m.wait({ timeout_ms: 50 }), (e) => e.code === 'E_ARGS', 'a plan not in force yet: as before');
    armed = true;
    const r = await m.wait({ timeout_ms: 300 });
    assert.strictEqual(r.timed_out, true);
    assert.strictEqual(r.digest.steps, 1);
    assert.deepStrictEqual(core.calls.filter((x) => x === 'policy.list').length > 0, true);
  } finally { await m.shutdown(); }
});
