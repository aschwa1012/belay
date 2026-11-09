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
const { env, stepRows, workDone, REST, PASS } = require('./policy-review-env.cjs');

const test = guarded(nodeTest);
const SPAWNING = { build: { spawn: { agent_type: 'coder' } }, review: { spawn: { agent_type: 'reviewer' } }, ...REST };
const die = (e, id) => e.orch.worker.write({ id, state: 'dead', pid: deadPid(), exit_code: 1, death_established_by: 'exit-event' });
const revive = (e) => async (id) => { await e.orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now() }); };
const holder = (e, id) => e.raw('SELECT holder FROM lease WHERE task_id = ? ORDER BY seq DESC LIMIT 1', id)[0].holder;

// A review rv-1 released with no verdict, then rv-1 dies.
async function noVerdictThenDead(e) {
  const { work, tree } = await workDone(e, SPAWNING);
  const review = await e.orch.task.create({ spec: 'review', depends_on: [work.id], acceptance: { verdict: true } });
  const w = await e.worker('rv-1', tree);
  const a = await e.orch.task.assign({ task_id: review.id, worker_id: 'rv-1' });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { summary: 'I looked at it' } });
  await e.h.task.evaluate({ task_id: review.id, worktree: tree, trigger: 'release' });
  await die(e, 'rv-1');
  return { review, tree };
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
