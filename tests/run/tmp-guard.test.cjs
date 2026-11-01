'use strict';
require('../helpers/tmp.cjs');
// tmp-guard.test.cjs — the rooted-temp hook: a native program's '/tmp/x' is the root of the cwd's drive, not the session's
// temp folder. The decision function over path spellings and command shapes, the hook process's answer, and which settings
// files carry it. Every path here is a string; nothing touches the real C:/tmp.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const TG = require('../../src/run/tmp-guard.cjs');
const L = require('../../src/run/launch.cjs');

const TEMP = 'C:/Work/AppData/Local/Temp/belay-w1';
const file = (tool, p) => ({ tool_name: tool, tool_input: tool === 'NotebookEdit' ? { notebook_path: p } : { file_path: p } });
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

const BAD_PATHS = [
  '/tmp/x', '/tmp', '/tmp/', '/TMP/x', '/Tmp/a/b.js', '\\tmp\\x', '\\TMP', 'C:\\tmp\\x.js', 'c:/tmp/x', 'C:/TMP/x', 'D:\\Tmp',
  '/c/tmp/x', '/d/tmp', '//?/C:/tmp/x', 'C:/foo/../tmp/x', '/foo/../tmp/x', 'C:\\\\tmp\\\\x', 'C:/tmp/./x',
  'C:/tmp./x', 'C:/tmp /x', 'C:\\tmp.\\x', 'C:\\tmp \\x', '/tmp../x', '/tmp. /x', 'c:/TMP./x', '/tmp.',
];
const OK_PATHS = [
  'tmp/x', './tmp/x', 'C:\\Work\\a\\tmp\\x', 'C:/repo/tmp/x', '/home/tmp/x', '/tmpfoo/x', 'C:/tmpfoo', 'C:\\tmp-old\\x',
  'C:/tmp.old/x', 'C:/repo/tmp./x', 'C:/.../tmp/x', 'C:/Work/AppData/Local/Temp/x', `${TEMP}/x`, 'C:/repo/src/../src/tmp.js', '/c/Users/tmp', '', undefined, 5,
];

test('Write, Edit, MultiEdit and NotebookEdit to a rooted tmp path are refused, in every spelling and case', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    for (const p of BAD_PATHS) assert.ok(TG.refusal(file(tool, p), TEMP), `${tool} should refuse: ${p}`);
  }
});

test('a path that only resembles tmp is allowed', () => {
  for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
    for (const p of OK_PATHS) assert.strictEqual(TG.refusal(file(tool, p), TEMP), null, `${tool} should allow: ${String(p)}`);
  }
});

test('file tools the guard does not cover are allowed, and so is a payload with no input', () => {
  assert.strictEqual(TG.refusal(file('Read', '/tmp/x'), TEMP), null);
  assert.strictEqual(TG.refusal(file('Grep', '/tmp/x'), TEMP), null);
  for (const p of [null, undefined, 'x', {}, { tool_name: 'Write' }, { tool_name: 'Write', tool_input: null }]) assert.strictEqual(TG.refusal(p, TEMP), null);
});

