'use strict';
require('../helpers/tmp.cjs'); // a plain `node --test` of this file keeps its temp dirs out of the real temp dir
// push-guard.test.cjs — the push check (ADR 0085): the matcher's table of refused and allowed shapes, the one hook process
// with and without --push, and which settings files carry the check (every worker, never the orchestrator's).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PG = require('../../src/run/push-guard.cjs');
const G = require('../../src/run/guard.cjs');
const L = require('../../src/run/launch.cjs');

const REFUSED = [
  'git push --help',
  'git push -h',
  'git -C x push --help',
  'gh pr create --help',
  'gh release create -h',
  'gh pr create --title "fix -h flag" --body x',
  'gh issue create -t "add -h" -b y',
  'gh pr comment 3 --body "see -h"',
  'gh pr merge 3 --subject "drop --help text"',
  'gh api -X DELETE repos/o/r/git/refs/heads/x -t --help',
  'git push origin main # -h',
  'git push origin main $(true -h )',
  'git push -o -h origin main',
  'Set-Location C:\\\ngit push origin main',
  'cd C:\\work\\\ngit push',
  'dir C:\\Work\\\ngh pr create -t x',
  'git ^\n push origin main',
  'git -C C:/repo \\\n  push origin main', // bash line continuation
  'git push \\\r\n  origin main',
  'git `\n  push origin main', // PowerShell line continuation
  'gh pr \\\n  create --title x',
  'git push>log.txt 2>&1',
  'git push<nul',
  'git push>>log.txt',
  'git subtree push --prefix=lib origin main',
  'git lfs push origin main',
  'git http-push https://example.com/r.git main',
  'gh api repos/o/r/issues -f title=x -t graphql',
  'gh api -X DELETE repos/o/r/git/refs/heads/x --jq graphql',
  'gh api repos/o/r/issues -f title=x -H graphql',
  'git push',
  'git push origin main',
  'git push -u origin feat/x',
  'git push --force-with-lease origin HEAD',
  'git push --dry-run',
  'git -C ../repo push origin main',
  'git --git-dir=.git --work-tree=. push',
  'git -c http.extraheader=x push origin main',
  'git --no-pager push',
  'GIT_SSH_COMMAND=ssh git push',
  'git.exe push origin main',
  '"C:/Program Files/Git/cmd/git.exe" push origin main',
  'git add -A && git commit -m x && git push',
  'git commit -m x; git push',
  'cd repo && git push',
  'echo y | git push',
  'cmd /c git push origin main',
  'cmd /c "git push"',
  'cmd.exe /c"git push"',
  `powershell -Command "git push origin main"`,
  `pwsh -c 'git push'`,
  `bash -c 'git push origin main'`,
  `bash -c "cd x && git -C y push"`,
  'g"it" push',
  '"git" "push"',
  'git ^push',
  'git `push',
  'x=$(git push)',
  'git send-pack origin main',
  'GIT push',
  'git push\n',
  'cat <<EOF\ngit push\nEOF',
  'gh pr create --title x --body y',
  'gh pr create',
  'gh pr merge 12 --squash',
  'gh pr close 3',
  'gh pr edit 3 --title x',
  'gh pr comment 3 --body hi',
  'gh pr review 3 --approve',
  'gh pr ready 3',
  'gh issue create --title x',
  'gh issue comment 3 -b x',
  'gh issue close 3',
  'gh release create v1 --notes x',
  'gh release delete v1',
  'gh release upload v1 a.zip',
  'gh repo create x --public',
  'gh repo delete x --yes',
  'gh repo fork',
  'gh repo sync',
  'gh repo edit --visibility private',
  'gh gist create a.txt',
  'gh workflow run ci.yml',
  'gh run rerun 12',
  'gh run cancel 12',
  'gh label create bug',
  'gh secret set X',
  'gh variable set X',
  'gh ssh-key add k.pub',
  'gh cache delete 1',
  'gh -R owner/repo pr create',
  'gh pr create -R owner/repo',
  'gh pr --repo owner/repo merge 3',
  'GH_TOKEN=x gh pr create',
  'gh.exe pr create',
  'cmd /c gh pr create',
  `powershell -c "gh pr merge 3"`,
  'g"h" pr create',
  'gh api -X POST repos/o/r/issues -f title=x',
  'gh api --method POST repos/o/r/issues',
  'gh api --method=DELETE repos/o/r/git/refs/heads/x',
  'gh api -X PATCH repos/o/r/pulls/3 -f state=closed',
  'gh api -X put repos/o/r/pulls/3/merge',
  'gh api -XPOST repos/o/r/issues',
  'gh api repos/o/r/issues -f title=x',
  'gh api repos/o/r/issues -F title=x',
  'gh api repos/o/r/issues -ftitle=x',
  'gh api repos/o/r/issues --field title=x',
  'gh api repos/o/r/issues --raw-field title=x',
  'gh api repos/o/r/issues --input body.json',
  'gh api graphql -f query="mutation { addStar(input:{starrableId:\\"x\\"}) { clientMutationId } }"',
  'gh api repos/o/r/pulls/3/merge --method PUT',
];

