'use strict';
// evaluate-tail.test.cjs — task.evaluate's stdout_tail and stderr_tail hold the END of a command's output (audit 0.3.1 C3).
// Before the fix only the first ~2 KB was kept, so the recorded "tail" of any real test run was the middle of its opening lines,
// and the summary line and the failing assertion were lost. The last test covers P5: the commands share one budget.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { core } = require('./helpers.cjs');
const { runAcceptance, runCommand } = core('evaluate.cjs');

const SCRIPT = "for (let i = 0; i < 500; i++) console.log('line ' + i); console.log('FINAL SUMMARY: 1 failed'); console.error('E'.repeat(3000) + ' last error'); process.exit(1);";

test('stdout_tail and stderr_tail hold the end of long output, and the sizes say how much there was', async () => {
  const [check] = await runAcceptance({ commands: [{ argv: [process.execPath, '-e', SCRIPT], timeout_ms: 20000 }] }, os.tmpdir(), null);
  assert.strictEqual(check.exit_code, 1);
  assert.match(check.detail.stdout_tail, /line 499\nFINAL SUMMARY: 1 failed\n$/);
  assert.match(check.detail.stderr_tail, / last error\n$/);
  const expected = Array.from({ length: 500 }, (_, i) => `line ${i}\n`).join('') + 'FINAL SUMMARY: 1 failed\n';
  assert.strictEqual(check.detail.stdout_bytes, Buffer.byteLength(expected));
  assert.ok(check.detail.stderr_bytes > 3000);
});

test('an acceptance command keeps its head and its tail with a marker naming the cut; git\'s short answers keep the head as before', async () => {
  const ends = await runCommand([process.execPath, '-e', SCRIPT], os.tmpdir(), 20000, { keep: 'ends' });
  assert.match(ends.stdout, /^line 0\nline 1\n/);
  assert.match(ends.stdout, /\n\[\.\.\. \d+ characters omitted \.\.\.\]\n/);
  assert.match(ends.stdout, /FINAL SUMMARY: 1 failed\n$/);
  const head = await runCommand([process.execPath, '-e', SCRIPT], os.tmpdir(), 20000);
  assert.match(head.stdout, /^line 0\n/);
  assert.ok(head.stdout.length <= 2000);
  assert.doesNotMatch(head.stdout, /omitted|FINAL/);
  assert.strictEqual(head.stdout_bytes, undefined);
});

test('short output is kept whole, with no marker', async () => {
  const r = await runCommand([process.execPath, '-e', "console.log('ok')"], os.tmpdir(), 20000, { keep: 'ends' });
  assert.strictEqual(r.stdout.replace(/\r/g, ''), 'ok\n');
});

// audit 0.3.1 P5: the commands share one budget inside the client's 600 s wait for task.evaluate.
test('the commands of one evaluation share a budget: a command is cut to what is left, and one past it is not run', async () => {
  const hang = [process.execPath, '-e', 'setInterval(() => {}, 1e6)'];
  const [first, second] = await runAcceptance({ commands: [{ argv: hang, timeout_ms: 60000 }, { argv: [process.execPath, '-e', '0'] }] }, os.tmpdir(), null, { budgetMs: 1500 });
  assert.strictEqual(first.detail.timed_out, true, 'the first command was cut at the budget, not its own 60 s');
  assert.ok(first.detail.budget_capped_ms <= 1500);
  assert.ok(first.ms < 30000, 'cut long before its own timeout: ' + first.ms);
  assert.strictEqual(second.executable, false);
  assert.match(second.detail.reason, /budget of 1500 ms/);
  assert.strictEqual(require('./helpers.cjs').core('evaluate.cjs').ACCEPTANCE_BUDGET_MS < 600000, true, 'inside the client\'s wait');
});
