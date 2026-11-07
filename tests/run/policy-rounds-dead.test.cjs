'use strict';
require('../helpers/tmp.cjs');
// policy-rounds-dead.test.cjs — a builder that dies AFTER it handed back is not relaunched by policy-relaunch.cjs (the task is released, not open), and a
// fix round for its red hand-back used to end in an E8 naming a dead worker. The round now brings the builder back first: the same worker restarted, else a
// fresh coder of the plan's build.spawn in the same tree; an operator's kill and a run with neither path stay the exception they were. Real core.

const { test: nodeTest } = require('node:test');
const assert = require('node:assert');
const { deadPid } = require('../core/helpers.cjs');
const { makeRepo, write, commit, guarded } = require('../core/worktree-helpers.cjs');
const KM = require('../../src/core/kill-mark.cjs');
const { env, stepRows, wakesOf, workDone, REST } = require('./policy-review-env.cjs');

const test = guarded(nodeTest);
const RED = { commands: [{ argv: [process.execPath, '-e', 'process.exit(1)'], timeout_ms: 20000 }] };
const PLAN = { build: { spawn: { agent_type: 'coder' } }, review: { worker: 'rv' }, ...REST };

// A task b1 handed back red, then b1 dies.
async function redThenDead(e) {
  const repo = makeRepo(e.dir);
  const t = await e.orch.task.create({ spec: 'write r.txt', acceptance: RED, policy: PLAN });
  const wt = (await e.op.task.worktreeCreate({ task_id: t.id, repo })).worktree.path;
  write(wt, 'r.txt', 'r\n'); commit(wt, 'work');
  const w = await e.worker('b1', wt);
  const a = await e.orch.task.assign({ task_id: t.id, worker_id: 'b1' });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b', head: 'h' } });
  assert.strictEqual((await e.h.task.evaluate({ task_id: t.id, trigger: 'release' })).state, 'released');
  const pid = deadPid();
  await e.orch.worker.write({ id: 'b1', state: 'dead', pid, exit_code: 1, death_established_by: 'exit-event' });
  return { t, wt, pid };
}
const holder = (e, id) => e.raw('SELECT holder FROM lease WHERE task_id = ? ORDER BY seq DESC LIMIT 1', id)[0].holder;
const fixSteps = () => (out) => out.steps.filter((s) => s.step === 'fix_eval').map((s) => [s.step, s.outcome]);

test('a red hand-back whose builder died goes back to the same builder, restarted', async () => {
  const e = await env('dead-restart');
  try {
    const { t } = await redThenDead(e);
    const calls = [];
    const restartWorker = async (id) => { calls.push(id); await e.orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now() }); };
    const out = await e.exec({ restartWorker }).tick();
    assert.deepStrictEqual(fixSteps()(out), [['fix_eval', 'done']]);
    assert.deepStrictEqual(calls, ['b1'], 'the same worker, restarted');
    assert.strictEqual(holder(e, t.id), 'b1');
  } finally { await e.close(); }
});

test('a builder that cannot be restarted is replaced by a fresh coder of the plan\'s build.spawn on the same task and tree, told why', async () => {
  const e = await env('dead-spawn');
  try {
    const { t, wt } = await redThenDead(e);
    const sent = []; const spawned = [];
    const spawnFor = () => async (a) => { spawned.push(a); await e.worker(a.worker_id, a.worktree); return { id: a.worker_id }; };
    const assignFor = (stepCore) => async (a) => { sent.push(a); return stepCore.task.assign(a); };
    const out = await e.exec({ restartWorker: async () => { throw Object.assign(new Error('no session'), { code: 'E_NOT_FOUND' }); }, spawnFor, assignFor }).tick();
    assert.deepStrictEqual(fixSteps()(out), [['fix_eval', 'done']]);
    assert.strictEqual(spawned.length, 1);
    assert.deepStrictEqual([spawned[0].agent_type, spawned[0].worktree], ['coder', wt], 'a coder, in the task\'s tree');
    assert.match(holder(e, t.id), /^bld-/);
    assert.strictEqual(sent[0].worker_id, holder(e, t.id));
    assert.match(sent[0].prompt, /failed belay's own evaluation/, 'the fresh coder is told what failed');
    assert.deepStrictEqual((await wakesOf(e)).map((w) => w.exception), [], 'no exception');
  } finally { await e.close(); }
});

test('a builder an operator killed is not brought back: the round ends in the exception it always did', async () => {
  const e = await env('dead-killed');
  try {
    const { pid } = await redThenDead(e);
    const dd = `${e.dir}/data`;
    KM.mark(dd, 'b1', pid);
    const calls = [];
    const out = await e.exec({ dataDir: dd, restartWorker: async (id) => { calls.push(id); } }).tick();
    assert.deepStrictEqual(fixSteps()(out), [['fix_eval', 'exception']]);
    assert.match(stepRows(e).find((s) => s.step === 'fix_eval').error, /killed by an operator/);
    assert.deepStrictEqual(calls, []);
  } finally { await e.close(); }
});

test('a run with neither a restart nor a spawn path keeps the exception, naming the dead builder', async () => {
  const e = await env('dead-nopath');
  try {
    await redThenDead(e);
    const out = await e.exec().tick();
    assert.deepStrictEqual(fixSteps()(out), [['fix_eval', 'exception']]);
    assert.match(stepRows(e).find((s) => s.step === 'fix_eval').error, /builder b1 is dead.*no restart path/);
  } finally { await e.close(); }
});

// A work judged done by builder-1, refuted by the reviewer rv-1 (a worker of its own, in the work's tree).
const SPAWNING = { build: { spawn: { agent_type: 'coder' } }, review: { spawn: { agent_type: 'reviewer' } }, ...REST };
async function refuted(e) {
  const { work, tree, builder } = await workDone(e, SPAWNING);
  const review = await e.orch.task.create({ spec: 'review', depends_on: [work.id], acceptance: { verdict: true } });
  const w = await e.worker('rv-1', tree);
  const a = await e.orch.task.assign({ task_id: review.id, worker_id: 'rv-1' });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { verdict: 'refuted', summary: 'bad', findings: [{ severity: 'blocking', clause: 'a', note: 'bad' }] } });
  await e.h.task.evaluate({ task_id: review.id, worktree: tree, trigger: 'release' });
  return { work, tree, builder, review };
}
const die = (e, id) => e.orch.worker.write({ id, state: 'dead', pid: deadPid(), exit_code: 1, death_established_by: 'exit-event' });
const revive = (e) => async (id) => { await e.orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now() }); };
const stepsOut = (out, name) => out.steps.filter((s) => s.step === name).map((s) => [s.step, s.outcome]);

