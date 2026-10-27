'use strict';
// views.test.cjs — ADR 0058 amendment 3: the orchestrator's task answers are compact by default. A listing row keeps what the
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
  // A verdict check keeps its facts and drops its nulls (reason: null) and receipts.
  assert.deepStrictEqual(v, { ...verdict, detail: { verdict: 'refuted', summary: 's', by: 'r1', findings: [{ severity: 'blocking' }] } }, 'a verdict check keeps what a finding rests on');
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
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.strictEqual(V.isViewed(name), false, name);
    const same = { anything: 1 };
    assert.strictEqual(await V.viewed(name, { view: 'whatever' }, async () => same), same, name);
  }
});

test('integrate: the merge facts stay; the repository, junctions, base and a passing check\'s tails go', () => {
  const r = { id: 'i1', run_id: 'r', repo: 'C:/r', into_branch: 'belay/integrate/r', worktree: 'C:/r.worktrees/i', created_worktree: true, base_sha: 'b', head_sha: 'h',
    state: 'evaluated', task_ids: ['t1'], merged: [{ task_id: 't1', branch: 'belay/t1', sha: 's' }], conflict: null, error: null, passed: false, junctions: [{ path: 'x' }], removed_at: null,
    owner_pid: 4242, owner_boot: 1700000000000, stale: null, not_merged: [],
    checks: [{ argv: ['npm', 'test'], cwd: 'C:/r.worktrees/i', task_ids: ['t1'], passed: true, exit_code: 0, spawn_error: null, stdout_tail: TAIL, stderr_tail: '' },
      { argv: ['npm', 'run', 'lint'], cwd: 'C:/r.worktrees/i', task_ids: ['t1'], passed: false, exit_code: 2, spawn_error: null, stdout_tail: 'lint error', stderr_tail: '' }] };
  const c = V.integrate(r);
  assert.deepStrictEqual([c.id, c.state, c.into_branch, c.head_sha, c.worktree, c.merged, c.conflict, c.passed], ['i1', 'evaluated', 'belay/integrate/r', 'h', 'C:/r.worktrees/i', r.merged, null, false]);
  for (const k of ['repo', 'junctions', 'base_sha', 'created_worktree', 'owner_pid', 'owner_boot']) assert.ok(!(k in c), k);
  assert.deepStrictEqual([c.stale, c.not_merged], [null, []], 'stale and not_merged stay');
  assert.deepStrictEqual(c.checks[0], { check: 'npm test', passed: true, task_ids: ['t1'] });
  assert.deepStrictEqual([c.checks[1].check, c.checks[1].stdout_tail, c.checks[1].exit_code], ['npm run lint', 'lint error', 2], 'a failing check stays whole');
});

test('integrate: only what this call merged is listed; the tasks of earlier rows are a count, with the checks, forced and not_carried named', () => {
  const entry = (task_id, extra) => ({ task_id, branch: `belay/${task_id}`, sha: `sha-${task_id}`, already: false, by_this_call: true, carried_from: null, empty: false, judged_by: null, covers: [task_id], ...extra });
  const old = (task_id) => entry(task_id, { already: true, by_this_call: false, carried_from: 'i0', judged_by: 'rv-1' });
  const r = { id: 'i2', state: 'evaluated', into_branch: 'belay/integrate/r', head_sha: 'h2', task_ids: ['t3'], conflict: null, passed: true, not_merged: [], left_out: null,
    merged: [old('t1'), old('t2'), entry('t3', { judged_by: 'rv-3' })],
    forced: { task_ids: ['t3'], reason: 'test lands later', failing: [] }, reused_checks: [{ argv: ['npm', 'test'], reused_from: 'i0' }], not_carried: [{ task_id: 't9', reason: 'judged again' }],
    checks: [{ argv: ['C:/x/node.exe', '--test'], cwd: 'C:/w', passed: true, reused_from: 'i0', head_sha: 'h2' }, { argv: ['npm', 'run', 'lint'], cwd: 'C:/w', passed: true, exit_code: 0, stdout_tail: TAIL }] };
  const c = V.integrate(r);
  assert.deepStrictEqual(c.merged, [{ task_id: 't3', branch: 'belay/t3', sha: 'sha-t3', judged_by: 'rv-3' }], 'the merge of this call, without the carried-row bookkeeping');
  assert.strictEqual(c.carried, 2);
  assert.deepStrictEqual(c.checks, [{ check: 'node.exe --test', passed: true, reused_from: 'i0' }, { check: 'npm run lint', passed: true }]);
  assert.deepStrictEqual([c.forced, c.not_carried, 'reused_checks' in c], [r.forced, r.not_carried, false]);
  assert.ok(Buffer.byteLength(JSON.stringify(c)) < Buffer.byteLength(JSON.stringify(r)) * 0.7, 'smaller than the row');
  const none = V.integrate({ ...r, merged: [entry('t3')], forced: undefined, not_carried: undefined });
  assert.deepStrictEqual([none.carried, none.forced, none.not_carried], [undefined, undefined, undefined], 'nothing carried, nothing said');
});

