'use strict';
// interactive-launch.test.cjs — ADR 0037 decision 2: orchestratorInteractiveArgv keeps headless's
// hygiene and drops everything that belongs to `-p`. Argv only; no real claude is launched.

const { test } = require('node:test');
const assert = require('node:assert');

const launch = require('../../src/run/launch.cjs');

const base = {
  mcpJsonPath: 'C:\\run\\orch\\mcp.json',
  settingsPath: 'C:\\run\\orch\\settings.json',
  model: 'claude-opus-5-5',
  appendSystemPromptFile: 'C:\\run\\orch\\append.md',
  sessionId: 'eb5f5324-4668-48bb-bcc3-ffec0aaee15b',
  debugFile: 'C:\\run\\orch\\claude-debug.log',
};
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('interactive argv carries the hygiene flags, session id and debug file', () => {
  const a = launch.orchestratorInteractiveArgv(base);
  assert.strictEqual(after(a, '--model'), 'claude-opus-5-5');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.strictEqual(after(a, '--mcp-config'), 'C:/run/orch/mcp.json');
  assert.strictEqual(after(a, '--settings'), 'C:/run/orch/settings.json');
  assert.strictEqual(after(a, '--tools'), 'Read,Edit,Write,Glob,Grep,Bash');
  assert.ok(a.includes('--setting-sources='));
  assert.strictEqual(after(a, '--permission-mode'), 'auto'); // ADR 0021 default
  assert.strictEqual(after(a, '--append-system-prompt-file'), 'C:/run/orch/append.md');
  assert.strictEqual(after(a, '--session-id'), base.sessionId);
  assert.strictEqual(after(a, '--debug-file'), 'C:/run/orch/claude-debug.log');
});

test('interactive argv has nothing of -p, stream-json, verbose, resume or a positional prompt', () => {
  const a = launch.orchestratorInteractiveArgv({ ...base, effort: 'high', allowedTools: ['Read'] });
  for (const bad of ['-p', '--input-format', '--output-format', 'stream-json', '--verbose', '--resume']) {
    assert.ok(!a.includes(bad), `${bad} must not be present`);
  }
  // Decision 3: every element is a flag or the value of the flag before it; the last is a flag value.
  assert.strictEqual(a[a.length - 2], '--debug-file');
  assert.ok(a.indexOf('--allowedTools') > -1);
});

test('interactive argv matches the headless argv on every shared hygiene flag', () => {
  const opts = { ...base, effort: 'medium' };
  const i = launch.orchestratorInteractiveArgv(opts);
  const h = launch.orchestratorLaunchArgv(opts);
  for (const flag of ['--model', '--mcp-config', '--settings', '--tools', '--permission-mode', '--effort', '--append-system-prompt-file']) {
    assert.strictEqual(after(i, flag), after(h, flag), flag);
  }
  assert.ok(i.includes('--setting-sources=') && h.includes('--setting-sources='));
});

test('effort is passed only when given (ADR 0028) and permission mode is overridable', () => {
  assert.ok(!launch.orchestratorInteractiveArgv(base).includes('--effort'));
  const a = launch.orchestratorInteractiveArgv({ ...base, effort: 'high', permissionMode: 'default' });
  assert.strictEqual(after(a, '--effort'), 'high');
  assert.strictEqual(after(a, '--permission-mode'), 'default');
});

for (const missing of ['sessionId', 'debugFile', 'appendSystemPromptFile']) {
  test(`interactive argv throws without ${missing}`, () => {
    const o = { ...base }; delete o[missing];
    assert.throws(() => launch.orchestratorInteractiveArgv(o), new RegExp(missing));
  });
}

test('the headless argv is unchanged by the interactive one (still -p stream-json)', () => {
  const h = launch.orchestratorLaunchArgv(base);
  assert.strictEqual(h[0], '-p');
  assert.ok(h.includes('stream-json') && h.includes('--verbose'));
  assert.ok(!h.includes('--session-id') && !h.includes('--debug-file'));
});

test('interactive argv deep-equals the headless argv minus the -p machinery, plus --session-id and --debug-file, every option set', () => {
  const opts = { ...base, effort: 'high', allowedTools: ['Read', 'mcp__belay__ping'], permissionMode: 'default' };
  const headless = launch.orchestratorLaunchArgv({ ...opts, resumeSessionId: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const expected = [];
  for (let i = 0; i < headless.length; i++) {
    const a = headless[i];
    if (a === '-p' || a === '--verbose') continue;
    if (a === '--input-format' || a === '--output-format' || a === '--resume') { i += 1; continue; } // the flag and its value
    expected.push(a);
  }
  expected.push('--session-id', opts.sessionId, '--debug-file', 'C:/run/orch/claude-debug.log');
  assert.deepStrictEqual(launch.orchestratorInteractiveArgv(opts), expected);
  // Every option really was exercised, so an added flag cannot hide behind a default.
  for (const f of ['--effort', '--allowedTools', '--permission-mode', '--append-system-prompt-file']) assert.ok(expected.includes(f), f);
});

test('--plugin-dir is passed only when a plugin dir is given, and the parity with headless still holds (ADR 0037 amendment 5)', () => {
  assert.ok(!launch.orchestratorInteractiveArgv(base).includes('--plugin-dir'));
  const opts = { ...base, effort: 'high', permissionMode: 'default', pluginDir: 'C:\\run\\orch\\plugin' };
  const a = launch.orchestratorInteractiveArgv(opts);
  assert.strictEqual(after(a, '--plugin-dir'), 'C:/run/orch/plugin');
  assert.strictEqual(a.filter((x) => x === '--plugin-dir').length, 1);
  // Removing the plugin pair leaves exactly the argv without the option: the option adds nothing else.
  const without = launch.orchestratorInteractiveArgv({ ...opts, pluginDir: null });
  const i = a.indexOf('--plugin-dir');
  assert.deepStrictEqual([...a.slice(0, i), ...a.slice(i + 2)], without);
  assert.ok(!launch.orchestratorLaunchArgv(opts).includes('--plugin-dir'), 'the headless argv never carries a plugin');
});
