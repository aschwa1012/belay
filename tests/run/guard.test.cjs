'use strict';
require('../helpers/tmp.cjs'); // a plain `node --test` of this file keeps its temp dirs out of the real temp dir
// guard.test.cjs — the one guard hook (ADR 0024 amendment 7, ADR 0084): both checks in one process, the kill check first,
// each check's own rules unchanged (their tables live in kill-guard.test.cjs and tmp-guard.test.cjs).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const G = require('../../src/run/guard.cjs');
const KG = require('../../src/run/kill-guard.cjs');

const HOOK = path.join(__dirname, '..', '..', 'src', 'run', 'guard-hook.cjs');
const TEMP = path.join(__dirname, 'guard-test-temp').split(path.sep).join('/');
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const run = (p) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(p), encoding: 'utf8', timeout: 10000, env: { ...process.env, TEMP, TMP: TEMP, TMPDIR: TEMP } });

test('one Bash call needs one hook: the block has a single command whose matcher names every guarded tool', () => {
  const pre = G.hooksBlock().PreToolUse;
  assert.strictEqual(pre.length, 1);
  assert.strictEqual(pre[0].hooks.length, 1);
  for (const t of ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(pre[0].matcher.split('|').includes(t), t);
});

test('the one process refuses a kill by name, with the kill rule', () => {
  const r = run(bash('taskkill //F //IM node.exe'));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, KG.MESSAGE);
});

test('the one process refuses a rooted /tmp write by Bash and by the file tools, naming the temp dir', () => {
  for (const p of [bash(`node -e "require('fs').writeFileSync('/tmp/x','y')"`), { tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'y' } }]) {
    const out = JSON.parse(run(p).stdout).hookSpecificOutput;
    assert.strictEqual(out.permissionDecision, 'deny');
    assert.ok(out.permissionDecisionReason.includes(TEMP));
  }
});

test('a call that breaks both rules gets one deny, the kill rule, within the byte bound', () => {
  const r = run(bash(`taskkill //F //IM node.exe; node -e "require('fs').writeFileSync('/tmp/x','y')"`));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, KG.MESSAGE);
  assert.ok(Buffer.byteLength(r.stdout, 'utf8') < 400);
});

test('allowed calls and unreadable payloads get silence and exit 0', () => {
  for (const p of [bash('taskkill /PID 12'), bash('ls /tmp'), { tool_name: 'Write', tool_input: { file_path: 'src/x.js' } }]) {
    const r = run(p);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  }
  for (const input of ['not json', '{}', '']) {
    const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  }
});

test('decide ignores payloads without a tool_input object', () => {
  for (const p of [null, 5, {}, { tool_input: 'x' }]) assert.strictEqual(G.decide(p, TEMP), null);
});