test('integrate: view debug answers the whole row', async () => {
  const r = { id: 'i1', repo: 'C:/r', merged: [{ task_id: 't1', already: true, carried_from: 'i0' }] };
  assert.strictEqual(await V.viewed('integrate', { task_ids: ['t1'], view: 'debug' }, async () => r), r);
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

// The lean replies (try-2 feedback, token cost): task_create and task_worktree answer the new task's id, rev, state and spec head
// and its tree, not the spec back; one review's detail gives its hand-back once; git_read leaves out belay's own argv.
test('task_create answers id, rev, state and the spec head; a hold warning stays; view debug is the core row', async () => {
  const born = { seq: 12, id: 't9', run_id: 'r', spec: SPEC, acceptance: { commands: [{ argv: ['npm', 'test'] }] }, files_owned: ['a.js'], state: 'open', results: null, depends_on: [], handoff: null, repairs: null, worktree: null, written_at: 1, written_by: 'orchestrator' };
  const c = await V.viewed('task_create', { spec: SPEC }, async () => born);
  assert.deepStrictEqual(Object.keys(c), ['id', 'seq', 'state', 'spec_head']);
  assert.deepStrictEqual([c.id, c.seq, c.state], ['t9', 12, 'open']);
  assert.ok(c.spec_head.length <= V.SPEC_HEAD && c.spec_head.endsWith('...'));
  const warned = await V.viewed('task_create', { spec: SPEC }, async () => ({ ...born, overlaps: [{ task_id: 't1', paths: ['a.js'] }] }));
  assert.deepStrictEqual(warned.overlaps, [{ task_id: 't1', paths: ['a.js'] }], 'the other-tree hold warning stays');
  const bare = await V.viewed('task_create', { spec: 'no checks' }, async () => ({ ...born, acceptance: {}, warning: 'this task has no checks, so belay will never mark it done' }));
  assert.match(bare.warning, /never mark it done/, 'a warning the core adds stays');
  assert.strictEqual(await V.viewed('task_create', { spec: SPEC, view: 'debug' }, async () => born), born);
});

test('task_worktree answers the task as task_create does, its tree with path, branch and base, and a removal\'s receipt', async () => {
  const wt = { repo: 'C:/r', path: 'C:/r.worktrees/t1', branch: 'belay/t1', base_ref: 'HEAD', base_sha: 'b', junctions: [{ path: 'x', target: 'y' }], junctions_skipped: [], created_at: 1, created_by: 'orchestrator' };
  const made = await V.viewed('task_worktree', { task_id: 't1' }, async () => ({ ...row({ state: 'open', results: null, handoff: null }), seq: 3, worktree: wt }));
  assert.deepStrictEqual(made.worktree, { path: 'C:/r.worktrees/t1', branch: 'belay/t1', base_sha: 'b' });
  assert.deepStrictEqual([made.id, made.seq, made.state, 'spec' in made, 'acceptance' in made], ['t1', 3, 'open', false, false]);
  const skipped = V.VIEWED.task_worktree({ ...row(), worktree: { ...wt, junctions_skipped: [{ path: 'node_modules', reason: 'not ignored' }] } });
  assert.deepStrictEqual(skipped.worktree.junctions_skipped, [{ path: 'node_modules', reason: 'not ignored' }], 'a skipped junction is named');
  const removed = V.VIEWED.task_worktree({ ...row(), worktree: { ...wt, removed_at: 9 }, removal: { junctions_unlinked: ['x'], branch_deleted: false } });
  assert.deepStrictEqual([removed.worktree.removed_at, removed.removal], [9, { junctions_unlinked: ['x'], branch_deleted: false }]);
});

test('one review detail shows the verdict beside its summary and findings once: the check names what the hand-back carries', () => {
  const findings = [{ severity: 'blocking', where: 'lib/a.js:3', what: 'x'.repeat(300) }];
  const tree = { changed: false, changed_paths: [] };
  const h = { by: 'r1', at: 6, lease_id: 'l9', tree, result: { verdict: 'refuted', summary: 'the retry loses the last error', findings, extra: 'kept' } };
  const v = { kind: 'verdict', executable: true, passed: false, ms: 1, detail: { verdict: 'refuted', summary: 'the retry loses the last error', findings, judged_by: 'r1', lease_id: 'l9', tree, tree_changed: false } };
  const review = row({ acceptance: { verdict: true }, handoff: h, results: { executable: true, passed: false, checks: [v] } });
  const d = V.taskList({ tasks: [review] }, { task_ids: ['t1'] }).tasks[0];
  assert.deepStrictEqual(d.handoff.result, h.result, 'the hand-back keeps the verdict, the summary and the findings together');
  assert.ok(!('tree' in d.handoff) && !('in_verdict_check' in d.handoff), 'an unchanged tree is tree_changed false and no record, in the hand-back and in the check');
  const { in_handoff, ...rest } = d.results.checks[0].detail;
  assert.deepStrictEqual(in_handoff, ['summary', 'findings']);
  assert.deepStrictEqual(rest, { verdict: 'refuted', tree_changed: false }, 'the check drops the lease, who judged and the tree record: receipts');
  // A changed tree keeps its record, once, in the check: the prompt reads detail.tree.changed_paths.
  const moved = { changed: true, changed_paths: ['lib/a.js'] };
  const flagged = V.taskList({ tasks: [row({ acceptance: { verdict: true }, handoff: { ...h, tree: moved }, results: { executable: true, passed: false, checks: [{ ...v, detail: { ...v.detail, tree: moved, tree_changed: true } }] } })] }, { task_ids: ['t1'] }).tasks[0];
  assert.deepStrictEqual(flagged.handoff.in_verdict_check, ['tree']);
  assert.deepStrictEqual([flagged.results.checks[0].detail.tree, flagged.results.checks[0].detail.tree_changed], [moved, true]);
  assert.strictEqual(JSON.stringify(d).split('x'.repeat(300)).length - 1, 1, 'the findings appear once');
  assert.strictEqual(v.detail.findings, findings, 'the core row is not changed');
  // A hand-back that differs from the check (another lease, or findings the check cut) keeps everything in both.
  const other = V.taskList({ tasks: [row({ handoff: { ...h, lease_id: 'l8' }, results: { checks: [v] } })] }, { task_ids: ['t1'] }).tasks[0];
  assert.deepStrictEqual(other.handoff, { ...h, lease_id: 'l8' });
  assert.deepStrictEqual(other.results.checks[0].detail, { verdict: 'refuted', summary: v.detail.summary, findings, tree_changed: false }, 'a check that is no hand-back twin still loses its receipts');
  const cutCheck = { ...v, detail: { ...v.detail, findings: [] } };
  const cut = V.taskEvaluate(row({ handoff: h, results: { checks: [cutCheck] } }));
  assert.deepStrictEqual(cut.handoff.result.findings, findings, 'findings that differ stay in the hand-back');
  assert.deepStrictEqual(cut.results.checks[0].detail.findings, [], 'and in the check');
  assert.deepStrictEqual(cut.results.checks[0].detail.in_handoff, ['summary']);
});

test('a listing row omits nulls, empty lists and holds_files false; the detail of a task omits nulls and empty lists too, and keeps a false', () => {
  const bare = row({ depends_on: [], repairs: null, answers: null, base: null, holds_files: false, holder_pid_alive: null, last_checkpoint_id: null, last_checkpoint_at: null,
    lease: null, integration: null, review: null, results: { evaluated_at: 7, executable: true, passed: true, trigger: 'release', checks: [owned(true)] } });
  const s = V.compactTask(bare);
  for (const k of ['depends_on', 'repairs', 'answers', 'base', 'holds_files', 'holder_pid_alive', 'last_checkpoint_id', 'last_checkpoint_at', 'lease', 'integration', 'review']) assert.ok(!(k in s), `${k} is left out`);
  assert.ok(!('failing' in s.results), 'an empty failing list is left out');
  assert.deepStrictEqual([s.id, s.state, s.future_field, s.results.passed, s.results.checks], ['t1', 'released', 'kept', true, 1]);
  const kept = V.compactTask(row({ holds_files: true, depends_on: ['t0'], results: { executable: true, passed: false, checks: [check(false)] } }));
  assert.deepStrictEqual([kept.holds_files, kept.depends_on, kept.results.failing], [true, ['t0'], ['command npm test exit 1']]);
  const full = V.compactTask(bare, { detail: true });
  for (const k of ['depends_on', 'repairs', 'answers', 'base', 'holder_pid_alive', 'last_checkpoint_id', 'last_checkpoint_at', 'lease', 'integration', 'review']) assert.ok(!(k in full), `detail leaves out ${k} when it is null or empty (wording audit)`);
  assert.strictEqual(full.holds_files, false, 'a false that means something stays');
  assert.deepStrictEqual([full.id, full.state, full.future_field], ['t1', 'released', 'kept']);
  const some = V.compactTask(row({ depends_on: ['t0'], answers: null }), { detail: true });
  assert.deepStrictEqual([some.depends_on, 'answers' in some, some.lease.id], [['t0'], false, 'l2']);
});

test('a three-task listing costs fewer bytes than the same rows padded with their empty fields', () => {
  const task = (id, over = {}) => row({ id, depends_on: null, repairs: null, answers: null, base: null, holds_files: false, holder_pid_alive: null, last_checkpoint_id: null, last_checkpoint_at: null,
    lease: null, integration: null, review: null, state: 'done', results: { evaluated_at: 7, executable: true, passed: true, trigger: 'release', checks: [check(true), owned(true)] }, ...over });
  const rows = [task('t1'), task('t2'), task('t3', { depends_on: ['t1'], holds_files: true })];
  const lean = V.taskList({ tasks: rows }).tasks.map((t) => JSON.stringify(t).length);
  const padded = V.taskList({ tasks: rows }).tasks.map((t) => JSON.stringify({ depends_on: null, repairs: null, answers: null, base: null, holds_files: false, holder_pid_alive: null, last_checkpoint_id: null, last_checkpoint_at: null, lease: null, integration: null, ...t, results: { ...t.results, failing: [] } }).length);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  assert.ok(sum(lean) + 100 < sum(padded), `${sum(lean)} bytes against ${sum(padded)} with the empty fields`);
});

test('git_read leaves out belay\'s argv; view debug keeps it', async () => {
  const r = { op: 'log', worktree: 'C:/r', worktree_from: 'run', argv: ['git', '-c', 'core.fsmonitor=', '--no-pager', 'log', '-n', '5'], exit_code: 0, ms: 9, bytes: 40, truncated: false, out: 'abc subject\n' };
  const c = await V.viewed('git_read', { op: 'log' }, async () => r);
  assert.ok(!('argv' in c));
  assert.deepStrictEqual(c, { op: 'log', worktree: 'C:/r', worktree_from: 'run', exit_code: 0, ms: 9, bytes: 40, truncated: false, out: 'abc subject\n' });
  assert.strictEqual(await V.viewed('git_read', { op: 'log', view: 'debug' }, async () => r), r);
});

test('wording audit: a worker\'s lease_release answer is the task, its state, the lease and what it must act on, not the hand-back it just sent', () => {
  const core = { ...row({ state: 'released' }), last_checkpoint_id: 'c1', released_reason: 'done', handoff: { by: 'w1', at: 6, lease_id: 'l1', result: { branch: 'b', head: 'h' }, tree: { changed: false }, scratch: { bytes: 4, limit_bytes: 9 }, memory_ids_missing: [] } };
  const plain = V.leaseRelease(core, { lease_id: 'l1' });
  assert.deepStrictEqual(plain, { id: 't1', state: 'released', lease_id: 'l1' });
  assert.ok(Buffer.byteLength(JSON.stringify(plain)) < 80 && Buffer.byteLength(JSON.stringify(core)) > 1500, 'a few dozen bytes against the whole row');
  // Notes: stored ones are counted; a pending one is shown whole, with the line that says what to do; every stored id and every duplicate (with its reason) is proof of what was written; a report that was withheld or skipped is named, a plain mark is not echoed.
  const noted = V.leaseRelease({ ...core, notes: [{ index: 0, id: 'n1', state: 'stored', title: 'x' }, { index: 1, id: 'n2', state: 'pending', title: 'y', matches: [{ id: 'm9', similarity: 0.9 }] }, { index: 2, id: 'n3', state: 'duplicate', existing_type: 'note' }],
    reported_wrong: [{ id: 'z', marked: 'reported_wrong', withheld: false }, { id: 'y', marked: 'reported_wrong', withheld: true, withheld_why: 'breaker' }, { id: 'x', skipped: 'not_live', state: 'missing' }], pending: 1, next: 'settle n2 with memory_note_resolve', memory_ids: { ids: ['a'], recorded: true, event_id: 'e', seq: 3 } }, { lease_id: 'l1' });
  assert.deepStrictEqual(noted, { id: 't1', state: 'released', lease_id: 'l1', notes_written: 1, notes_stored: [{ index: 0, id: 'n1' }], notes_duplicate: [{ index: 2, id: 'n3', state: 'duplicate', existing_type: 'note' }], reported_wrong: [{ id: 'y', marked: 'reported_wrong', withheld: true, withheld_why: 'breaker' }, { id: 'x', skipped: 'not_live', state: 'missing' }], pending: 1, pending_notes: [{ index: 1, id: 'n2', state: 'pending', title: 'y', matches: [{ id: 'm9', similarity: 0.9 }] }], next: 'settle n2 with memory_note_resolve', memory_ids: { recorded: true } });
  // A warning, a dropped note set and a late hand-back are facts the worker needs.
  const warned = V.leaseRelease({ ...core, warning: 'w', notes_dropped: 2, lease_released_by: 'holder_dead', note: 'late' }, { lease_id: 'l1' });
  assert.deepStrictEqual([warned.warning, warned.notes_dropped, warned.lease_released_by, warned.note], ['w', 2, 'holder_dead', 'late']);
  assert.deepStrictEqual(V.leaseRelease({ ...core, handoff: { ...core.handoff, memory_ids_missing: ['gone'] } }, { lease_id: 'l1' }).memory_ids_missing, ['gone'], 'a cited id with no row is named');
  assert.strictEqual(V.leaseRelease(null, {}), null);
});

test('wording audit: status leaves out a notes_held that holds nothing, and keeps one that holds something or is malformed', () => {
  const zero = { total: 0, queued: 0, unsupported: 0, malformed: 0, by_project: {}, oldest_age_runs: 0 };
  const quiet = V.VIEWED.status({ verdict: 'alive', notes_held: zero, notes_unembedded: { total: 0 }, rungs: [] });
  assert.ok(!('notes_held' in quiet) && quiet.verdict === 'alive' && 'notes_unembedded' in quiet);
  assert.ok('notes_held' in V.VIEWED.status({ verdict: 'alive', notes_held: { ...zero, total: 2 } }));
  assert.ok('notes_held' in V.VIEWED.status({ verdict: 'alive', notes_held: { ...zero, malformed: 1 } }));
  assert.deepStrictEqual(V.VIEWED.status({ verdict: 'stopped' }), { verdict: 'stopped' });
  assert.ok(V.isViewed('status'));
});

test('wording audit: task_assign shows the lease it took as a lease; fix_from_review answers as task_create does, plus what belay inferred', async () => {
  const lease = { seq: 6, id: 'l2', task_id: 't1', run_id: 'r', holder: 'w1', holder_role: 'worker', granted_at: 1, expires_at: 9, ttl_ms: 8, released_at: null, supersedes: null, written_by: 'orchestrator', written_at: 1 };
  const as = await V.viewed('task_assign', { task_id: 't1', worker_id: 'w1' }, async () => ({ task: row(), old_lease: null, new_lease: lease, delivered: { sent: true } }));
  assert.deepStrictEqual(as.new_lease, { id: 'l2', holder: 'w1', holder_role: 'worker', expires_at: 9 });
  assert.deepStrictEqual([as.old_lease, as.delivered], [null, { sent: true }]);
  const cancelled = await V.viewed('task_cancel', { task_id: 't1' }, async () => ({ task: row(), released_lease: lease }));
  assert.strictEqual(cancelled.released_lease, lease, 'task_cancel is unchanged');
  const fixRow = { ...row({ id: 'fix1', state: 'open', results: null, handoff: null, worktree: { repo: 'C:/r', path: 'C:/r.worktrees/t1', junctions: [{ path: 'x' }] } }), seq: 4, repairs: 't1', depends_on: ['t1'], files_owned: ['a.js'], acceptance: { commands: [{ argv: ['npm', 'test'] }] } };
  const fix = await V.viewed('fix_from_review', { review_id: 'r1' }, async () => fixRow);
  assert.deepStrictEqual([fix.id, fix.seq, fix.state, fix.repairs, fix.depends_on, fix.files_owned], ['fix1', 4, 'open', 't1', ['t1'], ['a.js']]);
  for (const k of ['spec', 'acceptance', 'worktree', 'results', 'handoff', 'run_id', 'written_by']) assert.ok(!(k in fix), `${k} is left out`);
  assert.ok(Buffer.byteLength(JSON.stringify(fix)) < Buffer.byteLength(JSON.stringify(fixRow)) / 2);
  assert.strictEqual(await V.viewed('fix_from_review', { review_id: 'r1', view: 'debug' }, async () => fixRow), fixRow);
});
