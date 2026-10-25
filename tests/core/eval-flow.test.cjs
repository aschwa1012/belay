'use strict';
// eval-flow.test.cjs — the try-2 evaluation gaps: one evaluation of a task at a time (a second with other arguments is refused
// E_BUSY naming the running one, the same arguments join it; gap 4), a task's own diff base used when task.evaluate names none
// (gap 3), and the failing-test section kept in a check's stdout tail, in task.evaluate and integration.merge alike (gap 10). Real
// core, a sandbox store and a throwaway repository; the slow evaluation waits on a file the test writes, never on a clock.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const { makeRepo, git, write, commit, rejectsCode } = require('./worktree-helpers.cjs');
const RE = require('../../src/run/release-eval.cjs');

const { openCore } = core('index.cjs');
const fwd = (p) => p.split('\\').join('/');

let dir, repo, orch, n = 0;
const workers = [];

before(async () => {
  dir = sandbox();
  repo = makeRepo(dir);
  orch = await openCore({ dataDir: `${dir}/data`, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid, project_dir: repo });
});

after(async () => {
  for (const c of workers) await c.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

async function handBack(taskId, worktree) {
  const id = `w-${++n}`;
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: `s-${id}`, last_event_at: Date.now(), worktree });
  const w = await openCore({ dataDir: `${dir}/data`, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.push(w);
  const a = await orch.task.assign({ task_id: taskId, worker_id: id });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done', result: { branch: 'b' } });
}

test('gap 4: while a release evaluation runs, one with another base is refused naming it, the same one joins, and the result is the one row', async () => {
  const gate = fwd(path.join(dir, 'gate-open'));
  const started = fwd(path.join(dir, 'gate-started'));
  const wait = { argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(started)}, ''); const t = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(gate)})) { clearInterval(t); } }, 20);`], timeout_ms: 60000 };
  const t = await orch.task.create({ spec: 'no tree', acceptance: { commands: [wait] } }); // no worktree on the row
  await handBack(t.id, dir);
  const release = orch.task.evaluate({ task_id: t.id, worktree: dir, trigger: 'release' });
  while (!fs.existsSync(started)) await new Promise((r) => setTimeout(r, 20)); // the command has started: the evaluation is in flight
  const e = await rejectsCode(orch.task.evaluate({ task_id: t.id, worktree: dir, base: 'HEAD' }), 'E_BUSY');
  assert.deepStrictEqual([e.detail.running.trigger, e.detail.running.base, e.detail.running.worktree.toLowerCase()], ['release', null, fwd(dir).toLowerCase()]);
  assert.match(e.message, /being evaluated already \(at release, in .*\); its result comes as a wake and in task_list/);
  const joined = orch.task.evaluate({ task_id: t.id, worktree: dir });
  fs.writeFileSync(gate, '');
  const [r, j] = await Promise.all([release, joined]);
  assert.deepStrictEqual([r.state, r.results.trigger, r.results.checks[0].detail.cwd], ['done', 'release', fwd(dir)], 'the holder\'s directory, at once');
  assert.deepStrictEqual([j.joined_evaluation, j.rev], [true, r.rev], 'the same call joined the running one');
  // Once it has landed, the refusal is gone: a done task is refused as done, as before.
  await rejectsCode(orch.task.evaluate({ task_id: t.id, worktree: dir, base: 'HEAD' }), 'E_TASK_DONE');
  assert.match(RE.clause([{ task_id: 'x', error: 'E_BUSY' }], 400), /task x not evaluated at release: another evaluation of it is running/);
});


