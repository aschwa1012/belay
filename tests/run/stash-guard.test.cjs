'use strict';
require('../helpers/tmp.cjs'); // a plain `node --test` of this file keeps its temp dirs out of the real temp dir
// stash-guard.test.cjs — the stash check (ADR 0087): the matcher's table, its place in the one hook process behind the worker role
// flag, and the worker settings files that carry it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SG = require('../../src/run/stash-guard.cjs');
const G = require('../../src/run/guard.cjs');
const L = require('../../src/run/launch.cjs');

const REFUSED = [
  'git stash', 'git stash push', 'git stash push -m wip', 'git stash -u', 'git stash save wip', 'git stash pop', 'git stash apply',
  'git stash apply stash@{1}', 'git stash drop', 'git stash clear', 'git stash create', 'git stash store abc', 'git stash branch b',
  'git stash -- file.js', 'git stash --keep-index', 'git stash>log.txt', 'git stash list && git stash pop', 'git stash list; git stash',
  'git -C ../repo stash', 'git -c core.pager=cat stash pop', 'git --git-dir=.git --work-tree=. stash', 'git --no-pager stash drop',
  'git.exe stash', '"C:/Program Files/Git/cmd/git.exe" stash pop', 'GIT_DIR=x git stash',
  'git add -A && git stash', 'git stash list $(git stash pop)', 'cd x | git stash',
  'cmd /c "git stash"', 'powershell -Command "git stash pop"', "bash -c 'git -C y stash'", 'g"it" stash', 'git ^stash', 'GIT STASH',
  'git \\\n  stash', 'git `\n  stash pop', 'Set-Location C:\\\ngit stash',
  'powershell -Command "& {git stash}"', 'Invoke-Command {git stash pop}', 'if (1) {git stash}', '& { git -C x stash drop }', 'powershell -Command "& {git stash list; git stash}"',
  'git-stash pop', 'git-stash.exe', 'C:/Program Files/Git/mingw64/libexec/git-core/git-stash.exe pop', '"git-stash" push',
  'git rebase --autostash main', 'git pull --rebase --autostash', 'git merge --autostash x', 'git -c rebase.autoStash=true rebase main', 'git -c merge.autostash=true merge x',
  'git update-ref -d refs/stash', 'git update-ref refs/stash HEAD', 'git reflog delete refs/stash@{0}', 'git reflog expire --expire=now refs/stash', 'git reflog expire --expire=now --all',
  'git config rebase.autostash true', 'git config --global merge.autoStash yes', 'git config rebase.autostash on', 'git config rebase.autostash 1', 'git -c rebase.autostash rebase main', 'git -c rebase.autostash=1 pull',
  'git stash --keep-index --help x', 'echo man; git-stash pop',
];
const ALLOWED = [
  'git stash list', 'git stash list --stat', 'git stash show', 'git stash show -p stash@{0}', 'git -C ../repo stash list', 'git.exe stash show',
  'git stash list>out.txt', 'git status', 'git commit -m "fix the stash path"', 'git checkout stash@{0} -- f', 'git branch stash-fix',
  'git stash-helper', 'git log --grep stash', 'echo stashed', 'ls .git/stash', 'git worktree add ../w', 'git switch -c tmp/x',
  'git reflog show refs/stash', 'npm run stash', 'rg -n "stash" src',
  'git rebase --no-autostash main', 'git pull --rebase', 'git update-ref refs/heads/x HEAD', 'git reflog', 'git reflog expire --expire=now refs/heads/x', 'docs/git-stash.md', 'cat docs/git-stash.md', '& {git status}', 'Invoke-Command {git stash list}',
  'git config --get rebase.autostash', 'git config rebase.autostash', 'git config rebase.autostash false', 'git config --global rebase.autoStash no', 'git config --unset rebase.autoStash',
  'git -c rebase.autostash=false rebase main', 'git -c merge.autostash=0 merge x', 'git config --get-all merge.autostash',
  'man git-stash', 'help git-stash', 'git stash --help', 'git stash -h', 'git -C x stash --help',
];

