'use strict';
process.env.BELAY_TEST_MODE = '1';
// run-render-never-started.test.cjs — a belay run that never started (election, live-run or warm-up refusal)
// carries an all-null orchestrator block. The text says "never started: <reason>" and prints no pid,
// session, turn count or exit code rows of "null".

const { test } = require('node:test');
const assert = require('node:assert');
const { renderText } = require('../../src/cli/run-render.cjs');
const { emptyOrchestratorBlock } = require('../../src/cli/run-interactive.cjs');

const base = { run_id: 'r1', holds: [], polls: 0, receipt_path: null };

test('a refused run prints never started with the reason and no null rows', () => {
  const text = renderText({ ...base, orchestrator: emptyOrchestratorBlock(), ended_by: 'the election failed: E_X: boom' });
  assert.match(text, /^run_id: r1\nnever started: the election failed: E_X: boom\n/);
  assert.doesNotMatch(text, /null/);
  assert.doesNotMatch(text, /orchestrator pid|exit_code/);
});

test('a run that started keeps the orchestrator rows', () => {
  const text = renderText({ ...base, orchestrator: { ...emptyOrchestratorBlock(), pid: 42, session_id: 's', turns: 3, exit_code: 0 }, ended_by: 'idle' });
  assert.match(text, /orchestrator pid 42, session s, 3 turn\(s\)\nended_by: idle\nexit_code: 0\n/);
});