const BAD_COMMANDS = [
  `node -e "require('fs').writeFileSync('/tmp/x','y')"`,
  `node --eval "fs.writeFileSync('/tmp/x','y')"`,
  `node -p "require('fs').readFileSync('/tmp/x','utf8')"`,
  `python -c "open('/tmp/x','w').write('y')"`,
  `python3 -c 'open("C:/tmp/x","w")'`,
  `py -c "open('/tmp/x','w')"`,
  `perl -e 'open(F,">/tmp/x")'`,
  `cd repo && node -e "fs.writeFileSync('C:\\\\tmp\\\\x','')"`,
  `node -e "fs.writeFileSync('/TMP/x','')"`,
  `pwsh -c "Set-Content '/tmp/x' 1"`,
  "cat > /tmp/mk.py <<'EOF'\nopen('/tmp/locking.js','w').write('x')\nEOF\npython /tmp/mk.py",
  'cat > mk.js <<EOF\nfs.writeFileSync("/tmp/moved.js", s)\nEOF\nnode mk.js',
  'node - <<"EOF"\nfs.writeFileSync(`/tmp/a`, 1)\nEOF',
  `node -e "console.log(1)" && node -e "fs.writeFileSync('/tmp/x','')"`,
  `python -c "print(1)"; python -c 'open("/tmp/x")'`,
  `node -p "'/tmp/x'" > out.txt`,
  `"C:/Program Files/nodejs/node.exe" -e "fs.writeFileSync('/tmp/x','')"`,
  `"C:/Python312/python.exe" -c "open('/tmp/x','w')"`,
  `node -r dotenv/config -e "fs.writeFileSync('/tmp/x','')"`,
  `node --require x --no-warnings -e "fs.writeFileSync('/tmp/x','')"`,
  `python -X utf8 -c "open('/tmp/x','w')"`,
  `python -W ignore -c "open('/tmp/x','w')"`,
  `node -e 'fs.writeFileSync("it'\\''s","");fs.writeFileSync("/tmp/x","")'`,
  `python -c 'import os'"; open('/tmp/x','w')"`,
  `node -e "$(printf %s "/tmp/x")"`,
  'cat > mk.py <<-EOF\n\topen("/tmp")\n\tEOF\npython mk.py',
  'cat <<EOF > a.js\nconst d = "C:\\\\tmp\\\\x";\nEOF',
];

const OK_COMMANDS = [
  '', 'ls /tmp', 'echo hi > /tmp/x', 'cp a.txt /tmp/b', 'cat /tmp/mv.js', 'node /tmp/mv.js', 'python /tmp/mk.py',
  "cat > /tmp/mv.js <<'EOF'\nconsole.log(1)\nEOF\nnode /tmp/mv.js",
  'cat <<EOF\nhi\nEOF\nls /tmp/x',
  'git commit -m "x"', 'node ./tmp/mv.js', 'node --test tests/run/launch.test.cjs', 'python -m pytest tests', 'mkdir -p tmp/x',
  `node -e "console.log(require('os').tmpdir())"`,
  `node -e "fs.writeFileSync(process.env.TEMP + '/x', 'y')"`,
  `node -e "fs.writeFileSync(path.join(os.tmpdir(), 'x'), 'y')"`,
  `python -c "import tempfile; print(tempfile.gettempdir())"`,
  `node -e "fetch('http://host/tmp/x')"`,
  `node -e "fs.readFileSync('./tmp/x')"`,
  `node -e "fs.readFileSync('/tmpfoo/x')"`,
  `node -e "fs.readFileSync('src/tmp/x')"`,
  `node -e "fs.readFileSync('x')" && cat /tmp/out`,
  `node -e "console.log(1)" > /tmp/out`,
  `python -c "print(1)" | tee /tmp/out`,
  `python -c 'print(1)'; ls /tmp/x`,
  `node -e 'console.log("it'\\''s")' && cat /tmp/out`,
  `"C:/Program Files/nodejs/node.exe" -e "console.log(1)" > /tmp/out`,
  `node -r dotenv/config -e "console.log(1)" ; ls /tmp/x`,
  `python -X utf8 -c "print(1)" | tee /tmp/out`,
  `node -e "console.log(\\"a\\")" && cat /tmp/out`,
  'python -X utf8 run.py -c /tmp/x',
  'python run.py -c /tmp/x', 'node a.js -p /tmp/x', 'perl -c /tmp/x.pl', 'grep -c foo /tmp/x', 'tar -c -f /tmp/a.tar src',
  'cat <<EOF\nuse $TMPDIR/tmp and ${TEMP}/tmp\nEOF',
];

test('a Bash command whose inline script or heredoc body names a rooted tmp path is refused', () => {
  for (const c of BAD_COMMANDS) assert.ok(TG.refusal(bash(c), TEMP), `should refuse: ${JSON.stringify(c)}`);
});

test('Bash paths that git bash converts itself, and scripts that do not name one, are allowed', () => {
  for (const c of OK_COMMANDS) assert.strictEqual(TG.refusal(bash(c), TEMP), null, `should allow: ${JSON.stringify(c)}`);
});

