'use strict';
// views.test.cjs — ADR 0058 amendment 1: the orchestrator's task answers are compact by default. A listing row keeps what the
// orchestrator acts on and drops the spec's body, the output tails and the receipts; one task's detail keeps the hand-back and
// every failing check whole; view debug is the core's answer untouched. Pure: rows are built here, no store.

const test = require('node:test');
const assert = require('node:assert');
const V = require('../../src/mcp/views.cjs');

const TAIL = 'ok 1 - a passing line of runner output\n'.repeat(40);
const SPEC = `Add the retry module to lib/ with its tests. ${'Keep the public API unchanged. '.repeat(12)}`;
const check = (passed) => ({ kind: 'command', argv: ['npm', 'test'], executable: true, exit_code: passed ? 0 : 1, ms: 900, passed,
  detail: { cwd: 'C:/r.worktrees/t1', timed_out: false, signal: null, spawn_error: null, stdout_tail: TAIL, stderr_tail: 'warn', stdout_bytes: 2000, stderr_bytes: 4 } });
const owned = (passed) => ({ kind: 'files_within_owned', executable: true, passed, ms: 20,
  detail: { base_ref: 'b', base_source: 'recorded', base_sha: 'b', head_sha: 'h1', changed_count: 2, changed: ['a.js', 'b.js'], outside: passed ? [] : ['b.js'], files_owned: ['a.js'] } });
const verdict = { kind: 'verdict', executable: true, passed: false, ms: 1, detail: { verdict: 'refuted', summary: 's', by: 'r1', reason: null, findings: [{ severity: 'blocking' }] } };
const row = (over = {}) => ({
  rev: 9, id: 't1', run_id: 'r', spec: SPEC, acceptance: { commands: [{ argv: ['npm', 'test'] }], files_within_owned: true }, files_owned: ['a.js'],
  state: 'released', depends_on: ['t0'], repairs: null, written_at: 5, written_by: 'orchestrator', future_field: 'kept',
  results: { evaluated_at: 7, executable: true, passed: false, trigger: 'release', checks: [check(false), owned(true)] },
  handoff: { by: 'w1', at: 6, lease_id: 'l1', result: { branch: 'belay/t1', head: 'h1', findings: ['one', 'two'] } },
  worktree: { repo: 'C:/r', path: 'C:/r.worktrees/t1', branch: 'belay/t1', base_sha: 'b', junctions: [{ path: 'x', target: 'y' }] },
  holds_files: true, holds_reason: 'run_live', lease: { id: 'l2', holder: 'w1', holder_role: 'worker', granted_at: 1, ttl_ms: 600000, expires_at: 600001, expired: false },
  holder_pid_alive: true, last_checkpoint_id: 'c1', last_checkpoint_at: 4, ...over,
});

test('a listing row keeps id, state, rev, the spec head, depends_on, branch, lease, results counted and failing named, hand-back fields', () => {
  const s = V.compactTask(row());
  assert.deepStrictEqual([s.id, s.state, s.rev, s.depends_on, s.branch, s.holder_pid_alive, s.last_checkpoint_id], ['t1', 'released', 9, ['t0'], 'belay/t1', true, 'c1']);
  assert.ok(s.spec_head.length <= V.SPEC_HEAD && SPEC.startsWith(s.spec_head.slice(0, -3)) && s.spec_head.endsWith('...'), s.spec_head);
  assert.deepStrictEqual(s.lease, { id: 'l2', holder: 'w1', holder_role: 'worker', expires_at: 600001, expired: false });
  assert.deepStrictEqual(s.results, { passed: false, executable: true, trigger: 'release', checks: 2, failing: ['command npm test exit 1'] });
  assert.deepStrictEqual(s.handoff, { by: 'w1', at: 6, fields: ['branch', 'head', 'findings'] });
  for (const k of ['spec', 'acceptance', 'worktree', 'files_owned', 'written_by', 'run_id']) assert.ok(!(k in s), `${k} is not in a listing row`);
  assert.strictEqual(s.future_field, 'kept', 'a field the core adds passes through');
  assert.ok(!JSON.stringify(s).includes('passing line'), 'no output tail in a listing');
  assert.strictEqual(V.compactTask(row({ spec: 'short' })).spec_head, 'short');
});

