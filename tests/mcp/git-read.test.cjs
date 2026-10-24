// git-read.test.cjs — ADR 0054 decision 2: the orchestrator's read-only git. The argv is belay's and nothing the caller
// passes becomes an option; a repository's own config cannot make a read run a program or write; output is bounded and
// marked; the adapter routes the tool for the orchestrator only. Every repository is a sandbox under the OS temp dir.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const G = require('../../src/mcp/git-read.cjs');
const PROC = require('../../src/core/process.cjs');
const { launch, sandboxDir } = require('./rpc.cjs');

const fwd = (p) => String(p).split('\\').join('/');

function repo(tag) {
  const dir = sandboxDir(`git-${tag}`);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git('commit', '-q', '-am', 'second');
  return { dir, git };
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

test('gitArgs: belay\'s argv per op, the rev after --end-of-options and the path after --', () => {
  const st = G.gitArgs({ op: 'status' });
  const pre = st.slice(0, st.indexOf('status'));
  for (const c of ['core.fsmonitor=false', 'log.showSignature=false', 'core.pager=cat', 'diff.autoRefreshIndex=false']) assert.strictEqual(pre[pre.indexOf(c) - 1], '-c', c);
  const hooks = pre.find((x) => x.startsWith('core.hooksPath='));
  assert.ok(hooks && !fs.existsSync(hooks.slice('core.hooksPath='.length)), 'hooks point at a directory that does not exist');
  assert.deepStrictEqual(st.slice(st.indexOf('status')), ['status', '--porcelain=v1', '--branch', '--untracked-files=normal', '--ignore-submodules=all']);
  const log = G.gitArgs({ op: 'log', rev: 'main..HEAD', path: 'src', n: 5 });
  assert.deepStrictEqual(log.slice(log.indexOf('--end-of-options')), ['--end-of-options', 'main..HEAD', '--', 'src']);
  assert.strictEqual(log[log.indexOf('-n') + 1], '5');
  for (const op of ['log', 'diff', 'show']) {
    const a = G.gitArgs({ op, stat: true });
    for (const f of ['--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--stat']) assert.ok(a.indexOf(f) >= 0 && a.indexOf(f) < a.indexOf('--end-of-options'), `${op} carries ${f} before the rev`);
  }
  assert.deepStrictEqual(G.gitArgs({ op: 'show' }).slice(-2), ['--end-of-options', 'HEAD'], 'show defaults to HEAD');
  assert.strictEqual(G.gitArgs({ op: 'log' })[G.gitArgs({ op: 'log' }).indexOf('-n') + 1], '20', 'log defaults to 20');
});

test('gitArgs: a rev or path that could be an option, a blob path or a malformed range is refused E_ARGS', () => {
  const refuse = (a, why) => assert.throws(() => G.gitArgs(a), (e) => e.code === 'E_ARGS', why);
  for (const rev of ['-p', '--output=C:/x', '--exec=x', 'HEAD:a.txt', 'a b', '', '..', '...', 'a....b', '-x..HEAD', 'HEAD..-x', 'a\nb', 42]) refuse({ op: 'log', rev }, JSON.stringify(rev));
  refuse({ op: 'show', rev: 'a..b' }, 'show takes one commit');
  refuse({ op: 'status', rev: 'HEAD' }, 'status takes no rev');
  refuse({ op: 'push' }, 'unknown op');
  refuse({ op: 'log', n: 0 }, 'n below 1');
  refuse({ op: 'log', n: 201 }, 'n above 200');
  refuse({ op: 'diff', n: 3 }, 'n is for log only');
  refuse({ op: 'diff', path: 'a\u0000b' }, 'control character in the path');
  refuse({ op: 'diff', stat: 'yes' }, 'stat must be a boolean');
  for (const rev of ['HEAD', 'HEAD~2', 'main..feat/x', 'v1.0...HEAD', 'main..', 'HEAD@{1}', 'abc123^{commit}', 'a1b2c3d']) assert.doesNotThrow(() => G.gitArgs({ op: 'log', rev }), rev);
  // A path that looks like an option is only ever a pathspec: it comes after `--`.
  const a = G.gitArgs({ op: 'diff', path: '--output=x' });
  assert.deepStrictEqual(a.slice(-2), ['--', '--output=x']);
});

test('gitEnv drops every inherited GIT_* variable and sets belay\'s own', () => {
  const env = G.gitEnv({ PATH: 'p', GIT_DIR: 'x', GIT_CONFIG_PARAMETERS: "'diff.external'='evil'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'evil', git_external_diff: 'evil' });
  for (const k of ['GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'git_external_diff']) assert.ok(!(k in env), k);
  assert.strictEqual(env.PATH, 'p');
  for (const [k, v] of Object.entries({ GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat' })) assert.strictEqual(env[k], v, k);
});

test('findGit answers from absolute PATH entries only, never the cwd', () => {
  const dir = sandboxDir('git-plant');
  try {
    fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git'), 'not git');
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const found = G.findGit();
      assert.ok(found, 'git is on PATH in any clone that runs these tests');
      assert.notStrictEqual(fwd(path.dirname(found)).toLowerCase(), fwd(dir).toLowerCase());
    } finally { process.chdir(prev); }
    assert.strictEqual(G.findGit({ PATH: '' }), null, 'no PATH, no git; never a relative lookup');
  } finally { rm(dir); }
});

test('the four ops read a real repository and return argv, exit code and output', async () => {
  const { dir } = repo('ops');
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    const st = await G.gitRead({ op: 'status', worktree: dir });
    assert.strictEqual(st.exit_code, 0);
    assert.match(st.out, /^## main/m);
    assert.match(st.out, /^ M a\.txt$/m);
    assert.strictEqual(st.worktree_from, 'worktree');
    assert.strictEqual(st.argv[0], 'git');
    const lg = await G.gitRead({ op: 'log', worktree: dir, n: 1 });
    assert.match(lg.out, /^[0-9a-f]{40} \S+ T\n {4}second\n?$/);
    const df = await G.gitRead({ op: 'diff', worktree: dir });
    assert.match(df.out, /^\+three$/m);
    const sh = await G.gitRead({ op: 'show', worktree: dir, rev: 'HEAD~1', stat: true });
    assert.match(sh.out, /first/);
    assert.match(sh.out, /a\.txt \| 1 \+/);
    const range = await G.gitRead({ op: 'log', worktree: dir, rev: 'HEAD~1..HEAD' });
    assert.match(range.out, /second/);
    assert.doesNotMatch(range.out, /first/);
    assert.strictEqual(range.truncated, false);
  } finally { rm(dir); }
});

test('reading never writes: status and diff on a stat-dirty file leave the index untouched and run no hook', async () => {
  const { dir, git } = repo('nowrite');
  const hookDir = sandboxDir('git-hooks');
  try {
    // A post-index-change hook, in .git/hooks and in a core.hooksPath the repository names: a diff that refreshed the index would run it.
    const hook = `#!/bin/sh\necho ran >> "${fwd(path.join(hookDir, 'MARK'))}"\n`;
    for (const d of [path.join(dir, '.git', 'hooks'), path.join(hookDir, 'h')]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'post-index-change'), hook, { mode: 0o755 }); }
    const index = path.join(dir, '.git', 'index');
    const f = path.join(dir, 'a.txt');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(f, later, later); // same content, new mtime: a plain `git status` would refresh and rewrite the index
    const before = { bytes: fs.readFileSync(index), mtime: fs.statSync(index).mtimeMs };
    for (const hooksPath of [null, fwd(path.join(hookDir, 'h'))]) {
      if (hooksPath) git('config', 'core.hooksPath', hooksPath);
      const st = await G.gitRead({ op: 'status', worktree: dir });
      assert.doesNotMatch(st.out, /a\.txt/, 'content unchanged, so nothing is reported');
      const df = await G.gitRead({ op: 'diff', worktree: dir });
      assert.strictEqual(df.out, '', 'no change to show');
      assert.ok(fs.readFileSync(index).equals(before.bytes), 'the index bytes are unchanged');
      assert.strictEqual(fs.statSync(index).mtimeMs, before.mtime, 'and its mtime');
      assert.ok(!fs.existsSync(path.join(dir, '.git', 'index.lock')));
      assert.ok(!fs.existsSync(path.join(hookDir, 'MARK')), `no hook ran (hooksPath ${hooksPath})`);
    }
  } finally { rm(dir); rm(hookDir); }
});

test('a repository\'s config cannot make a read run a program: external diff, textconv, fsmonitor and pager', async () => {
  const { dir, git } = repo('evil');
  const marks = sandboxDir('git-marks');
  try {
    const script = fwd(path.join(marks, 'mark.cjs'));
    fs.writeFileSync(script, "require('fs').writeFileSync(process.argv[2], 'ran');\n");
    const cmd = (name) => `"${fwd(process.execPath)}" "${script}" "${fwd(path.join(marks, name))}"`;
    git('config', 'diff.external', cmd('external'));
    git('config', 'diff.evil.textconv', cmd('textconv'));
    git('config', 'core.fsmonitor', cmd('fsmonitor'));
    git('config', 'core.pager', cmd('pager'));
    git('config', 'pager.log', cmd('pagerlog'));
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt diff=evil\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    for (const op of ['status', 'log', 'diff', 'show']) await G.gitRead({ op, worktree: dir, ...(op === 'log' ? { stat: true } : {}) });
    assert.deepStrictEqual(fs.readdirSync(marks).filter((n) => n !== 'mark.cjs'), [], 'no configured program ran');
  } finally { rm(dir); rm(marks); }
});

test('a clean filter from the repository\'s config does not run; the operator\'s global one is kept', async () => {
  const { dir, git } = repo('filter');
  const marks = sandboxDir('git-fmarks');
  const home = sandboxDir('git-home');
  try {
    const script = fwd(path.join(marks, 'mark.cjs'));
    fs.writeFileSync(script, "require('fs').writeFileSync(process.argv[2], 'ran'); process.stdin.pipe(process.stdout);\n");
    const cmd = (name) => `"${fwd(process.execPath)}" "${script}" "${fwd(path.join(marks, name))}"`;
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.dat filter=evil\n*.keep filter=keep\n');
    fs.writeFileSync(path.join(dir, 'a.dat'), 'x\n');
    fs.writeFileSync(path.join(dir, 'b.keep'), 'y\n');
    git('add', '.');
    git('commit', '-q', '-m', 'filtered');
    git('config', 'filter.evil.clean', cmd('local'));
    git('config', 'filter.evil.required', 'true');
    fs.writeFileSync(path.join(home, '.gitconfig'), `[filter "keep"]\n\tclean = ${cmd('global').replace(/"/g, '\\"')}\n`);
    const later = new Date(Date.now() + 5000);
    for (const n of ['a.dat', 'b.keep']) fs.utimesSync(path.join(dir, n), later, later);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const st = await G.gitRead({ op: 'status', worktree: dir }, { env });
    assert.ok(st.argv.includes('filter.evil.clean=') && st.argv.includes('filter.evil.required=false'), 'belay switched the local driver off');
    assert.ok(!st.argv.some((x) => x.startsWith('filter.keep.')), 'and left the global one');
    assert.ok(st.argv.indexOf('filter.evil.clean=') < st.argv.indexOf('status'), 'before the subcommand');
    await G.gitRead({ op: 'diff', worktree: dir }, { env });
    assert.ok(!fs.existsSync(path.join(marks, 'local')), 'the repository\'s clean filter did not run');
    assert.ok(fs.existsSync(path.join(marks, 'global')), 'the operator\'s global filter ran, as it would for a plain git');
  } finally { rm(dir); rm(marks); rm(home); }
});

test('a submodule is not read, so a clean filter in its own config does not run', async () => {
  const sub = repo('sub');
  const { dir, git } = repo('super');
  const marks = sandboxDir('git-smarks');
  try {
    git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', fwd(sub.dir), 's');
    git('commit', '-q', '-m', 'add s');
    const script = fwd(path.join(marks, 'mark.cjs'));
    fs.writeFileSync(script, "require('fs').appendFileSync(process.argv[2], 'ran'); process.stdin.pipe(process.stdout);\n");
    const modCfg = path.join(dir, '.git', 'modules', 's', 'config');
    fs.appendFileSync(modCfg, `[filter "evil"]\n\tclean = \\"${fwd(process.execPath)}\\" \\"${script}\\" \\"${fwd(path.join(marks, 'sub'))}\\"\n`);
    fs.writeFileSync(path.join(dir, 's', '.gitattributes'), '* filter=evil\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 's', 'a.txt'), later, later);
    for (const op of ['status', 'diff']) await G.gitRead({ op, worktree: dir });
    assert.ok(!fs.existsSync(path.join(marks, 'sub')), 'the submodule\'s filter did not run');
    execFileSync('git', ['status', '--porcelain'], { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.ok(fs.existsSync(path.join(marks, 'sub')), 'control: a plain git status runs it');
  } finally { rm(dir); rm(sub.dir); rm(marks); }
});

test('a timeout ends the call within its bound, even when a filter holds git\'s pipes, and kills the filter and its steps', async () => {
  const { dir, git } = repo('slow');
  const marks = sandboxDir('git-slow');
  const home = sandboxDir('git-slowhome');
  try {
    const script = fwd(path.join(marks, 'slow.cjs'));
    // The filter runs a step and, when that step ends, the next one, as a filter's own shell would (review finding: a
    // leaves-first kill let a parent start its next step). Each step writes its pid.
    fs.writeFileSync(script, [
      "const fs = require('fs'); const { spawn } = require('child_process'); const dir = require('path').dirname(process.argv[2]);",
      "fs.writeFileSync(process.argv[2], String(process.pid));",
      "const step = (n, ms, next) => { const c = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(dir)} + '/step${n}', String(process.pid)); setTimeout(() => {}, ${ms})`], { stdio: 'ignore' }); c.on('exit', next); };",
      "step(1, 60000, () => step(2, 120000, () => {}));",
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(home, '.gitconfig'), `[filter "slow"]\n\tclean = \\"${fwd(process.execPath)}\\" \\"${script}\\" \\"${fwd(path.join(marks, 'pid'))}\\"\n`);
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=slow\n');
    git('add', '.gitattributes');
    git('commit', '-q', '-m', 'attrs');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'a.txt'), later, later);
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const t0 = Date.now();
    await assert.rejects(G.gitRead({ op: 'status', worktree: dir }, { env, timeoutMs: 3000 }), (e) => e.code === 'E_GIT' && e.detail.reason === 'timeout' && e.detail.kill.ok === true && e.detail.kill.killed.length >= 1);
    const took = Date.now() - t0;
    assert.ok(took < 3000 + 15000 + 2000, `the call ended ${took} ms after it began, not when the filter let go`);
    const pid = Number(fs.readFileSync(path.join(marks, 'pid'), 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0, 'the filter started');
    assert.notStrictEqual(await PROC.waitPidGone(pid, { timeoutMs: 15000 }), null, 'and was killed with git');
    const step1 = Number(fs.readFileSync(path.join(marks, 'step1'), 'utf8'));
    assert.notStrictEqual(await PROC.waitPidGone(step1, { timeoutMs: 15000 }), null, 'its running step too');
    assert.ok(!fs.existsSync(path.join(marks, 'step2')), 'and it had no chance to start the next step');
  } finally { for (const d of [dir, marks, home]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } // a killed process's cwd handle can outlive its pid briefly
});

test('the system config\'s filters (git-lfs) are passed back as -c, so NOSYSTEM does not drop them', async () => {
  const { dir } = repo('sys');
  try {
    let listed = '';
    try { listed = execFileSync('git', ['config', '--system', '--null', '--get-regexp', '^filter\\.'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '' } }); } catch { /* none */ }
    const want = listed.split('\0').filter(Boolean).map((e) => (e.includes('\n') ? e.replace('\n', '=') : e));
    const st = await G.gitRead({ op: 'status', worktree: dir });
    for (const w of want) assert.ok(st.argv.includes(w), `${w} is passed back`);
    assert.strictEqual(st.argv.indexOf('status') > 0, true);
  } finally { rm(dir); }
});

test('output is bounded and the truncation is marked with the real size', async () => {
  const { dir } = repo('big');
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), `${'x'.repeat(80)}\n`.repeat(400));
    const r = await G.gitRead({ op: 'diff', worktree: dir }, { maxOut: 1000 });
    assert.strictEqual(r.truncated, true);
    assert.ok(r.bytes > 1000);
    assert.match(r.out, new RegExp(`\\[truncated: 1000 of ${r.bytes} bytes shown; narrow with path or stat\\]$`));
    assert.strictEqual(G.MAX_OUT, 16384, 'the default bound the listing names (16 KB)');
  } finally { rm(dir); }
});

test('which directory: worktree, task_id through the lookup, the run default, and each refusal', async () => {
  const { dir } = repo('where');
  try {
    const byTask = await G.gitRead({ op: 'status', task_id: 't1' }, { taskWorktree: async (id) => (id === 't1' ? dir : null) });
    assert.strictEqual(byTask.worktree_from, 'task t1');
    const byRun = await G.gitRead({ op: 'status' }, { runWorktree: dir });
    assert.strictEqual(byRun.worktree_from, 'run');
    const code = async (p, c) => assert.rejects(p, (e) => e.code === c);
    await code(G.gitRead({ op: 'status', task_id: 't2' }, { taskWorktree: async () => null }), 'E_NOT_FOUND');
    await code(G.gitRead({ op: 'status' }), 'E_ARGS');
    await code(G.gitRead({ op: 'status', worktree: dir, task_id: 't1' }), 'E_ARGS');
    await code(G.gitRead({ op: 'status', worktree: 'relative/dir' }), 'E_ARGS');
    for (const unc of ['//host/share', '\\\\host\\share', '\\\\?\\C:\\x']) await code(G.gitRead({ op: 'status', worktree: unc }), 'E_ARGS');
    await code(G.gitRead({ op: 'status', worktree: fwd(path.join(dir, 'missing')) }), 'E_NOT_FOUND');
    const plain = sandboxDir('git-norepo');
    try {
      await assert.rejects(G.gitRead({ op: 'log', worktree: plain }), (e) => e.code === 'E_GIT' && e.detail.reason === 'exit' && e.detail.exit_code !== 0);
    } finally { rm(plain); }
  } finally { rm(dir); }
});

test('over the wire: the orchestrator adapter runs git_read in its --worktree; a worker adapter is refused', async (t) => {
  const { dir } = repo('wire');
  const data = sandboxDir('git-wire');
  const o = launch({ role: 'orchestrator', data, extra: ['--worktree', dir] });
  const w = launch({ role: 'worker', data, workerId: 'wk-1' });
  t.after(async () => { await o.close(); o.kill(); await w.close(); w.kill(); rm(dir); rm(data); });
  await o.initialize();
  await w.initialize();
  assert.ok((await o.list()).some((x) => x.name === 'git_read'));
  assert.ok(!(await w.list()).some((x) => x.name === 'git_read'), 'a worker is not listed git_read');
  const r = await o.call('git_read', { op: 'log', n: 1 });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.strictEqual(r.structuredContent.worktree_from, 'run');
  assert.match(r.structuredContent.out, /second/);
  const bad = await o.call('git_read', { op: 'diff', rev: '--output=x' });
  assert.ok(bad.isError);
  assert.strictEqual(bad.structuredContent.error, 'E_ARGS');
  const denied = await w.call('git_read', { op: 'status', worktree: dir });
  assert.ok(denied.isError);
  assert.strictEqual(denied.structuredContent.error, 'E_ROLE');
});
