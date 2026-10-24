'use strict';
// evaluate-tail.audit.cjs — audit 0.3.1, core finding C3. Not globbed by `npm test` (*.audit.cjs).
// Run: node --test tests/audit-0-3-1/evaluate-tail.audit.cjs
//
// runCommand keeps the FIRST ~2,000 characters of a command's output (evaluate.cjs:53-54), and runAcceptance then reports the
// last 400 of those as `stdout_tail` (evaluate.cjs:169). For any command that prints more than 2,000 characters, the recorded
// "tail" is from the start of the output, and the real end (the test summary, the failing assertion) is lost.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { core } = require('../core/helpers.cjs');
const { runAcceptance } = core('evaluate.cjs');

test('C3: stdout_tail holds the end of the output', async () => {
  const script = "for (let i = 0; i < 500; i++) console.log('line ' + i); console.log('FINAL SUMMARY: 1 failed'); process.exit(1);";
  const [check] = await runAcceptance({ commands: [{ argv: [process.execPath, '-e', script], timeout_ms: 20000 }] }, os.tmpdir(), null);
  console.log(JSON.stringify({ exit_code: check.exit_code, stdout_tail_end: check.detail.stdout_tail.slice(-60) }));
  assert.match(check.detail.stdout_tail, /FINAL SUMMARY/);
});
