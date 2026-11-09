'use strict';
require('../helpers/tmp.cjs');
// policy-read-failed.test.cjs — a reviewer that released with no verdict and then died is asked again like any dead round worker (restarted, else a
// fresh reviewer of review.spawn); a failed run read is unknown caps, not the default cap of 2, and not a halt of the step that came due.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { deadPid } = require('../core/helpers.cjs');
const { guarded } = require('../core/worktree-helpers.cjs');
const { validateSpawnArgs } = require('../../src/run/spawn-args.cjs');
const PW = require('../../src/run/policy-wakes.cjs');
const { due } = require('../../src/run/policy-exec.cjs');
const { env, stepRows, workDone, REST, PASS } = require('./policy-review-env.cjs');

const test = guarded(nodeTest);
const SPAWNING = { build: { spawn: { agent_type: 'coder' } }, review: { spawn: { agent_type: 'reviewer' } }, ...REST };
const die = (e, id) => e.orch.worker.write({ id, state: 'dead', pid: deadPid(), exit_code: 1, death_established_by: 'exit-event' });
const revive = (e) => async (id) => { await e.orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now() }); };
const holder = (e, id) => e.raw('SELECT holder FROM lease WHERE task_id = ? ORDER BY seq DESC LIMIT 1', id)[0].holder;

// A review rv-1 released with no verdict, then rv-1 dies.
async function noVerdictThenDead(e, plan = SPAWNING) {
  const { work, tree } = await workDone(e, plan);
  const review = await e.orch.task.create({ spec: 'review', depends_on: [work.id], acceptance: { verdict: true } });
  const w = await e.worker('rv-1', tree);
  const a = await e.orch.task.assign({ task_id: review.id, worker_id: 'rv-1' });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { summary: 'I looked at it' } });
  await e.h.task.evaluate({ task_id: review.id, worktree: tree, trigger: 'release' });
  await die(e, 'rv-1');
  return { review, tree, work };
}
const reasks = (out) => out.steps.filter((s) => s.step === 'reask').map((s) => [s.step, s.outcome]);

test('a reask to a reviewer that died: the same reviewer restarted', async () => {
  const e = await env('reask-dead-restart');
  try {
    const { review } = await noVerdictThenDead(e);
    const out = await e.exec({ restartWorker: revive(e) }).tick();
    assert.deepStrictEqual(reasks(out), [['reask', 'done']]);
    assert.strictEqual(holder(e, review.id), 'rv-1');
  } finally { await e.close(); }
});

test('a reask to a reviewer that cannot be restarted goes to a fresh reviewer of review.spawn in the work tree', async () => {
  const e = await env('reask-dead-spawn');
  try {
    const { review, tree } = await noVerdictThenDead(e);
    const spawned = [];
    const spawnFor = () => async (a) => {
      validateSpawnArgs({ ...a, permission_prompt: false, permit_wait_ms: 1000, effort: null });
      spawned.push(a);
      await e.worker(a.worker_id, a.worktree);
      await e.orch.task.assign({ task_id: a.task_id, worker_id: a.worker_id });
      return { id: a.worker_id };
    };
    const out = await e.exec({ restartWorker: async () => { throw Object.assign(new Error('gone'), { code: 'E_NOT_FOUND' }); }, spawnFor }).tick();
    assert.deepStrictEqual(reasks(out), [['reask', 'done']]);
    assert.match(holder(e, review.id), /^rev-/);
    assert.deepStrictEqual([spawned[0].agent_type, spawned[0].worktree], ['reviewer', tree]);
  } finally { await e.close(); }
});

test('a failed run read is unknown caps for the wakes, not the default of 2', async () => {
  const e = await env('caps-read-failed');
  try {
    await e.orch.task.create({ spec: 'w', acceptance: PASS, policy: { build: { worker: 'b1' }, ...REST } });
    const bad = { ...e.h, run: { ...e.h.run, get: async () => { throw new Error('store busy'); } } };
    const w = PW.createPolicyWatcher({ core: bad, runId: 'test-run', enabled: true });
    await w.poll({});
    const snap = w.snapshot();
    assert.strictEqual(snap.rounds.caps.max, null, 'no guessed cap');
    assert.strictEqual(snap.readFailed, true, 'the read is marked failed');
    const ok = PW.createPolicyWatcher({ core: e.h, runId: 'test-run', enabled: true });
    await ok.poll({});
    assert.strictEqual(ok.snapshot().rounds.caps.max, 2, 'a good read still gets the documented default');
  } finally { await e.close(); }
});

test('a run read that fails after the claim reopens the step, not an exception', async () => {
  const e = await env('stilldue-read-failed');
  try {
    await e.orch.task.create({ spec: 'w', acceptance: PASS, policy: { build: { worker: 'b1' }, ...REST } });
    await e.worker('b1');
    let n = 0;
    const flaky = { ...e.h, run: { ...e.h.run, get: async (a) => { if (++n === 3) throw new Error('store busy'); return e.h.run.get(a); } } };
    const out = await e.exec({}, flaky).tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['build', 'skipped']]);
    assert.match(stepRows(e)[0].error, /^E_NOT_NOW: the facts could not be read/);
  } finally { await e.close(); }
});

