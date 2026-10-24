'use strict';
// note-evaluate-cite.test.cjs — ADR 0057 decision 7 (C10): a note's evidence may cite a task_evaluate result, belay checks the quote against what the
// evaluated commands printed when the note is written (never their argv), a cite names a task of the caller's own run, and a reviewer may cite the
// same form. Real Engine, real task.evaluate runs (one node command each).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');
const rows = require('../../src/core/rows.cjs');
const EC = require('../../src/core/evaluate-cite.cjs');

// The printed line is built at run time, so the quote is in the command's output and nowhere in its argv.
const PRINTS = 'console.log(["ok 14 suites", "212 tests passed"].join(", "))';
let X, task, rev, failTask, failRev;
before(async () => {
  X = await setup('r-ec');
  const t = await X.call('task.create', X.orch, { spec: 'run the suite', acceptance: { commands: [{ argv: [process.execPath, '-e', PRINTS], timeout_ms: 20000 }] } });
  task = t.id;
  rev = (await X.call('task.evaluate', X.orch, { task_id: task, worktree: X.dir })).seq;
  // A run that failed: its argv claims success, its output says something else.
  const f = await X.call('task.create', X.orch, { spec: 'a failing suite', acceptance: { commands: [{ argv: [process.execPath, '-e', 'console.log(["3 of", "212 failed"].join(" ")); process.exit(1) // all 212 tests passed'], timeout_ms: 20000 }] } });
  failTask = f.id;
  failRev = (await X.call('task.evaluate', X.orch, { task_id: failTask, worktree: X.dir })).seq;
});
after(() => X.cleanup());

const note = (where, saw, marker) => ({ kind: 'lesson', title: `the suite runs clean after the ${marker} change`, when: `change the ${marker} loader`, basis: 'observed', evidence: [{ where: 'src/x.js', saw: 'a line' }, { where, saw }] });
const count = () => X.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;

test('EC1: a note citing an evaluation by rev is checked, and the check is recorded on the note and shown in the compact search', async () => {
  assert.ok(!PRINTS.includes('212 tests passed'), 'the quote is not in the argv');
  const out = await X.call('memory.store', X.orch, { namespace: 'project', ...note(`evaluate:${task}@${rev}`, '212 tests passed', 'one') });
  const b = X.bodyOf(out.id);
  assert.deepStrictEqual(b.evidence_checked.map((c) => [c.index, c.ok, c.by, c.task_id, c.rev, c.passed]), [[1, true, 'evaluate', task, rev, true]]);
  assert.strictEqual(X.rowOf(out.id).status || 'unverified', 'unverified', 'the claim stays a review\'s to verify');
  const s = await X.call('memory.search', X.orch, { query: 'suite runs clean one', mode: 'keyword', view: 'compact' });
  const hit = s.results.find((r) => r.id === out.id);
  assert.deepStrictEqual(hit.evidence.map((e) => [!!e.checked, e.passed]), [[false, undefined], [true, true]]);
});

test('EC2: evaluate:<task> names the latest evaluation; a quote it did not print, an unknown task or rev, and a version with no evaluation are refused and write nothing', async () => {
  const ok = await X.call('memory.store', X.orch, { namespace: 'project', ...note(`evaluate:${task}`, 'ok 14 suites', 'two') });
  assert.strictEqual(X.bodyOf(ok.id).evidence_checked[0].rev, rev);
  const before = count();
  const created = await X.call('task.create', X.orch, { spec: 'never evaluated', acceptance: { commands: [{ argv: [process.execPath, '-e', '0'] }] } });
  for (const [where, saw, re] of [
    [`evaluate:${task}@${rev}`, '213 tests passed', /the quote is not in what the evaluation/],
    ['evaluate:no-such-task', '212 tests passed', /there is no task/],
    [`evaluate:${task}@999999`, '212 tests passed', /has no row version/],
    [`evaluate:${created.id}`, 'anything at all', /never been evaluated/],
    [`evaluate:${created.id}@${created.seq}`, 'anything at all', /carries no evaluation/],
  ]) {
    await assert.rejects(X.call('memory.store', X.orch, { namespace: 'project', ...note(where, saw, 'three') }), (e) => e.code === 'E_CITATION' && re.test(e.message) && e.detail.index === 1, where);
  }
  assert.strictEqual(count(), before, 'nothing written');
});

