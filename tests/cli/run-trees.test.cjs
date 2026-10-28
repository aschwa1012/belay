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

test('Ctrl-C during the sweep tells it to stop and returns only after the call settles, with what it did', async () => {
  let settle, cancelled = 0, resolved = false;
  const running = new Promise((r) => { settle = r; });
  const deps = { sweep: () => running, cancel: () => { cancelled += 1; } };
  const p = closeTrees({ core: null, runId: 'r', endedRow: ended, closed: null, ce: null, late() {}, deps }).then((v) => { resolved = true; return v; });
  await new Promise((r) => setImmediate(r));
  process.emit('SIGINT');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(cancelled, 1, 'the sweep was told to stop');
  assert.strictEqual(resolved, false, 'the close does not go on while a removal may be running');
  settle({ ...block, removed: [{ task_ids: ['t'] }], skipped: 'interrupted' });
  const r = await p;
  assert.strictEqual(r.skipped, 'interrupted');
  assert.strictEqual(r.removed.length, 1, 'what the sweep did before it stopped stays in the receipt');
});

test('a fast close during the sweep does the same and reports fast_close', async () => {
  let settle, cut, cancelled = 0, resolved = false;
  const running = new Promise((r) => { settle = r; });
  const ce = { hupSeen: () => false, leftMs: () => 60000, snapshot: null, snapshotPending: null, bound: (p) => Promise.race([p, new Promise((r) => { cut = r; })]) };
  const p = closeTrees({ core: null, runId: 'r', endedRow: ended, closed: null, ce, late() {}, deps: { sweep: () => running, cancel: () => { cancelled += 1; } } }).then((v) => { resolved = true; return v; });
  await new Promise((r) => setImmediate(r));
  cut(require('../../src/run/orchestrator-interactive.cjs').TIMED_OUT);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(cancelled, 1);
  assert.strictEqual(resolved, false);
  settle({ ...block, removed: [{}, {}], skipped: 'interrupted' });
  const r = await p;
  assert.deepStrictEqual([r.skipped, r.removed.length], ['fast_close', 2]);
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

test('a sweep that finished before the cut was seen is not called interrupted', async () => {
  let settle;
  const running = new Promise((r) => { settle = r; });
  const deps = { sweep: () => running, cancel: () => { settle({ ...block, removed: [{}] }); return { cancel_requested: false, in_flight: null }; } };
  const p = closeTrees({ core: null, runId: 'r', endedRow: ended, closed: null, ce: null, late() {}, deps });
  await new Promise((r) => setImmediate(r));
  process.emit('SIGINT');
  const r = await p;
  assert.deepStrictEqual([r.skipped, r.removed.length], [null, 1]);
});

test('a cut whose sweep does not settle within the fast close time returns possibly_unrecorded naming the tree in flight', async () => {
  let cut;
  const ce = { hupSeen: () => false, leftMs: () => 30, snapshot: null, snapshotPending: null, bound: (p) => Promise.race([p, new Promise((r) => { cut = r; })]) };
  const p = closeTrees({ core: null, runId: 'r', endedRow: ended, closed: null, ce, late() {}, deps: { sweep: () => new Promise(() => {}), cancel: () => ({ cancel_requested: true, in_flight: 'C:/t/x' }) } });
  await new Promise((r) => setImmediate(r));
  cut(require('../../src/run/orchestrator-interactive.cjs').TIMED_OUT);
  const r = await p;
  assert.deepStrictEqual([r.skipped, r.possibly_unrecorded], ['fast_close', ['C:/t/x']]);
  assert.deepStrictEqual(lines({ worktrees_closed: r }), ['worktrees: not swept (fast_close)', 'worktree possibly removed but not recorded: C:/t/x']);
});

test('the sweep is given the fast close time as its deadline when one is running', async () => {
  const ce = { hupSeen: () => false, leftMs: () => 1234, snapshot: null, snapshotPending: null, bound: (p) => p };
  let seen = null;
  await closeTrees({ core: null, runId: 'r', endedRow: ended, closed: null, ce, late() {}, deps: { sweep: (a) => { seen = a; return block; } } });
  assert.strictEqual(seen.deadline_ms, 1234);
});

test('a sweep call that fails names the tree a cancel finds in flight as possibly unrecorded', async () => {
  const r = await closeTrees({ core: null, runId: 'r', endedRow: { ended_at: 1 }, closed: null, ce: null, late() {}, deps: { sweep: () => { throw new Error('call lost'); }, cancel: () => ({ cancel_requested: true, in_flight: 'C:/t/y' }) } });
  assert.strictEqual(r.error, 'call lost');
  assert.deepStrictEqual(r.possibly_unrecorded, ['C:/t/y']);
  assert.ok(lines({ worktrees_closed: r }).includes('worktree possibly removed but not recorded: C:/t/y'));
  const plain = await closeTrees({ core: null, runId: 'r', endedRow: { ended_at: 1 }, closed: null, ce: null, late() {}, deps: { sweep: () => { throw new Error('boom'); }, cancel: () => ({ in_flight: null }) } });
  assert.strictEqual(plain.possibly_unrecorded, undefined);
});