test('a non-read throw while the step is rechecked stays an exception', async () => {
  const e = await env('stilldue-bug');
  try {
    await e.orch.task.create({ spec: 'w', acceptance: PASS, policy: { build: { worker: 'b1' }, ...REST } });
    await e.worker('b1');
    let n = 0;
    const bug = { ...e.h, task: { ...e.h.task, list: async (a) => { const r = await e.h.task.list(a); return ++n === 3 ? { tasks: Object.assign(r.tasks.slice(), { filter() { throw new Error('bug in due'); } }) } : r; } } };
    const out = await e.exec({}, bug).tick();
    assert.deepStrictEqual(out.steps.map((s) => [s.step, s.outcome]), [['build', 'exception']]);
    assert.match(stepRows(e)[0].error, /bug in due/);
  } finally { await e.close(); }
});

test('the fresh reviewer a reask starts is retired with the work, like the one a re_review starts', async () => {
  const e = await env('reask-retire');
  try {
    const { review, work, tree } = await noVerdictThenDead(e, { build: SPAWNING.build, review: SPAWNING.review, fix: "builder", re_review: "refuter" });
    const workId = work.id;
    const cand = due({ runId: 'test-run', tasks: (await e.h.task.list({})).tasks, integrations: [], steps: [], rounds: { caps: { max: 2, hard: null } }, failures: [] }).find((c) => c.step === 'reask');
    assert.strictEqual(cand.root_id, workId, 'the candidate names the work whose end retires the reviewer');
    const stopped = [];
    const spawnFor = () => async (a) => { await e.worker(a.worker_id, a.worktree); await e.orch.task.assign({ task_id: a.task_id, worker_id: a.worker_id }); return { id: a.worker_id }; };
    const x = e.exec({ restartWorker: async () => { throw Object.assign(new Error('gone'), { code: 'E_NOT_FOUND' }); }, spawnFor, stopWorker: async (id) => { stopped.push(id); } });
    assert.deepStrictEqual(reasks(await x.tick()), [['reask', 'done']]);
    const fresh = holder(e, review.id);
    const l = e.raw('SELECT id FROM lease WHERE task_id = ? ORDER BY seq DESC LIMIT 1', review.id)[0];
    await (await e.worker(fresh)).lease.release({ lease_id: l.id, reason: 'done', result: { verdict: 'holds', summary: 'ok', findings: [] } });
    await e.h.task.evaluate({ task_id: review.id, worktree: tree, trigger: 'release' });
    await x.tick();
    assert.deepStrictEqual(stopped, [fresh]);
  } finally { await e.close(); }
});

test('a read that keeps failing after the claim is reopened four times, then one exception that names the read', async () => {
  const e = await env('stilldue-read-bound');
  try {
    await e.orch.task.create({ spec: 'w', acceptance: PASS, policy: { build: { worker: 'b1' }, ...REST } });
    await e.worker('b1');
    let n = 0;
    const down = { ...e.h, task: { ...e.h.task, list: async (a) => { if (++n === 3) throw Object.assign(new Error('store busy'), { code: 'E_BUSY' }); return e.h.task.list(a); } } }; // the third call of a pass is the recheck after the claim
    const x = e.exec({}, down);
    const outcomes = [];
    for (let i = 0; i < 5; i++) { n = 0; outcomes.push((await x.tick()).steps.map((s) => s.outcome)[0]); }
    assert.deepStrictEqual(outcomes, ['skipped', 'skipped', 'skipped', 'skipped', 'exception']);
    const last = stepRows(e).filter((s) => s.step === 'build').pop();
    assert.match(last.error, /^E_READ_FAILED: the task\.list read failed 5 times in a row/);
  } finally { await e.close(); }
});

test('a recheck that reads again resets the count: four failures, one good read, four more failures is no exception', async () => {
  const e = await env('stilldue-read-reset');
  try {
    await e.orch.task.create({ spec: 'w', acceptance: PASS, policy: { build: { worker: 'b1' }, ...REST } });
    await e.worker('b1');
    let n = 0; let r = 0; let mode = 'fail';
    const flaky = { ...e.h,
      task: { ...e.h.task, list: async (a) => { if (++n === 3 && mode === 'fail') throw Object.assign(new Error('store busy'), { code: 'E_BUSY' }); return e.h.task.list(a); } },
      run: { ...e.h.run, get: async (a) => { const x = await e.h.run.get(a); return ++r === 3 && mode === 'pause' ? { run: { ...x.run, paused_at: 1 } } : x; } } }; // the recheck reads, and the run is paused: skipped, not a failed read
    const x = e.exec({}, flaky);
    const outcomes = [];
    for (const m of ['fail', 'fail', 'fail', 'fail', 'pause', 'fail', 'fail', 'fail', 'fail']) { mode = m; n = 0; r = 0; outcomes.push((await x.tick()).steps.map((s) => s.outcome)[0]); }
    assert.deepStrictEqual(outcomes, Array(9).fill('skipped'));
  } finally { await e.close(); }
});