const ALLOWED = [
  'git subtree split --prefix=lib',
  'git lfs ls-files',
  'git lfs pull',
  'gh ruleset check main',
  'gh ruleset view 1',
  'gh api graphql -f query="{ viewer { login } }" -t graphql',
  undefined, null, '', 5,
  'git status',
  'git fetch origin',
  'git fetch --all --prune',
  'git pull --ff-only',
  'git log --oneline -5',
  'git log --grep push',
  'git diff origin/main...HEAD',
  'git show HEAD:src/x.js',
  'git add -A && git commit -m "fix the push path"',
  'git commit -m "push the button"',
  'git checkout push',
  'git branch push-fix',
  'git branch -D pushed',
  'git remote -v',
  'git remote add origin https://example.com/x.git',
  'git config --get remote.origin.url',
  'git config user.name push',
  'git merge --no-ff feat/push',
  'git rebase main',
  'git stash list',
  'git worktree list',
  'git rev-parse --git-dir',
  'git -C ../repo status',
  'git -c core.pager=cat log',
  'ls .git/push',
  'cd .git && ls',
  'cat C:/repo/.git/config',
  'echo pushed',
  'npm run push',
  'node scripts/pusher.js',
  'rg -n "push" src',
  'gh pr view 12',
  'gh pr view 12 --json state',
  'gh pr list',
  'gh pr list --state open',
  'gh pr diff 12',
  'gh pr status',
  'gh pr checks 12',
  'gh pr checkout 12',
  'gh -R owner/repo pr view 3',
  'gh pr view 3 -R owner/repo',
  'gh issue view 3',
  'gh issue list',
  'gh release view v1',
  'gh release list',
  'gh release download v1',
  'gh repo view',
  'gh repo view owner/repo --json name',
  'gh repo clone owner/repo',
  'gh run list',
  'gh run view 12 --log',
  'gh run watch 12',
  'gh run download 12',
  'gh workflow list',
  'gh workflow view ci.yml',
  'gh gist view abc',
  'gh label list',
  'gh secret list',
  'gh auth status',
  'gh search issues bug',
  'gh api repos/o/r',
  'gh api repos/o/r/pulls/3',
  'gh api repos/o/r/pulls --paginate',
  'gh api -X GET repos/o/r/issues -f state=open',
  'gh api --method GET repos/o/r/issues -f per_page=5',
  'gh api repos/o/r/contents/x -H "Accept: application/vnd.github.raw"',
  'gh api repos/o/r/pulls -q ".[].number"',
  'gh api graphql -f query="{ viewer { login } }"',
  'gh api user',
  'ghost pr create',
  'echo gh',
  'which gh',
  'github pr create',
];

// Stated limits (ADR 0085): a textual match refuses text that only names a push, and does not follow a path with a space, an alias, or a command
// assembled at run time or written to a script first.
const KNOWN_FALSE_POSITIVES = ['git log -S"git push" --oneline', 'echo "never run git push"', 'git commit -m "document gh pr create"'];
const KNOWN_ESCAPES = ['git -C "D:/work/My Repo" push', 'p=push; git $p', 'git -c alias.up=push up', `node -e "require('child_process').execSync(['git', 'push'].join(' '))"`, 'sh push.sh', 'git pu\\sh', 'powershell -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==', 'curl -X POST https://api.github.com/repos/o/r/issues'];