test('one task\'s detail keeps the hand-back whole and a failing check\'s tails, and drops a passing check\'s', () => {
  const d = V.compactTask(row({ results: { evaluated_at: 7, executable: true, passed: false, checks: [check(false), check(true), owned(true), owned(false), verdict] } }), { detail: true });
  assert.deepStrictEqual(d.handoff, row().handoff);
  assert.deepStrictEqual(d.worktree, { path: 'C:/r.worktrees/t1', branch: 'belay/t1' });
  assert.strictEqual(d.written_by, 'orchestrator', 'a write\'s answer names who wrote it');
  const [fail, pass, own, ownFail, v] = d.results.checks;
  assert.strictEqual(fail.detail.stdout_tail, TAIL, 'a failing command keeps its output');
  assert.deepStrictEqual([pass.detail.stdout_tail, pass.detail.stdout_bytes, pass.detail.timed_out, pass.exit_code], [undefined, 2000, false, 0]);
  assert.ok(!('cwd' in fail.detail) && !('signal' in fail.detail), 'cwd and nulls go');
  assert.deepStrictEqual([own.detail.head_sha, own.detail.base_source, own.detail.changed_count, own.detail.changed], ['h1', 'recorded', 2, undefined]);
  assert.deepStrictEqual(ownFail.detail.outside, ['b.js']);
  assert.deepStrictEqual(ownFail.detail.changed, ['a.js', 'b.js'], 'a failing check keeps its file list');
  assert.deepStrictEqual(v, verdict, 'a verdict check is whole');
});

test('viewed: task_list compacts by default, task_ids narrows to the detail shape, view debug is the core answer', async () => {
  const answer = { tasks: [row(), row({ id: 't2' })] };
  const calls = [];
  const run = async (a) => { calls.push(a); return answer; };
  const plain = await V.viewed('task_list', { states: ['released'] }, run);
  assert.deepStrictEqual(calls.pop(), { states: ['released'] });
  assert.deepStrictEqual(plain.tasks.map((t) => [t.id, 'spec' in t, t.handoff.result]), [['t1', false, undefined], ['t2', false, undefined]]);
  const one = await V.viewed('task_list', { task_ids: ['t2'] }, run);
  assert.deepStrictEqual(calls.pop(), {}, 'task_ids never reaches the core');
  assert.deepStrictEqual(one.tasks.map((t) => [t.id, t.handoff.result.head]), [['t2', 'h1']]);
  assert.strictEqual(await V.viewed('task_list', { view: 'debug' }, run), answer);
  assert.deepStrictEqual(calls.pop(), {}, 'view never reaches the core');
  assert.deepStrictEqual((await V.viewed('task_list', { view: 'debug', task_ids: ['t1'] }, run)).tasks, [answer.tasks[0]]);
  await assert.rejects(V.viewed('task_list', { view: 'full' }, run), (e) => e.code === 'E_ARGS' && e.detail.field === 'view');
  await assert.rejects(V.viewed('task_list', { task_ids: 't1' }, run), (e) => e.code === 'E_ARGS' && e.detail.field === 'task_ids');
});

test('viewed: task_evaluate, task_assign and task_cancel are compact; other tools and odd names pass through', async () => {
  const ev = await V.viewed('task_evaluate', { task_id: 't1' }, async () => ({ ...row(), idle_stop: { stopped: true } }));
  assert.deepStrictEqual([ev.idle_stop, 'spec' in ev, ev.handoff.result.head], [{ stopped: true }, false, 'h1']);
  const as = await V.viewed('task_assign', { task_id: 't1', worker_id: 'w1' }, async () => ({ task: row(), new_lease: { id: 'l2' }, delivered: { sent: true } }));
  assert.deepStrictEqual([as.new_lease, as.delivered, 'spec' in as.task, as.task.id], [{ id: 'l2' }, { sent: true }, false, 't1']);
  for (const name of ['status', '__proto__', 'constructor', 'toString']) {
    assert.strictEqual(V.isViewed(name), false, name);
    const same = { anything: 1 };
    assert.strictEqual(await V.viewed(name, { view: 'whatever' }, async () => same), same, name);
  }
});

test('integrate: the merge facts stay; the repository, junctions, base and a passing check\'s tails go', () => {
  const r = { id: 'i1', run_id: 'r', repo: 'C:/r', into_branch: 'belay/integrate/r', worktree: 'C:/r.worktrees/i', created_worktree: true, base_sha: 'b', head_sha: 'h',
    state: 'evaluated', task_ids: ['t1'], merged: [{ task_id: 't1', sha: 's' }], conflict: null, error: null, passed: false, junctions: [{ path: 'x' }], removed_at: null,
    checks: [{ argv: ['npm', 'test'], cwd: 'C:/r.worktrees/i', task_ids: ['t1'], passed: true, exit_code: 0, spawn_error: null, stdout_tail: TAIL, stderr_tail: '' },
      { argv: ['npm', 'run', 'lint'], cwd: 'C:/r.worktrees/i', task_ids: ['t1'], passed: false, exit_code: 2, spawn_error: null, stdout_tail: 'lint error', stderr_tail: '' }] };
  const c = V.integrate(r);
  assert.deepStrictEqual([c.id, c.state, c.into_branch, c.head_sha, c.worktree, c.merged, c.conflict, c.passed], ['i1', 'evaluated', 'belay/integrate/r', 'h', 'C:/r.worktrees/i', r.merged, null, false]);
  for (const k of ['repo', 'junctions', 'base_sha', 'created_worktree']) assert.ok(!(k in c), k);
  assert.deepStrictEqual(c.checks[0], { argv: ['npm', 'test'], task_ids: ['t1'], passed: true, exit_code: 0 });
  assert.strictEqual(c.checks[1].stdout_tail, 'lint error');
});

