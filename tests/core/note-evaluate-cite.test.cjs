'use strict';
// note-evaluate-cite.test.cjs — ADR 0057 decision 7 (C10): a note's evidence may cite a task_evaluate result, belay checks the quote against what the
// evaluation recorded when the note is written, and a reviewer may cite the same form. Real Engine, a real task.evaluate run (one node command).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./report-env.cjs');
const EC = require('../../src/core/evaluate-cite.cjs');

let X, task, rev;
before(async () => {
  X = await setup('r-ec');
  const t = await X.call('task.create', X.orch, { spec: 'run the suite', acceptance: { commands: [{ argv: [process.execPath, '-e', 'console.log("ok 14 suites, 212 tests passed")'], timeout_ms: 20000 }] } });
  task = t.id;
  rev = (await X.call('task.evaluate', X.orch, { task_id: task, worktree: X.dir })).seq;
});
after(() => X.cleanup());

const note = (where, saw, marker) => ({ kind: 'lesson', title: `the suite runs clean after the ${marker} change`, when: `change the ${marker} loader`, basis: 'observed', evidence: [{ where: 'src/x.js', saw: 'a line' }, { where, saw }] });

test('EC1: a note citing an evaluation by rev is checked, and the check is recorded on the note and shown in the compact search', async () => {
  const out = await X.call('memory.store', X.orch, { namespace: 'project', ...note(`evaluate:${task}@${rev}`, '212 tests passed', 'one') });
  const b = X.bodyOf(out.id);
  assert.deepStrictEqual(b.evidence_checked.map((c) => [c.index, c.ok, c.by, c.task_id, c.rev, c.passed]), [[1, true, 'evaluate', task, rev, true]]);
  assert.strictEqual(X.rowOf(out.id).status || 'unverified', 'unverified', 'the claim stays a review\'s to verify');
  const s = await X.call('memory.search', X.orch, { query: 'suite runs clean one', mode: 'keyword', view: 'compact' });
  const hit = s.results.find((r) => r.id === out.id);
  assert.deepStrictEqual(hit.evidence.map((e) => !!e.checked), [false, true]);
});

test('EC2: evaluate:<task> names the latest evaluation; a quote it did not print, an unknown task or rev, and a version with no evaluation are refused and write nothing', async () => {
  const ok = await X.call('memory.store', X.orch, { namespace: 'project', ...note(`evaluate:${task}`, 'ok 14 suites', 'two') });
  assert.strictEqual(X.bodyOf(ok.id).evidence_checked[0].rev, rev);
  const before = X.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
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
  assert.strictEqual(X.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n, before, 'nothing written');
});

test('EC3: the rendering a quote is checked against, and a short quote must be a whole line', () => {
  const text = EC.renderResults({ passed: false, checks: [{ kind: 'command', argv: ['npm', 'test'], exit_code: 1, passed: false, detail: { stdout_tail: 'ok\nnot ok 3 - parses', stderr_tail: '' } }] });
  assert.strictEqual(text, 'failed\ncommand npm test exit 1 failed\nok\nnot ok 3 - parses');
  const E = X.E;
  assert.strictEqual(EC.check(E, `evaluate:${task}@${rev}`, 'passed').ok, true, 'a whole line');
  assert.strictEqual(EC.check(E, `evaluate:${task}@${rev}`, 'pass').ok, false, 'a fragment under six characters is not');
});

test('EC4: a reviewer cites an evaluation the same way, and a false quote fails by name', async () => {
  const { checkTaskCites } = require('../../src/core/memory-citations.cjs');
  const good = await checkTaskCites(X.E, task, [{ where: `evaluate:${task}@${rev}`, quote: 'ok 14 suites, 212 tests passed' }]);
  assert.deepStrictEqual(good, { ok: true, failures: [] });
  const bad = await checkTaskCites(X.E, task, [{ where: `evaluate:${task}`, quote: '0 tests failed today' }]);
  assert.strictEqual(bad.ok, false);
  assert.match(bad.failures[0].reason, /the quote is not in what the evaluation/);
});
