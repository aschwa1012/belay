'use strict';
// task-create-view.test.cjs — task_create's compact answer for a tree it made and for a batch (ADR 0062), and its argument check.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', 'src', 'mcp');
const views = require(path.join(root, 'views.cjs'));
const tools = require(path.join(root, 'tools.cjs'));

const row = (id, extra = {}) => ({ id, seq: 3, state: 'open', spec: `spec of ${id}`, acceptance: null, files_owned: null, depends_on: null, run_id: 'r', written_at: 1, written_by: 'x', ...extra });
const tree = { repo: '/r', path: '/r.worktrees/a', branch: 'belay/a', base_ref: 'HEAD', base_sha: 'abc', junctions: [], junctions_skipped: [{ path: 'node_modules', reason: 'x' }], removed_at: null };

test('a task created with its tree answers the tree; a task that inherited one does not', async () => {
  const out = await views.viewed('task_create', { spec: 's' }, async () => row('a', { worktree: tree }));
  assert.deepStrictEqual(out.worktree, { path: '/r.worktrees/a', branch: 'belay/a', base_sha: 'abc', junctions_skipped: tree.junctions_skipped });
  const inherited = await views.viewed('task_create', { spec: 's' }, async () => row('b', { worktree: { ...tree, inherited_from: 'a' } }));
  assert.strictEqual(inherited.worktree, undefined);
});

test('a batch answers one entry per task, in order, each with its own overlaps and warning', async () => {
  const out = await views.viewed('task_create', { tasks: [{}] }, async () => ({ tasks: [row('a', { worktree: tree, overlaps: [{ task_id: 'z' }], warning: 'w' }), row('b')] }));
  assert.deepStrictEqual(out.tasks.map((t) => t.id), ['a', 'b']);
  assert.strictEqual(out.tasks[0].worktree.branch, 'belay/a');
  assert.deepStrictEqual(out.tasks[0].overlaps, [{ task_id: 'z' }]);
  assert.strictEqual(out.tasks[0].warning, 'w');
  assert.strictEqual(out.tasks[1].worktree, undefined);
});

test('tasks stands in for spec at the boundary; the listing declares worktree and tasks', () => {
  assert.doesNotThrow(() => tools.validateArgs('task_create', { tasks: [{ spec: 'x' }] }));
  assert.throws(() => tools.validateArgs('task_create', { worktree: true }), /needs spec/);
  const props = tools.schemaOf('task_create').properties;
  assert.ok(props.worktree && props.tasks);
});

test('fix_from_review with follow_up answers the follow-up\'s own tree, follow_ups_left and the task it waits for; an inherited fix tree stays out', async () => {
  const fu = row('f', { depends_on: ['w'], files_owned: ['src/a.cjs'], worktree: tree, follows_up: { review_id: 'rv', task_id: 'w', root: 'w' }, from_review: 'rv', follow_ups_left: 0 });
  const out = await views.viewed('fix_from_review', { review_id: 'rv', follow_up: true }, async () => fu);
  assert.deepStrictEqual(out.worktree, { path: '/r.worktrees/a', branch: 'belay/a', base_sha: 'abc', junctions_skipped: tree.junctions_skipped });
  assert.deepStrictEqual([out.depends_on, out.files_owned, out.follow_ups_left, out.from_review], [['w'], ['src/a.cjs'], 0, 'rv']);
  const fix = await views.viewed('fix_from_review', { review_id: 'rv' }, async () => row('g', { repairs: 'w', worktree: { ...tree, inherited_from: 'w' } }));
  assert.strictEqual(fix.worktree, undefined);
});