test('the stated limits: a command that only names a push is refused, and a shape the text cannot follow is allowed', () => {
  for (const c of KNOWN_FALSE_POSITIVES) assert.strictEqual(PG.refusal(c), PG.MESSAGE, c);
  for (const c of KNOWN_ESCAPES) assert.strictEqual(PG.refusal(c), null, c);
});

test('the matcher refuses every push and remote-write shape', () => {
  for (const c of REFUSED) assert.strictEqual(PG.refusal(c), PG.MESSAGE, JSON.stringify(c));
});

test('the matcher allows fetch, log, reads of a pull request, gh api GET and the rest of the allowed table', () => {
  for (const c of ALLOWED) assert.strictEqual(PG.refusal(c), null, JSON.stringify(c));
});

test('the refusal is one line and short enough to sit inside the deny JSON bound', () => {
  assert.ok(!PG.MESSAGE.includes('\n'));
  assert.ok(Buffer.byteLength(G.denyOutput(PG.MESSAGE), 'utf8') < 380);
  assert.match(PG.MESSAGE, /push/);
});

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('decide applies the push check only when asked, and the kill check stays first', () => {
  assert.strictEqual(G.decide(bash('git push origin main'), null, { push: true }), PG.MESSAGE);
  assert.strictEqual(G.decide(bash('git push origin main'), null, { push: false }), null);
  assert.strictEqual(G.decide(bash('git push origin main'), null), null);
  assert.strictEqual(G.decide(bash('git fetch'), null, { push: true }), null);
  assert.match(G.decide(bash('taskkill /F /IM node.exe && git push'), null, { push: true }), /exact pid/);
  assert.strictEqual(G.decide({ tool_name: 'PowerShell', tool_input: { command: 'git push' } }, null, { push: true }), PG.MESSAGE);
  assert.strictEqual(G.decide({ tool_name: 'Write', tool_input: { file_path: 'x.js', content: 'git push' } }, null, { push: true }), null, 'file contents are not scanned');
});

const HOOK = path.join(__dirname, '..', '..', 'src', 'run', 'guard-hook.cjs');
const run = (args, p) => spawnSync(process.execPath, [HOOK, ...args], { input: JSON.stringify(p), encoding: 'utf8', timeout: 10000 });

test('the hook process denies a push with --push, in one short deny, and says nothing without it', () => {
  const r = run(['--push'], bash('git push origin main'));
  assert.strictEqual(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.strictEqual(out.permissionDecisionReason, PG.MESSAGE);
  assert.ok(Buffer.byteLength(r.stdout, 'utf8') < 400);
  const n = run([], bash('git push origin main'));
  assert.strictEqual(n.status, 0);
  assert.strictEqual(n.stdout, '');
  for (const c of ['git fetch origin', 'git log --oneline', 'gh pr view 3', 'gh api repos/o/r']) assert.strictEqual(run(['--push'], bash(c)).stdout, '', c);
});

test('the hook block of a worker carries --push and the orchestrator\'s does not', () => {
  assert.match(G.hooksBlock({ push: true }).PreToolUse[0].hooks[0].command, /guard-hook\.cjs" --push$/);
  assert.match(G.hooksBlock().PreToolUse[0].hooks[0].command, /guard-hook\.cjs"$/);
});

test('every worker settings file carries the push check; the headless orchestrator carries the guard without it; the interactive one none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pushguard-')).split(path.sep).join('/');
  try {
    const mcpPath = L.mcpServerPath();
    const cmd = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).hooks.PreToolUse[0].hooks[0].command;
    const w = L.writeWorkerFiles({ dir: `${dir}/w`, workerId: 'w1', runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null });
    const c = L.writeWorkerFiles({ dir: `${dir}/c`, workerId: 'w2', runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null, compactAt: 1000 });
    const o = L.writeOrchestratorFiles({ dir: `${dir}/o`, runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null, killGuard: true });
    const i = L.writeOrchestratorFiles({ dir: `${dir}/i`, runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null });
    for (const f of [w.settingsPath, c.settingsPath]) assert.match(cmd(f), / --push$/);
    assert.doesNotMatch(cmd(o.settingsPath), /--push/);
    assert.match(cmd(o.settingsPath), /guard-hook\.cjs"$/);
    assert.strictEqual(JSON.parse(fs.readFileSync(i.settingsPath, 'utf8')).hooks, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
