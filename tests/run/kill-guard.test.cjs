'use strict';
require('../helpers/tmp.cjs');
// kill-guard.test.cjs — the kill-by-name hook (ADR 0024 amendment 7): the matcher's table, the hook process's
// JSON answer, and which settings files carry it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const KG = require('../../src/run/kill-guard.cjs');
const L = require('../../src/run/launch.cjs');

const REFUSED = [
  'taskkill /F /IM node.exe',
  'taskkill //F //IM node.exe',
  'TASKKILL /f /im node.exe /t',
  'taskkill.exe -im node.exe',
  'taskkill /IM:node.exe',
  'taskkill /F /FI "IMAGENAME eq node.exe"',
  'cmd /c "taskkill /F /IM node.exe"',
  'cmd //c taskkill //F //IM node.exe',
  'cmd /c"taskkill /f /im node.exe"',
  'powershell -Command "Stop-Process -Name node -Force"',
  'powershell -NoProfile -c "stop-process -name node"',
  'pwsh -c \'Stop-Process -ProcessName node\'',
  'Stop-Process -n node',
  'spps -Name node',
  'powershell -c "kill -Name node"',
  'Get-Process node | Stop-Process',
  'Get-Process -Name node | Stop-Process -Force',
  'gps node | spps',
  'powershell -c "Get-Process node | kill"',
  'Get-Process node; Stop-Process -Id 1234',
  'Stop-Process -Id (Get-Process node).Id',
  'pkill node',
  'pkill -f belay',
  'killall node',
  'killall -9 node',
  'kill $(pgrep node)',
  'kill -9 `pidof node`',
  'ps aux | grep node | awk \'{print $2}\' | xargs kill -9',
  'echo hi && taskkill /F /IM node.exe',
  'ls; pkill node || true',
  'bash -c "pkill node"',
  'bash -c \'cd x && taskkill //F //IM node.exe\'',
  'wmic process where name="node.exe" delete',
  'wmic process where "name=\'node.exe\'" call terminate',
  'wmic process where "commandline like \'%belay%\'" delete',
  'Get-CimInstance Win32_Process -Filter "name=\'node.exe\'" | Invoke-CimMethod -MethodName Terminate',
  'Get-WmiObject Win32_Process | Where-Object { $_.Name -eq "node.exe" } | ForEach-Object { $_.Terminate() }',
  'tskill node',
  'ta`skkill /F /IM node.exe',
  'tas^kkill /F /IM node.exe',
  't"ask"kill /F /IM node.exe',
  String.raw`C:\Windows\System32\taskkill.exe /F /IM node.exe`,
  '"C:/Windows/System32/taskkill.exe" //F //IM node.exe',
];

const ALLOWED = [
  '',
  'ls -la',
  'npm test',
  'node --test tests/run/launch.test.cjs',
  'taskkill /PID 1234',
  'taskkill //F //PID 1234',
  'taskkill /F /PID 1234 /T',
  'taskkill /F /FI "PID eq 1234"',
  'cmd /c "taskkill /F /PID 1234"',
  'Stop-Process -Id 1234',
  'Stop-Process -Id 1234 -Force',
  'spps -Id 42',
  'powershell -Command "Stop-Process -Id 1234"',
  'Get-Process -Id 1234 | Stop-Process',
  'kill 1234',
  'kill -9 1234',
  'kill -TERM 1234',
  'kill -n 9 1234',
  'wmic process where processid=1234 delete',
  'tskill 1234',
  'git log --grep="taskkill /IM"',
  'echo "do not use pkill"',
  'grep -rn killall src',
  'Get-Process -Id 1234',
  'Get-Process node',
  'node -e "process.kill(1234)"',
];

test('the matcher refuses every kill-by-name form, wrappers and chains included', () => {
  for (const c of REFUSED) assert.strictEqual(KG.refusal(c), KG.MESSAGE, `should refuse: ${c}`);
});

test('the matcher allows kill-by-pid and ordinary commands', () => {
  for (const c of ALLOWED) {
    if (c === 'git log --grep="taskkill /IM"' || c === 'echo "do not use pkill"' || c === 'grep -rn killall src') continue; // text mentioning a verb: see the next test
    assert.strictEqual(KG.refusal(c), null, `should allow: ${c}`);
  }
});

test('a command that only names a kill verb as text is a known false positive of the textual match', () => {
  // The match is a safety net, not a parser. These are refused today; the worker can quote differently or ask the orchestrator.
  for (const c of ['echo "do not use pkill"', 'grep -rn killall src']) assert.strictEqual(KG.refusal(c), KG.MESSAGE);
});

test('a non-string command is not refused', () => {
  for (const c of [undefined, null, 5, {}]) assert.strictEqual(KG.refusal(c), null);
});

test('the refusal is one line and says the pid rule', () => {
  assert.ok(!KG.MESSAGE.includes('\n'));
  assert.match(KG.MESSAGE, /exact pid/);
});

const HOOK = path.join(__dirname, '..', '..', 'src', 'run', 'kill-hook.cjs');
function runHook(input) { return spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', timeout: 10000 }); }

test('the hook process answers a refused Bash command with a PreToolUse deny and exit 0', () => {
  const r = runHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'taskkill //F //IM node.exe' } }));
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(out.hookSpecificOutput.permissionDecisionReason, KG.MESSAGE);
});

test('the hook process says nothing for an allowed command and for an unreadable payload', () => {
  for (const input of [JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'taskkill /PID 12' } }), 'not json', '{}', '']) {
    const r = runHook(input);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  }
});

function hooksOf(file) { return JSON.parse(fs.readFileSync(file, 'utf8')).hooks; }

test('worker settings and the headless orchestrator settings carry the hook; the interactive orchestrator does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-killguard-')).split(path.sep).join('/');
  try {
    const mcpPath = L.mcpServerPath();
    const w = L.writeWorkerFiles({ dir: `${dir}/w`, workerId: 'w1', runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null });
    const o = L.writeOrchestratorFiles({ dir: `${dir}/o`, runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null, killGuard: true });
    const i = L.writeOrchestratorFiles({ dir: `${dir}/i`, runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null });
    for (const f of [w.settingsPath, o.settingsPath]) {
      const h = hooksOf(f);
      assert.deepStrictEqual(Object.keys(h), ['PreToolUse']);
      assert.strictEqual(h.PreToolUse[0].matcher, 'Bash|PowerShell');
      assert.match(h.PreToolUse[0].hooks[0].command, /kill-hook\.cjs"$/);
      assert.ok(h.PreToolUse[0].hooks[0].timeout <= 10);
    }
    assert.strictEqual(hooksOf(i.settingsPath), undefined, "the interactive orchestrator is the operator's own session");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
