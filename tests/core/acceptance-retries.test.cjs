'use strict';
// acceptance-retries.test.cjs — ADR 0060 decision 2: an acceptance command may carry retries_on_fail. One that fails and then
// passes on a retry passes, marked flaky on the check and on the results, with every attempt kept; one that fails every attempt
// fails; one that cannot run is never retried; and the release wake says flaky. Real core against a sandbox store; the flaky
// command is a script that fails until a marker file exists, so the order is fixed, not timed.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const RE = require('../../src/run/release-eval.cjs');

const { openCore } = core('index.cjs');

let dir, orch, script;
const workers = new Map();

before(async () => {
  dir = sandbox();
  script = path.join(dir, 'flaky.cjs');
  // Fails (exit 1) while fewer than `need` attempts have been made in the marker directory, then passes.
  fs.writeFileSync(script, [
    "const fs = require('fs'), path = require('path');",
    'const [mark, need] = [process.argv[2], Number(process.argv[3])];',
    'fs.mkdirSync(mark, { recursive: true });',
    'const n = fs.readdirSync(mark).length + 1;',
    "fs.writeFileSync(path.join(mark, String(n)), '');",
    "if (n < need) { process.stderr.write('attempt ' + n + ' failed'); process.exit(1); }",
  ].join('\n'));
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
});

after(async () => {
  for (const c of workers.values()) await c.close();
  try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(dir); }
});

let k = 0;
const flaky = (need, retries) => ({ argv: [process.execPath, script, path.join(dir, `mark-${++k}`), String(need)], timeout_ms: 20000, ...(retries === undefined ? {} : { retries_on_fail: retries }) });

async function released(acceptance) {
  const t = await orch.task.create({ spec: `task ${++k}`, acceptance });
  const id = `w-${k}`;
  await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now() });
  const w = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: id }), embed: false });
  workers.set(id, w);
  const a = await orch.task.assign({ task_id: t.id, worker_id: id });
  await w.lease.release({ lease_id: a.new_lease.id, reason: 'done' });
  return orch.task.evaluate({ task_id: t.id, worktree: dir });
}

test('a command that fails once and passes on its retry passes, marked flaky, with both attempts kept', async () => {
  const row = await released({ commands: [flaky(2, 2)] });
  const c = row.results.checks[0];
  assert.deepStrictEqual([row.state, row.results.passed, row.results.flaky, c.passed, c.flaky, c.exit_code], ['done', true, true, true, true, 0]);
  assert.deepStrictEqual(c.detail.attempts.map((a) => a.exit_code), [1, 0]);
  assert.match(c.detail.attempts[0].stderr_tail, /attempt 1 failed/);
  assert.strictEqual(c.ms, c.detail.attempts[0].ms + c.detail.attempts[1].ms);
  const text = RE.clause([RE.summaryOf(row)], 400);
  assert.match(text, /passed on a retry \(flaky\), done/);
});

test('a command that fails every attempt fails after 1 + retries_on_fail runs, and is not flaky', async () => {
  const row = await released({ commands: [flaky(9, 2)] });
  const c = row.results.checks[0];
  assert.deepStrictEqual([row.state, row.results.passed, row.results.flaky, c.passed, c.flaky], ['released', false, undefined, false, undefined]);
  assert.deepStrictEqual(c.detail.attempts.map((a) => a.exit_code), [1, 1, 1]);
  assert.match(RE.clause([RE.summaryOf(row)], 400), /not done; failing/);
});

test('with no retries_on_fail a command runs once; a steady pass carries no flaky and no attempts', async () => {
  const once = await released({ commands: [flaky(2)] });
  assert.deepStrictEqual([once.state, once.results.checks[0].exit_code, once.results.checks[0].detail.attempts], ['released', 1, undefined]);
  const steady = await released({ commands: [flaky(1, 3)] });
  assert.deepStrictEqual([steady.state, steady.results.flaky, steady.results.checks[0].flaky, steady.results.checks[0].detail.attempts], ['done', undefined, undefined, undefined]);
  assert.match(RE.clause([RE.summaryOf(steady)], 400), /passed, done/);
});

test('a command that cannot run is never retried', async () => {
  const row = await released({ commands: [{ argv: [path.join(dir, 'no-such-binary.exe')], retries_on_fail: 3 }] });
  const c = row.results.checks[0];
  assert.deepStrictEqual([c.executable, c.passed, c.detail.attempts], [false, false, undefined]);
});

test('task.create refuses a retries_on_fail that is not an integer from 0 to 5, writing nothing', async () => {
  const before = (await orch.task.list({})).tasks.length;
  for (const v of [6, -1, 1.5, '1']) {
    await assert.rejects(orch.task.create({ spec: 'bad', acceptance: { commands: [{ argv: ['x'], retries_on_fail: v }] } }),
      (e) => e.code === 'E_ARGS' && /retries_on_fail/.test(e.message), String(v));
  }
  assert.strictEqual((await orch.task.list({})).tasks.length, before);
  assert.ok(await orch.task.create({ spec: 'ok', acceptance: { commands: [{ argv: ['x'], retries_on_fail: 0 }] } }));
});

test('the budget runs out mid-retry: a retry is cut to what is left, and none starts once it is spent', async () => {
  const { runAcceptance } = require('./helpers.cjs').core('evaluate.cjs');
  // Fails at once on its first attempt, then hangs: the retry is cut at the budget, and no third attempt follows.
  const twoStep = path.join(dir, 'fail-then-hang.cjs');
  fs.writeFileSync(twoStep, [
    "const fs = require('fs'); const mark = process.argv[2];",
    "if (!fs.existsSync(mark)) { fs.writeFileSync(mark, ''); process.exit(1); }",
    'setInterval(() => {}, 1e6);',
  ].join('\n'));
  const [c] = await runAcceptance({ commands: [{ argv: [process.execPath, twoStep, path.join(dir, 'two-step-mark')], timeout_ms: 60000, retries_on_fail: 3 }] }, dir, null, { budgetMs: 1500 });
  assert.deepStrictEqual(c.detail.attempts.map((a) => a.timed_out), [false, true]);
  assert.strictEqual(c.detail.attempts[0].exit_code, 1);
  assert.ok(c.ms < 30000, `cut at the budget, not the command's own 60 s: ${c.ms}`);
  assert.deepStrictEqual([c.passed, c.flaky], [false, undefined]);
  // A command that spends the whole budget on its first attempt is not retried at all.
  const [h] = await runAcceptance({ commands: [{ argv: [process.execPath, '-e', 'setInterval(() => {}, 1e6)'], timeout_ms: 60000, retries_on_fail: 3 }] }, dir, null, { budgetMs: 1500 });
  assert.deepStrictEqual([h.detail.timed_out, h.detail.attempts], [true, undefined]);
});

test('ADR 0060 decision 6: the release wake and a listing say uncommitted changes; a committed pass says nothing more', () => {
  const V = require('../../src/mcp/views.cjs');
  const row = (results) => ({ id: 't-u', state: 'done', results: { evaluated_at: 1, executable: true, passed: true, checks: [], ...results } });
  assert.match(RE.clause([RE.summaryOf(row({ uncommitted: true }))], 400), /passed, done; uncommitted changes: commit before integrate/);
  assert.doesNotMatch(RE.clause([RE.summaryOf(row({}))], 400), /uncommitted/);
  assert.strictEqual(V.compactTask(row({ uncommitted: true, warning: 'w' })).results.uncommitted, true);
  assert.strictEqual(V.compactTask(row({ uncommitted: true, warning: 'w' }), { detail: true }).results.warning, 'w');
});
