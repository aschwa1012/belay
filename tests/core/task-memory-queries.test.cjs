'use strict';
// task-memory-queries.test.cjs — `memory_queries` on a task: up to 4 short search lines the orchestrator writes at task creation, kept on the
// task row, carried by every later row of it and by the tasks made for it (the review, a fix, a follow-up, a repairs task), and read by the
// first-message index of every worker on the task. Real core against a sandbox store and a throwaway repository.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, write, commit } = require('./worktree-helpers.cjs');

const { openCore } = core('index.cjs');
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };
const LINES = ['parse --at as the latest past time', 'lib/timer.js start and stop'];
const toClean = [];
after(async () => { for (const f of toClean.reverse()) await f(); });

async function ctx() {
  const dir = sandbox();
  const repo = makeRepo(dir);
  const orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo, fix_hard_cap: 3, max_fix_rounds: 3, max_follow_ups: 2 });
  const workers = [];
  toClean.push(async () => { for (const c of workers) await c.close(); try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); } });
  let k = 0;
  const handBack = async (taskId, result, tree) => {
    const id = `w-${++k}`;
    await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree: tree || dir });
    const w = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
    workers.push(w);
    const a = await orch.task.assign({ task_id: taskId, worker_id: id });
    return w.lease.release({ lease_id: a.new_lease.id, reason: 'done', ...(result ? { result } : {}) });
  };
  const workDone = async (spec, args = {}) => {
    let t = await orch.task.create({ spec, acceptance: { files_within_owned: true }, files_owned: ['src/work.cjs'], ...args });
    t = await orch.task.worktreeCreate({ task_id: t.id });
    write(t.worktree.path, 'src/work.cjs', 'work\n');
    commit(t.worktree.path, `work ${t.id}`);
    await handBack(t.id, { branch: 'b' }, t.worktree.path);
    assert.strictEqual((await orch.task.evaluate({ task_id: t.id })).state, 'done');
    return t;
  };
  const review = async (work, verdict, findings) => {
    const r = await orch.task.create({ spec: `review ${work.id}`, depends_on: [work.id], acceptance: { verdict: true } });
    await handBack(r.id, { verdict, summary: 's', findings });
    await orch.task.evaluate({ task_id: r.id, worktree: dir });
    return r;
  };
  return { dir, orch, handBack, workDone, review };
}

const refuses = (p, re) => assert.rejects(p, (e) => { assert.strictEqual(e.code, 'E_ARGS', e.message); assert.match(e.message, re); return true; });

test('task_create validates the lines like worker_spawn: at most 4, none blank, none over 160 bytes, an array; a refusal writes nothing', async () => {
  const { orch } = await ctx();
  const make = (memory_queries) => orch.task.create({ spec: 'x', memory_queries });
  await refuses(make(['a', 'b', 'c', 'd', 'e']), /at most 4/);
  await refuses(make(['ok', '   ']), /memory_queries\[1\]/);
  await refuses(make(['x'.repeat(161)]), /161 bytes/);
  await refuses(make('not a list'), /at most 4|array/);
  await refuses(make(['clear the screen \u001b[2J']), /control character/);
  await refuses(make(['bell \u0007']), /memory_queries\[0\] has a control character/);
  await refuses(make(['\u007f']), /control character/);
  await refuses(orch.task.create({ tasks: [{ spec: 'ok' }, { spec: 'y', memory_queries: ['x'.repeat(161)] }] }), /161 bytes/);
  assert.strictEqual((await orch.task.list({})).tasks.length, 0, 'nothing was written');
});

test('the lines are stored trimmed on the task row, and every later row of the task carries them (assign, evaluate, hand-back)', async () => {
  const { orch, handBack } = await ctx();
  const t = await orch.task.create({ spec: 'work', acceptance: PASS, memory_queries: ['  parse   --at  ', 'lib/timer.js'] });
  assert.deepStrictEqual(t.memory_queries, ['parse --at', 'lib/timer.js']);
  const folded = await orch.task.create({ spec: 'folds', memory_queries: ['two\twords', 'line\nbreak'] });
  assert.deepStrictEqual(folded.memory_queries, ['two words', 'line break'], 'tab and line breaks fold to a space');
  const plain = await orch.task.create({ spec: 'no lines' });
  assert.strictEqual(plain.memory_queries ?? null, null, 'none given, none stored');
  await handBack(t.id, { branch: 'b' }); // assigned, then released with a result: two more rows of the task
  assert.deepStrictEqual((await orch.task.get({ task_id: t.id })).memory_queries, ['parse --at', 'lib/timer.js']);
});

test('the batch form stores each item\'s lines', async () => {
  const { orch } = await ctx();
  const r = await orch.task.create({ tasks: [{ spec: 'one', memory_queries: ['a line'] }, { spec: 'two' }, { spec: 'three', memory_queries: ['b line', 'c line'] }] });
  assert.deepStrictEqual(r.tasks.map((t) => t.memory_queries ?? null), [['a line'], null, ['b line', 'c line']]);
  assert.deepStrictEqual((await orch.task.get({ task_id: r.tasks[2].id })).memory_queries, ['b line', 'c line']);
});

// The lines reach a worker through its first-message index, which is built when a worker is spawned or relaunched: a task handed to a live worker by task.assign gets no index.
test('a repairs task made with no lines of its own carries the repaired work\'s; one with lines keeps its own', async () => {
  const { orch } = await ctx();
  const w = await orch.task.create({ spec: 'work', memory_queries: LINES });
  const inherit = await orch.task.create({ spec: 'fix it', repairs: w.id });
  assert.deepStrictEqual(inherit.memory_queries, LINES);
  const own = await orch.task.create({ spec: 'fix it another way', repairs: w.id, memory_queries: ['something else'] });
  assert.deepStrictEqual(own.memory_queries, ['something else']);
});

test('fix_from_review carries the judged work\'s lines', async () => {
  const c = await ctx();
  const w = await c.workDone('add the retry', { memory_queries: LINES });
  const refuted = await c.review(w, 'refuted', [{ severity: 'blocking', note: 'no retry' }]);
  const fix = await c.orch.task.fixFromReview({ review_id: refuted.id });
  assert.deepStrictEqual(fix.memory_queries, LINES);
});

test('a follow-up carries the judged work\'s lines', async () => {
  const c = await ctx();
  const w = await c.workDone('add the retry', { memory_queries: LINES });
  const held = await c.review(w, 'holds', [{ severity: 'should-fix', note: 'no test' }]);
  const fu = await c.orch.task.fixFromReview({ review_id: held.id, follow_up: true });
  assert.deepStrictEqual(fu.memory_queries, LINES);
});