test('the matcher refuses every writing git stash shape', () => {
  for (const c of REFUSED) assert.strictEqual(SG.refusal(c), SG.MESSAGE, JSON.stringify(c));
});

test('the matcher allows the read-only list and show and text that only names a stash', () => {
  for (const c of ALLOWED) assert.strictEqual(SG.refusal(c), null, JSON.stringify(c));
});

// Stated limits (ADR 0087), the push check's: text that only names a stash is refused; an alias or a run-time command is not followed.
test('the stated limits: a command that only names a stash is refused, and a shape the text cannot follow is allowed', () => {
  for (const c of ['echo "never run git stash"', 'git commit -m "git stash pop"']) assert.strictEqual(SG.refusal(c), SG.MESSAGE, c);
  for (const c of ['git -c alias.s=stash s', 'p=stash; git $p', 'sh stash.sh', 'git sta\\sh']) assert.strictEqual(SG.refusal(c), null, c);
});

test('the refusal is one line, names the alternatives, and fits the deny JSON bound', () => {
  assert.ok(!SG.MESSAGE.includes('\n'));
  assert.match(SG.MESSAGE, /temporary branch/);
  assert.match(SG.MESSAGE, /git worktree add/);
  assert.match(SG.MESSAGE, /git commit -F/);
  assert.ok(Buffer.byteLength(G.denyOutput(SG.MESSAGE), 'utf8') < 400);
});

const tool = (tool_name, command) => ({ tool_name, tool_input: { command } });

test('decide applies the stash check with the worker role only; the kill and push checks stay first', () => {
  assert.strictEqual(G.decide(tool('Bash', 'git stash pop'), null, { push: true }), SG.MESSAGE);
  assert.strictEqual(G.decide(tool('PowerShell', 'git stash'), null, { push: true }), SG.MESSAGE);
  assert.strictEqual(G.decide(tool('Bash', 'git stash pop'), null, { push: false }), null);
  assert.strictEqual(G.decide(tool('Bash', 'git stash pop'), null), null);
  assert.strictEqual(G.decide(tool('Bash', 'git stash list'), null, { push: true }), null);
  assert.match(G.decide(tool('Bash', 'taskkill /F /IM node.exe && git stash'), null, { push: true }), /exact pid/);
  assert.match(G.decide(tool('Bash', 'git push && git stash'), null, { push: true }), /push/);
  assert.strictEqual(G.decide({ tool_name: 'Write', tool_input: { file_path: 'x.js', content: 'git stash' } }, null, { push: true }), null, 'file contents are not scanned');
});

const HOOK = path.join(__dirname, '..', '..', 'src', 'run', 'guard-hook.cjs');
const run = (args, p) => spawnSync(process.execPath, [HOOK, ...args], { input: JSON.stringify(p), encoding: 'utf8', timeout: 10000 });

test('the hook process denies a stash with --push in one short deny, and says nothing without it or for a read', () => {
  const r = run(['--push'], tool('Bash', 'git stash push -m x'));
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.strictEqual(out.permissionDecisionReason, SG.MESSAGE);
  assert.ok(Buffer.byteLength(r.stdout, 'utf8') < 400);
  assert.strictEqual(run([], tool('Bash', 'git stash pop')).stdout, '');
  for (const c of ['git stash list', 'git stash show -p', 'git status']) assert.strictEqual(run(['--push'], tool('Bash', c)).stdout, '', c);
});

test('a worker settings file carries the worker role that runs the stash check; the headless orchestrator\'s does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stashguard-')).split(path.sep).join('/');
  try {
    const mcpPath = L.mcpServerPath();
    const cmd = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
    const w = L.writeWorkerFiles({ dir: `${dir}/w`, workerId: 'w1', runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null });
    const o = L.writeOrchestratorFiles({ dir: `${dir}/o`, runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null, killGuard: true });
    const wc = cmd(w.settingsPath);
    assert.match(wc, / --push$/);
    assert.doesNotMatch(cmd(o.settingsPath), /--push/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
