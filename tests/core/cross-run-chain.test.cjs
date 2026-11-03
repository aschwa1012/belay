'use strict';
// cross-run-chain.test.cjs — a real chain through the task API: run b fixes an ended run a's refuted work, and follows up a held review of run a's work.
// Neither reaches b's integrate branch without cross_run_merge (a fix shares a's branch; a follow-up is cut from a's judged commit).
require('../helpers/tmp.cjs');
require('../helpers/git-env.cjs');
const { test, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup } = require('./helpers.cjs');
const { makeRepo, write, commit } = require('./worktree-helpers.cjs');
const { openCore } = core('index.cjs');

const dir = sandbox();
const opened = [];
after(async () => {
  for (const c of opened) { try { await c.shutdownOwner(); } catch { /* */ } }
  for (const c of opened) { try { await c.close(); } catch { /* */ } }
  cleanup(dir);
});
const data = `${dir}/data`;
const open = async (caller) => { const c = await openCore({ dataDir: data, caller: { pid: process.pid, ...caller }, embed: false }); opened.push(c); return c; };
const rejects = async (p) => { try { await p; } catch (e) { return e; } assert.fail('merged'); };
const PASS = { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] };

async function handBack(orch, run, taskId, wid, wt, result) {
  await orch.worker.write({ id: wid, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${wid}`, last_event_at: Date.now(), worktree: wt });
  const w = await open({ role: 'worker', run_id: run, worker_id: wid });
  const a = await orch.task.assign({ task_id: taskId, worker_id: wid });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', ...(result ? { result } : {}) });
  await orch.worker.write({ id: wid, substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: `s-${wid}`, last_event_at: Date.now(), worktree: wt });
}

test('real chain: fix of an ended run\'s work, and a follow-up of it, then integrate', { timeout: 240000 }, async () => {
  const repo = makeRepo(dir);
  const aOp = await open({ role: 'operator', run_id: 'a' });
  await aOp.run.attach({ adapter_pid: process.pid, project_dir: repo });
  const bOp = await open({ role: 'operator', run_id: 'b' });
  await bOp.run.attach({ adapter_pid: process.pid, project_dir: repo });
  const a = await open({ role: 'orchestrator', run_id: 'a' });
  const b = await open({ role: 'orchestrator', run_id: 'b' });

  // run a: work w1 (refuted review) and w2 (held review)
  const mk = async (name) => {
    let w = await a.task.create({ spec: name, acceptance: PASS });
    w = await a.task.worktreeCreate({ task_id: w.id });
    write(w.worktree.path, `${name}.txt`, 'a\n'); commit(w.worktree.path, name);
    await handBack(a, 'a', w.id, `c-${name}`, w.worktree.path);
    const d = await a.task.evaluate({ task_id: w.id });
    assert.strictEqual(d.state, 'done');
    return d;
  };
  const w1 = await mk('w1'), w2 = await mk('w2');
  const r1 = await a.task.create({ spec: 'review w1', depends_on: [w1.id], acceptance: { verdict: true } });
  await handBack(a, 'a', r1.id, 'j1', dir, { verdict: 'refuted', summary: 's', findings: [{ severity: 'blocking', clause: 'a', note: 'n' }] });
  await a.task.evaluate({ task_id: r1.id, worktree: dir });
  const r2 = await a.task.create({ spec: 'review w2', depends_on: [w2.id], acceptance: { verdict: true } });
  await handBack(a, 'a', r2.id, 'j2', dir, { verdict: 'holds', summary: 's', findings: [] });
  await a.task.evaluate({ task_id: r2.id, worktree: dir });
  await aOp.run.end({ exit_reason: 'probe' });

  // run b: fix of w1 (inherits a's branch)
  const fix = await b.task.fixFromReview({ review_id: r1.id });
  write(fix.worktree.path, 'w1.txt', 'fixed\n'); commit(fix.worktree.path, 'fix');
  await handBack(b, 'b', fix.id, 'c-fix', fix.worktree.path);
  assert.strictEqual((await b.task.evaluate({ task_id: fix.id })).state, 'done');
  const e = await rejects(b.integration.merge({ task_ids: [fix.id] }));
  assert.strictEqual(e.code, 'E_PRECONDITION');
  assert.deepStrictEqual((await b.integration.list({})).integrations, []);

  // run b: follow-up of w2 (its own branch, cut from a's judged commit)
  const fu = await b.task.fixFromReview({ review_id: r2.id, follow_up: true, spec: 'follow up w2' });
  write(fu.worktree.path, 'fu.txt', 'b'); commit(fu.worktree.path, 'fu');
  await handBack(b, 'b', fu.id, 'c-fu', fu.worktree.path);
  assert.strictEqual((await b.task.evaluate({ task_id: fu.id })).state, 'done');
  const e2 = await rejects(b.integration.merge({ task_ids: [fu.id] }));
  assert.strictEqual(e2.code, 'E_PRECONDITION');
  assert.deepStrictEqual(e2.detail.foreign_tasks, [{ task_id: fu.id, run_id: 'a' }]);
  assert.deepStrictEqual((await b.integration.list({})).integrations, []);
});