test('EC3: the argv is never evidence; a true quote from a failed run is checked and carries passed false', async () => {
  const before = count();
  await assert.rejects(X.call('memory.store', X.orch, { namespace: 'project', ...note(`evaluate:${failTask}@${failRev}`, 'all 212 tests passed', 'four') }),
    (e) => e.code === 'E_CITATION' && /the argv is not evidence/.test(e.message), 'the words are only in the command line of a command that exited 1');
  assert.strictEqual(count(), before);
  const out = await X.call('memory.store', X.orch, { namespace: 'project', ...note(`evaluate:${failTask}@${failRev}`, '3 of 212 failed', 'five') });
  assert.strictEqual(X.bodyOf(out.id).evidence_checked[0].passed, false);
  const s = await X.call('memory.search', X.orch, { query: 'suite runs clean five', mode: 'keyword', view: 'compact' });
  assert.deepStrictEqual(s.results.find((r) => r.id === out.id).evidence[1], { where: `evaluate:${failTask}@${failRev}`, saw: '3 of 212 failed', checked: true, passed: false });
  const text = EC.renderResults({ passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], exit_code: 1, passed: false, detail: { stdout_tail: 'ok\nnot ok 3 - parses', stderr_tail: '' } }] });
  assert.strictEqual(text, 'ok\nnot ok 3 - parses', 'only what the commands printed');
  assert.strictEqual(EC.check(X.E, `evaluate:${task}@${rev}`, 'npm').ok, false);
  assert.strictEqual(EC.check(X.E, `evaluate:${failTask}@${failRev}`, '212').ok, false, 'a fragment under six characters must be a whole line');
});

test('EC4: a reviewer cites an evaluation the same way, and a false quote fails by name', async () => {
  const { checkTaskCites } = require('../../src/core/memory-citations.cjs');
  const good = await checkTaskCites(X.E, task, [{ where: `evaluate:${task}@${rev}`, quote: 'ok 14 suites, 212 tests passed' }]);
  assert.deepStrictEqual(good, { ok: true, failures: [] });
  const bad = await checkTaskCites(X.E, task, [{ where: `evaluate:${task}`, quote: '0 tests failed today' }]);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.failures[0].reason, /the quote is not in what the evaluation/);
});

test('EC5: a cite names a task of the caller\'s run; the operator is unrestricted', async () => {
  // A task of another run, with an evaluation of its own.
  const results = { evaluated_at: Date.now(), executable: true, passed: true, checks: [{ kind: 'command', argv: ['x'], executable: true, exit_code: 0, passed: true, detail: { stdout_tail: 'other run printed this line' } }] };
  const other = rows.append(X.store, 'task', { id: 'ec-other-task', run_id: 'r-other', spec: 'elsewhere', acceptance: null, files_owned: null, state: 'done', results, depends_on: null }, 'orchestrator', Date.now());
  const before = count();
  await assert.rejects(X.call('memory.store', X.orch, { namespace: 'project', ...note(`evaluate:ec-other-task@${other.seq}`, 'other run printed this line', 'six') }),
    (e) => e.code === 'E_CITATION' && /is not a task of run r-ec/.test(e.message));
  assert.strictEqual(count(), before);
  assert.strictEqual(EC.check(X.E, 'evaluate:ec-other-task', 'other run printed this line', EC.scopeOf(X.orch)).ok, false);
  assert.strictEqual(EC.check(X.E, 'evaluate:ec-other-task', 'other run printed this line', EC.scopeOf(X.operator)).ok, true, 'the operator reads any run');
  assert.strictEqual(EC.scopeOf(X.worker('w-any')), 'r-ec', 'a worker is held to its run');
  const { checkTaskCites } = require('../../src/core/memory-citations.cjs');
  const cross = await checkTaskCites(X.E, task, [{ where: 'evaluate:ec-other-task', quote: 'other run printed this line' }]);
  assert.strictEqual(cross.ok, false, 'a reviewer cites tasks of the judged task\'s run only');
});

test('EC6: a rev stays checkable after later writes to the task, and evaluate:<task> still names the version the evaluation wrote', async () => {
  // A later write carries the results forward on a new row version, as every task write after an evaluation does.
  rows.append(X.store, 'task', { ...rows.current(X.store, 'task', task), spec: 'run the suite, edited' }, 'orchestrator', Date.now());
  const versions = rows.history(X.store, 'task', task);
  assert.ok(versions[versions.length - 1].seq > rev, 'a later version exists');
  const byRev = EC.check(X.E, `evaluate:${task}@${rev}`, '212 tests passed', 'r-ec');
  assert.deepStrictEqual([byRev.ok, byRev.rev], [true, rev]);
  const latest = EC.check(X.E, `evaluate:${task}`, '212 tests passed', 'r-ec');
  assert.deepStrictEqual([latest.ok, latest.rev], [true, rev], 'the evaluation\'s own version, not the one that carried it forward');
});