test('the fix for a refuted review goes to its builder even when it died: restarted, else a fresh coder in the work\'s tree', async () => {
  const e = await env('dead-fix-restart');
  try {
    const { work, builder } = await refuted(e);
    await die(e, builder);
    const out = await e.exec({ restartWorker: revive(e) }).tick();
    assert.deepStrictEqual(stepsOut(out, 'fix'), [['fix', 'done']]);
    const fixId = e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id)[0].id;
    assert.strictEqual(holder(e, fixId), builder, 'the same builder, restarted');
  } finally { await e.close(); }
});

test('a fix whose builder cannot be restarted goes to a fresh coder of build.spawn', async () => {
  const e = await env('dead-fix-spawn');
  try {
    const { work, builder, tree } = await refuted(e);
    await die(e, builder);
    const spawned = [];
    const spawnFor = () => async (a) => { spawned.push(a); await e.worker(a.worker_id, a.worktree); return { id: a.worker_id }; };
    const out = await e.exec({ restartWorker: async () => { throw Object.assign(new Error('gone'), { code: 'E_NOT_FOUND' }); }, spawnFor }).tick();
    assert.deepStrictEqual(stepsOut(out, 'fix'), [['fix', 'done']]);
    const fixId = e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', work.id)[0].id;
    assert.match(holder(e, fixId), /^bld-/);
    assert.deepStrictEqual([spawned[0].agent_type, spawned[0].worktree], ['coder', tree]);
  } finally { await e.close(); }
});

// The fix is done by the live builder, then the refuter dies before its re_review is due.
async function fixedThenRefuterDead(e) {
  const r = await refuted(e);
  assert.deepStrictEqual(stepsOut(await e.exec().tick(), 'fix'), [['fix', 'done']]);
  const fixId = e.raw('SELECT DISTINCT id FROM task WHERE repairs = ?', r.work.id)[0].id;
  const l = e.raw('SELECT id FROM lease WHERE task_id = ? ORDER BY seq DESC LIMIT 1', fixId)[0];
  await (await e.worker(r.builder)).lease.release({ lease_id: l.id, reason: 'done', result: { branch: 'b', head: 'h2' } });
  assert.strictEqual((await e.h.task.evaluate({ task_id: fixId, trigger: 'release' })).state, 'done');
  await die(e, 'rv-1');
  return { ...r, fixId };
}

test('a re_review aimed at a refuter that died: the same reviewer restarted', async () => {
  const e = await env('dead-rereview-restart');
  try {
    const { review, fixId } = await fixedThenRefuterDead(e);
    const out = await e.exec({ restartWorker: revive(e) }).tick();
    assert.deepStrictEqual(stepsOut(out, 're_review'), [['re_review', 'done']]);
    const rr = e.raw("SELECT id FROM task WHERE depends_on LIKE ? AND acceptance LIKE '%verdict%'", `%${fixId}%`)[0].id;
    assert.strictEqual(holder(e, rr), 'rv-1');
    assert.ok(review.id);
  } finally { await e.close(); }
});

test('a re_review whose refuter cannot be restarted goes to a fresh reviewer of review.spawn in the work\'s tree; a kill mark or no path is the exception it was', async () => {
  const e = await env('dead-rereview-spawn');
  try {
    const { fixId, tree } = await fixedThenRefuterDead(e);
    const spawned = [];
    const spawnFor = () => async (a) => { spawned.push(a); await e.worker(a.worker_id, a.worktree); return { id: a.worker_id }; };
    const out = await e.exec({ restartWorker: async () => { throw Object.assign(new Error('gone'), { code: 'E_NOT_FOUND' }); }, spawnFor }).tick();
    assert.deepStrictEqual(stepsOut(out, 're_review'), [['re_review', 'done']]);
    const rr = e.raw("SELECT id FROM task WHERE depends_on LIKE ? AND acceptance LIKE '%verdict%'", `%${fixId}%`)[0].id;
    assert.match(holder(e, rr), /^rev-/);
    assert.deepStrictEqual([spawned[0].agent_type, spawned[0].worktree], ['reviewer', tree]);
  } finally { await e.close(); }
});

test('a re_review whose refuter is dead, with no path to a new one, is the exception it was', async () => {
  const e = await env('dead-rereview-none');
  try {
    await fixedThenRefuterDead(e);
    const out = await e.exec().tick();
    assert.deepStrictEqual(stepsOut(out, 're_review'), [['re_review', 'exception']]);
    assert.match(stepRows(e).find((x) => x.step === 're_review').error, /refuter rv-1 is dead.*no restart path/);
  } finally { await e.close(); }
});
