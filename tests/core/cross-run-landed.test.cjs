'use strict';
require('../helpers/tmp.cjs');
require('../helpers/git-env.cjs');
// cross-run-landed.test.cjs — work of another run that the user already landed on main is not a cross-run merge: a task cut from main afterwards
// is the caller's own, and merges with the setting off.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup } = require('./helpers.cjs');
const { makeRepo, write, commit, git } = require('./worktree-helpers.cjs');
const { openCore } = core('index.cjs');

const dir = sandbox();
const opened = [];
after(async () => {
  for (const c of opened) { try { await c.shutdownOwner(); } catch { /* */ } }
  for (const c of opened) { try { await c.close(); } catch { /* */ } }
  cleanup(dir);
});
let n = 0;
async function setup() {
  const data = `${dir}/data${++n}`;
  const open = async (caller) => { const c = await openCore({ dataDir: data, caller: { pid: process.pid, ...caller }, embed: false }); opened.push(c); return c; };
  const repo = makeRepo(dir);
  for (const r of ['a', 'b']) await (await open({ role: 'operator', run_id: r })).run.attach({ adapter_pid: process.pid, project_dir: repo });
  return { repo, a: await open({ role: 'orchestrator', run_id: 'a' }), b: await open({ role: 'orchestrator', run_id: 'b' }) };
}
async function done(orch, name) {
  const exists = { argv: [process.execPath, '-e', `require('fs').accessSync(${JSON.stringify(name + '.txt')})`] };
  let t = await orch.task.create({ spec: name, acceptance: { commands: [exists] } });
  t = await orch.task.worktreeCreate({ task_id: t.id });
  write(t.worktree.path, `${name}.txt`, 'x\n'); commit(t.worktree.path, name);
  const d = await orch.task.evaluate({ task_id: t.id });
  assert.strictEqual(d.state, 'done');
  return d;
}
const tryMerge = async (orch, ids) => { try { return { row: await orch.integration.merge({ task_ids: ids }) }; } catch (e) { return { code: e.code, msg: e.message }; } };

test('a run merges its own task cut from main after the user landed another run work there', { timeout: 240000 }, async () => {
  const { repo, a, b } = await setup();
  const b0 = await done(b, 'b0');
  const first = await tryMerge(b, [b0.id]);
  assert.ok(first.row, JSON.stringify(first));
  const wa = await done(a, 'wa');
  git(repo, 'merge', '--no-ff', '-q', '-m', 'user merges a', wa.worktree.branch); // the user lands run a's work on main
  const b2 = await done(b, 'b2'); // cut from main, which now holds a's judged commit
  const r = await tryMerge(b, [b2.id]);
  assert.ok(r.row, JSON.stringify(r));
  assert.strictEqual(r.row.into_branch, 'belay/integrate/b');
});