test('the refusal is one line and names the worker temp dir and the way out', () => {
  const m = TG.refusal(file('Write', '/tmp/x'), TEMP);
  assert.ok(!m.includes('\n'));
  assert.ok(m.includes(TEMP));
  assert.match(m, /os\.tmpdir|tempfile|\$TEMP/);
  assert.ok(TG.refusal(bash(`node -e "open('/tmp/x')"`), TEMP).includes(TEMP));
});

test('the whole deny JSON stays under 400 bytes however long the temp dir is, and keeps the rule', () => {
  const long = ['C:\\Work\\a-very-long-folder-name', ...Array.from({ length: 30 }, (_, i) => `segment-${i}-\u00e9\u00e9`), 'belay-w1'].join('\\');
  for (const dir of [TEMP, long, 'x'.repeat(2000), undefined]) {
    for (const p of [file('Write', '/tmp/x'), bash(`node -e "open('/tmp/x')"`)]) {
      const reason = TG.refusal(p, dir);
      const json = TG.denyOutput(reason);
      assert.ok(Buffer.byteLength(json, 'utf8') < 400, `deny JSON is ${Buffer.byteLength(json, 'utf8')} bytes`);
      assert.ok(!reason.includes('\n'));
      assert.match(reason, /^Do not write to \/tmp or <drive>:\\tmp: .*os\.tmpdir\(\), tempfile, \$TEMP\) or a path in your worktree\.$/);
    }
  }
  const cut = TG.refusal(file('Write', '/tmp/x'), long);
  assert.ok(cut.includes('belay-w1'), 'the end of the path, the part that names the worker, is kept');
});

test('the hook process bounds its answer the same way', () => {
  const dir = 'C:\\' + 'long\\'.repeat(200) + 'belay-w1';
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(file('Write', '/tmp/x')), encoding: 'utf8', timeout: 10000, env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir } });
  assert.strictEqual(r.status, 0);
  assert.ok(Buffer.byteLength(r.stdout, 'utf8') < 400);
  assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('the refusal names the process temp dir when none is passed', () => {
  assert.ok(TG.refusal(file('Write', '/tmp/x')).includes(os.tmpdir()));
});

const HOOK = path.join(__dirname, '..', '..', 'src', 'run', 'tmp-hook.cjs');
function runHook(input) { return spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', timeout: 10000, env: { ...process.env, TEMP, TMP: TEMP, TMPDIR: TEMP } }); }

test('the hook process answers a refused call with a PreToolUse deny and exit 0', () => {
  for (const p of [{ tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'y' } }, bash(`python -c "open('/tmp/x')"`)]) {
    const r = runHook(JSON.stringify({ hook_event_name: 'PreToolUse', ...p }));
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(TEMP));
  }
});

test('the hook process says nothing for an allowed call and for an unreadable payload', () => {
  for (const input of [JSON.stringify(file('Write', 'src/x.js')), JSON.stringify(bash('ls /tmp')), 'not json', '{}', '']) {
    const r = runHook(input);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  }
});

test('worker settings and the headless orchestrator settings register the hook beside the kill guard; the interactive orchestrator has neither', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-tmpguard-')).split(path.sep).join('/');
  try {
    const mcpPath = L.mcpServerPath();
    const w = L.writeWorkerFiles({ dir: `${dir}/w`, workerId: 'w1', runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null });
    const c = L.writeWorkerFiles({ dir: `${dir}/c`, workerId: 'w2', runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null, compactAt: 1000 });
    const o = L.writeOrchestratorFiles({ dir: `${dir}/o`, runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null, killGuard: true });
    const i = L.writeOrchestratorFiles({ dir: `${dir}/i`, runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null });
    for (const f of [w.settingsPath, c.settingsPath, o.settingsPath]) {
      const pre = JSON.parse(fs.readFileSync(f, 'utf8')).hooks.PreToolUse;
      assert.strictEqual(pre.length, 2);
      assert.match(pre[0].hooks[0].command, /kill-hook\.cjs"$/);
      assert.match(pre[1].matcher, /^Write\|Edit\|MultiEdit\|NotebookEdit\|Bash$/);
      assert.match(pre[1].hooks[0].command, /tmp-hook\.cjs"$/);
      assert.ok(pre[1].hooks[0].timeout <= 10);
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(i.settingsPath, 'utf8')).hooks, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
