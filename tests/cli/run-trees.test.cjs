'use strict';
// run-trees.test.cjs — the close's task-tree sweep step: when it is skipped, which workers it names as unproven, that a failure
// never throws, and the text lines. The sweep itself is tested against real repositories in tests/core/worktrees-sweep.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert');
const { closeTrees, lines, unprovenWorkers } = require('../../src/cli/run-trees.cjs');

const ended = { ended_at: 1 };
const block = { removed: [], kept: [], failed: [], orphans: [], integration_kept: [], skipped: null, ms: 1 };

test('a failed run.end is not swept, and the sweep is not called', async () => {
  let called = 0;
  const r = await closeTrees({ core: null, runId: 'r', endedRow: null, closed: null, ce: null, late() {}, deps: { sweep: () => { called += 1; } } });
  assert.strictEqual(r.skipped, 'run_end_failed');
  assert.strictEqual(called, 0);
});

test('a fast close already requested skips the sweep', async () => {
  const ce = { hupSeen: () => true, leftMs: () => 1000, snapshot: null, snapshotPending: null };
  let called = 0;
  const r = await closeTrees({ core: null, runId: 'r', endedRow: ended, closed: null, ce, late() {}, deps: { sweep: () => { called += 1; } } });
  assert.strictEqual(r.skipped, 'fast_close');
  assert.strictEqual(called, 0);
});

test('Ctrl-C during the sweep cuts it and says so', async () => {
  const never = new Promise(() => {});
  const p = closeTrees({ core: null, runId: 'r', endedRow: ended, closed: null, ce: null, late() {}, deps: { sweep: () => never } });
  await new Promise((r) => setImmediate(r));
  process.emit('SIGINT');
  assert.strictEqual((await p).skipped, 'interrupted');
});

test('the workers the close did not prove ended go to the sweep, and a failing sweep is reported, never thrown', async () => {
  const closed = { still_alive: [{ worker_id: 'a' }], killed: [{ worker_id: 'a', outcome: 'signalled_still_alive' }, { worker_id: 'b', outcome: 'closed' }, { worker_id: 'c', outcome: 'refused_identity' }] };
  assert.deepStrictEqual(unprovenWorkers(closed).sort(), ['a', 'c']);
  assert.deepStrictEqual(unprovenWorkers(null), []);
  let seen = null;
  const r = await closeTrees({ core: null, runId: 'r', endedRow: ended, closed, ce: null, late() {}, deps: { sweep: (a) => { seen = a; return { ...block, removed: [1] }; } } });
  assert.deepStrictEqual(seen, { run_id: 'r', unproven_workers: ['a', 'c'] });
  assert.strictEqual(r.removed.length, 1);
  const bad = await closeTrees({ core: null, runId: 'r', endedRow: ended, closed: null, ce: null, late() {}, deps: { sweep: () => { throw new Error('boom'); } } });
  assert.strictEqual(bad.error, 'boom');
});

test('the text lines: a summary, each failure with its path, each orphan, and nothing for an empty sweep', () => {
  assert.deepStrictEqual(lines({}), []);
  assert.deepStrictEqual(lines({ worktrees_closed: block }), []);
  const l = lines({ worktrees_closed: { ...block, removed: [{}], kept: [{}, {}], failed: [{ path: 'C:/t/x', code: 'E_GIT', error: 'locked' }], orphans: [{ path: 'C:/t/o', branch: 'belay/o' }] } });
  assert.deepStrictEqual(l, ['worktrees: removed 1, kept 2, failed 1', 'worktree not removed: C:/t/x (E_GIT: locked)', 'worktree recorded by no row: C:/t/o (belay/o)']);
  assert.deepStrictEqual(lines({ worktrees_closed: { ...block, skipped: 'fast_close' } }), ['worktrees: not swept (fast_close)']);
});
