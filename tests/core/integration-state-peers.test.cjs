'use strict';
// integration-state-peers.test.cjs — ADR 0060 decision 3: a branch is one unit. A peer's merge (another task on the same branch)
// lands a task that was done before it, marked `via`; a peer's conflict or failure carries nothing over; a task done after the
// merge is not landed by it. Pure: integration rows are built here, no store.

const test = require('node:test');
const assert = require('node:assert');
const S = require('../../src/core/integration-state.cjs');

const tree = { repo: 'C:/r', path: 'C:/r.worktrees/w', branch: 'belay/w' };
const done = (id, at) => ({ id, state: 'done', worktree: tree, results: { evaluated_at: at } });
const merged = (id, ids, at) => ({ id, state: 'evaluated', into_branch: 'int/x', written_at: at, task_ids: ids, merged: ids.map((t) => ({ task_id: t })), head_sha: 'h', passed: true });
const conflict = (id, ids, at) => ({ id, state: 'conflict', into_branch: 'int/y', written_at: at, task_ids: ids, merged: [], conflict: { task_id: ids[0] } });

test('a peer\'s merge lands a task done before it, via the peer; its own merge needs no via', () => {
  const w = done('w', 10), f = done('f', 20);
  const rows = [merged('i1', ['f'], 30)];
  assert.deepStrictEqual(S.ofTask(w, rows, [f]), { state: 'merged', id: 'i1', into: 'int/x', at: 30, head: 'h', passed: true, via: 'f' });
  assert.strictEqual(S.ofTask(f, rows, [w]).via, undefined);
  assert.deepStrictEqual(S.ofTask(w, rows, []), { state: 'not_merged', into: null }, 'without peers the work was never named');
});

test('a task done after the peer\'s merge, or not done, is not landed by it', () => {
  const rows = [merged('i1', ['w'], 30)];
  assert.deepStrictEqual(S.ofTask(done('f2', 40), rows, [done('w', 10)]), { state: 'not_merged', into: null });
  assert.strictEqual(S.ofTask({ id: 'f3', state: 'open', worktree: tree, results: null }, rows, [done('w', 10)]), null);
});

test('a peer\'s conflict says nothing about the task', () => {
  const rows = [conflict('i2', ['f'], 30)];
  assert.deepStrictEqual(S.ofTask(done('w', 10), rows, [done('f', 20)]), { state: 'not_merged', into: null });
});
