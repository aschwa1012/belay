'use strict';
// cross-run-check.test.cjs — the cross_run_merge check on stored rows (src/core/cross-run.cjs): a fix task that carries another run's
// branch, an `into` that is another run's task branch, and run ids compared with case folded. Rows are plain objects in a stand-in store.

const { test } = require('node:test');
const assert = require('node:assert');
const { refuseCrossRun } = require('../../src/core/cross-run.cjs');

const REPO = 'C:/repo';
const fold = (s) => String(s).toLowerCase();
const wt = (branch) => JSON.stringify({ repo: REPO, branch, path: `${REPO}-wt/${branch}`, base_sha: 'x' });
const row = (id, run_id, branch) => ({ seq: 1, id, run_id, worktree: branch ? wt(branch) : null });

function engine({ tasks = [], runs = [] }) {
  const table = { task: tasks, run: runs.map((r, i) => ({ seq: i + 1, ...r })) };
  return { store: { p: (sql) => { const t = /FROM (\w+)/.exec(sql)[1]; return { all: () => table[t], get: (id) => table[t].find((x) => x.id === id) }; } } };
}
const as = (run_id, role = 'orchestrator') => ({ role, run_id });
const parsed = (t) => ({ ...t, worktree: JSON.parse(t.worktree) }); // the tasks a merge names are parsed rows
const refused = (E, caller, tasks, into) => { try { refuseCrossRun(E, caller, tasks.map(parsed), into, REPO, fold); return null; } catch (e) { return e; } };

const A = row('ta', 'a', 'belay/ta');
const FIX = row('tfix', 'b', 'belay/ta'); // run b's fix task, on the branch run a's task made
const OWN = row('tb', 'b', 'belay/tb');
const E = engine({ tasks: [A, FIX, OWN], runs: [{ id: 'a' }, { id: 'b' }] });

test('a fix task on another run\'s branch is cross-run even though the task is the caller\'s own', () => {
  const e = refused(E, as('b'), [FIX], 'belay/integrate/b');
  assert.ok(e, 'refused');
  assert.strictEqual(e.code, 'E_PRECONDITION');
  assert.deepStrictEqual(e.detail.foreign_tasks, [{ task_id: 'tfix', run_id: 'a' }]);
  assert.match(e.message, /Ask the operator to relaunch the run with cross_run_merge: true/);
});

test('a run\'s own task on its own branch passes', () => {
  assert.strictEqual(refused(E, as('b'), [OWN], 'belay/integrate/b'), null);
});

test('an into that another run\'s task records is refused, naming the task', () => {
  const e = refused(E, as('b'), [OWN], 'belay/ta');
  assert.ok(e, 'refused');
  assert.strictEqual(e.detail.into_task, 'ta');
});

test('another run\'s integrate branch is matched with case folded, and under its name as a path prefix', () => {
  assert.strictEqual(refused(E, as('b'), [OWN], 'belay/integrate/A').detail.into_run, 'a');
  assert.strictEqual(refused(E, as('b'), [OWN], 'belay/integrate/a/x').detail.into_run, 'a');
  assert.strictEqual(refused(E, as('b'), [OWN], 'belay/integrate/B'), null, 'its own, in another spelling');
});

test('the setting, and the operator role, let it through', () => {
  const on = engine({ tasks: [A, FIX], runs: [{ id: 'a' }, { id: 'b', cross_run_merge: 1 }] });
  assert.strictEqual(refused(on, as('b'), [FIX], 'belay/integrate/a'), null);
  assert.strictEqual(refused(E, as('cli', 'operator'), [FIX], 'belay/integrate/a'), null);
});