test('eight evaluated tasks list in under a fifth of their full rows', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => row({ id: `0b6f4a9e-3c1d-4f7a-9e2b-8d5c6a7f1e3${i}` }));
  const full = Buffer.byteLength(JSON.stringify({ tasks }));
  const compact = Buffer.byteLength(JSON.stringify(V.taskList({ tasks })));
  assert.ok(compact * 5 < full, `${compact} of ${full} bytes`);
});

test('fields the views do not name pass through both shapes: integration and review, as another change may add them', () => {
  const integration = { state: 'merged', into: 'belay/integrate/r', id: 'i1' };
  const review = { task_id: 'rv1', verdict: 'holds' };
  for (const shape of [V.compactTask(row({ integration, review })), V.compactTask(row({ integration, review }), { detail: true })]) {
    assert.deepStrictEqual([shape.integration, shape.review], [integration, review]);
  }
});

test('a listing keeps flaky and timed_out, at the results level and per check', () => {
  const slow = { ...check(false), detail: { ...check(false).detail, timed_out: true } };
  const flaky = { ...check(true), flaky: true };
  const s = V.compactTask(row({ results: { evaluated_at: 7, executable: true, passed: false, flaky: true, timed_out: true, checks: [slow, flaky] } }));
  assert.deepStrictEqual(s.results, { passed: false, executable: true, flaky: true, timed_out: true, checks: 2,
    failing: ['command npm test exit 1 timed out'], flaky_checks: ['command npm test exit 0 flaky'] });
  const d = V.compactTask(row({ results: { passed: false, checks: [slow, flaky] } }), { detail: true });
  assert.deepStrictEqual([d.results.checks[0].detail.timed_out, d.results.checks[1].flaky], [true, true]);
});

test('task_ids naming no task answers not_found with those ids, in the compact and the debug view', async () => {
  const run = async () => ({ tasks: [row()] });
  const one = await V.viewed('task_list', { task_ids: ['t1', 'nope'] }, run);
  assert.deepStrictEqual([one.tasks.map((t) => t.id), one.not_found], [['t1'], ['nope']]);
  assert.strictEqual((await V.viewed('task_list', { task_ids: ['t1'] }, run)).not_found, undefined, 'absent when every id was found');
  assert.deepStrictEqual((await V.viewed('task_list', { task_ids: ['gone'], view: 'debug' }, run)), { tasks: [], not_found: ['gone'] });
});

test('ADR 0060: review is kept in both shapes and dropped when null; a shared tree keeps inherited_from; a flaky pass keeps its attempts', () => {
  const review = { state: 'refuted', review_id: 'r1', rounds: 2, rounds_left: 0 };
  assert.deepStrictEqual([V.compactTask(row({ review })).review, V.compactTask(row({ review }), { detail: true }).review], [review, review]);
  assert.ok(!('review' in V.compactTask(row({ review: null }))) && !('review' in V.compactTask(row({ review: null }), { detail: true })));
  const shared = row({ worktree: { repo: 'C:/r', path: 'C:/r.worktrees/t0', branch: 'belay/t0', base_sha: 'b', inherited_from: 't0' } });
  assert.deepStrictEqual(V.compactTask(shared, { detail: true }).worktree, { path: 'C:/r.worktrees/t0', branch: 'belay/t0', inherited_from: 't0' });
  assert.deepStrictEqual(V.compactTask(row(), { detail: true }).worktree, { path: 'C:/r.worktrees/t1', branch: 'belay/t1' });
  const attempts = [{ exit_code: 1, timed_out: false, ms: 5, stderr_tail: 'boom' }, { exit_code: 0, timed_out: false, ms: 6 }];
  const flaky = { ...check(true), flaky: true, detail: { ...check(true).detail, attempts } };
  const d = V.compactTask(row({ results: { evaluated_at: 7, executable: true, passed: true, flaky: true, checks: [flaky] } }), { detail: true });
  assert.deepStrictEqual([d.results.flaky, d.results.checks[0].flaky, d.results.checks[0].detail.attempts], [true, true, attempts]);
});
