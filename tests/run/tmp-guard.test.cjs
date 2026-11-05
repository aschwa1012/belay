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
  'C:/tmp.old/x', 'C:/repo/tmp./x', 'C:/.../tmp/x', 'C:/Work/AppData/Local/Temp/x', `${TEMP}/x`, 'C:/repo/src/../src/tmp.js', '/c/Work/tmp', '', undefined, 5,
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
  `python -u -X utf8 -c "open('/tmp/x','w')"`,
  `node --inspect --require x -p "'/tmp/x'"`,
  `pwsh -NoProfile -ExecutionPolicy Bypass -c "Set-Content '/tmp/x' 1"`,
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
  'python -X utf8 run.py -c /tmp/x', 'python -u run.py -c /tmp/x', 'node --inspect app.js -p /tmp/x', 'python -m x -c /tmp/y',
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
  const long = ['C:\\Work\\a-very-long-folder-name',...Array.from({ length: 30 }, (_, i) => `segment-${i}-\u00e9\u00e9`), 'belay-w1'].join('\\');
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

const HOOK = path.join(__dirname, '..', '..', 'src', 'run', 'guard-hook.cjs');
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

test('worker settings and the headless orchestrator settings register the one guard hook, whose matcher covers the file tools and Bash; the interactive orchestrator has none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-tmpguard-')).split(path.sep).join('/');
  try {
    const mcpPath = L.mcpServerPath();
    const w = L.writeWorkerFiles({ dir: `${dir}/w`, workerId: 'w1', runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null });
    const c = L.writeWorkerFiles({ dir: `${dir}/c`, workerId: 'w2', runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null, compactAt: 1000 });
    const o = L.writeOrchestratorFiles({ dir: `${dir}/o`, runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null, killGuard: true });
    const i = L.writeOrchestratorFiles({ dir: `${dir}/i`, runId: 'r', dataDir: `${dir}/data`, mcpPath, settingsPath: null });
    for (const f of [w.settingsPath, c.settingsPath, o.settingsPath]) {
      const pre = JSON.parse(fs.readFileSync(f, 'utf8')).hooks.PreToolUse;
      assert.strictEqual(pre.length, 1);
      for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) assert.ok(pre[0].matcher.split('|').includes(t), t);
      assert.match(pre[0].hooks[0].command, /guard-hook.cjs"(?: --push)?$/);
      assert.ok(pre[0].hooks[0].timeout <= 10);
    }
    assert.strictEqual(JSON.parse(fs.readFileSync(i.settingsPath, 'utf8')).hooks, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ADR 0084 amendment 1: redirects, write commands, wrappers, scripts run by name, and the PowerShell tool.
const BS = '\\';
const ps = (command, extra = {}) => ({ tool_name: 'PowerShell', tool_input: { command }, ...extra });

const BAD_SHELL = [
  // (a) a redirect or write command naming a drive (Git Bash converts only a bare /tmp, so only the drive forms reach the root)
  'echo x > C:/tmp/f', 'echo x >&C:/tmp/f', 'echo x >& C:/tmp/f', 'echo x >> c:/tmp/f', 'echo x 2>C:/tmp/f', 'echo x &>/c/tmp/f', 'echo x >|C:/tmp/f', 'echo x | tee C:/tmp/f', 'echo x | tee -a /d/tmp/f',
  `echo x > "C:${BS}tmp${BS}f"`, 'cp a.txt C:/tmp/b', 'cp -t C:/tmp a.txt', 'mv a.txt //?/C:/tmp/b', 'mkdir -p C:/tmp/x', 'touch C:/tmp/x', 'install a C:/tmp/a',
  'dd if=a of=C:/tmp/b', 'curl -o C:/tmp/b http://h/x', 'wget -O C:/tmp/b http://h/x', 'FOO=1 env -i cp a C:/tmp/b',
  // (c) wrappers, to any depth up to three
  `bash -c 'echo x > C:/tmp/f'`, `sh -c "cp a C:/tmp/b"`, `bash -lc 'tee C:/tmp/f < a'`, `bash -c "bash -c 'echo x > C:/tmp/f'"`,
  `cmd //c "echo x > ${BS}tmp${BS}f"`, 'cmd /c "copy a /tmp/b"',`cmd /c "type a > C:${BS}tmp${BS}f"`, `cmd /s /c "md C:${BS}tmp${BS}x"`,
  `powershell -NoProfile -Command "Set-Content '/tmp/x' 1"`, `powershell -Command "'x' | Out-File /tmp/f"`, `pwsh -c "Add-Content -Path C:/tmp/f -Value x"`,
  `powershell -EncodedCommand ${Buffer.from("Set-Content '/tmp/x' 1", 'utf16le').toString('base64')}`,
  `bash -c "node -e \\"fs.writeFileSync('/tmp/x','')\\""`,
  // (b) a script that lives in the drive root's tmp
  'C:/tmp/run.cmd', 'node C:/tmp/s.js', 'python D:/tmp/s.py', 'bash /c/tmp/s.sh',
];
const OK_SHELL = [
  'echo x > /tmp/f', 'echo x >> /tmp/f', 'echo x 2> /tmp/f', 'echo x | tee /tmp/f', 'cp a /tmp/b', 'mkdir -p /tmp/x', `bash -c 'echo x > /tmp/f'`,
  'cp C:/tmp/a ./b', 'mv C:/tmp/a b', 'cat C:/tmp/a > out.txt', 'cat C:/tmp/a | tee out.txt', 'ls C:/tmp', 'diff C:/tmp/a b', 'echo x 2>&1 | tee out.txt',
  'echo "C:/tmp is the drive root"', 'git commit -m "no writes to C:/tmp"', 'echo x > src/tmp/f', 'echo x > C:/tmp.old/f', 'echo x > C:/tmpfoo',
  `bash -c 'echo hi'`, 'cmd /c dir',  'node ./tmp/mv.js', 'node nothere.js', 'curl -o out.bin http://h/tmp/x', 'curl http://h/x > C:/tmp.old/x',
];
const BAD_CD = [
  'cd C:/tmp && echo x > f', 'cd /c/tmp; cat > t1.py', `cd "C:${BS}tmp" && echo x >> out.txt`, 'pushd C:/tmp; touch x', 'cd C:/tmp && mkdir sub && cd sub && echo x > f', 'cd /d C:/tmp && echo x > f',
  'cd C:/tmp && echo x | tee out.txt', 'cd C:/tmp && cp a b', "bash -c 'cd C:/tmp && echo x > f'",
];
const OK_CD = [
  'cd C:/tmp && cat f', 'cd C:/tmp && echo x > /tmp/f', 'cd C:/tmp; cd ~/work; echo x > f', 'cd src && echo x > f', 'cd /tmp && echo x > f', 'cd C:/tmp && echo x >&2', 'cd C:/tmp && echo x > /dev/null', 'cd C:/tmp && echo x > ../out.txt', 'cd C:/tmp && cd /home/x && echo x > f', '(cd C:/tmp) ; echo x', 'cd C:/tmp.old && echo x > f',
];
const BAD_PS_CD = ['Set-Location C:' + BS + 'tmp; "a" > f', 'cd ' + BS + 'tmp; Get-Date | Out-File f', 'sl C:/tmp; Set-Content f x', 'Set-Location -Path /tmp; ni f'];
const BAD_PS = [
  `'x' | Out-File /tmp/f`, `Set-Content -Path C:${BS}tmp${BS}f -Value hi`, `Set-Content C:${BS}tmp${BS}f hi`, 'Add-Content /tmp/f x', 'New-Item -ItemType File -Path /tmp/x',
  'ni C:/tmp/x', `mkdir C:${BS}tmp${BS}x`, 'Get-Date | tee C:/tmp/f', 'Get-Date | Tee-Object -FilePath /tmp/f', 'Export-Csv -Path /tmp/x.csv -InputObject $o',
  'echo hi > /tmp/f', `echo hi >> C:${BS}tmp${BS}f`, `echo hi 2> ${BS}tmp${BS}err.txt`, 'Get-Process *> /tmp/p.txt',
  'Copy-Item a.txt /tmp/b', 'Copy-Item -Path a -Destination C:/tmp/', 'Copy-Item -Dest C:/tmp/ -Path a.txt', 'Copy-Item -Path a -D C:/tmp/b', `Move-Item -Path a -Dest C:${BS}tmp${BS}b`, 'Set-Content -Pa /tmp/x -Va hi', 'Out-File -FilePath /tmp/x', 'Out-File -Fi /tmp/x', `Move-Item a C:${BS}tmp${BS}a`, `copy a ${BS}tmp${BS}a`, `xcopy a C:${BS}tmp${BS} /y`,
  'Invoke-WebRequest http://h/x -OutFile /tmp/x', 'Out-File -FilePath:/tmp/f -InputObject x',
  '[IO.File]::WriteAllText("/tmp/x","y")', "[System.IO.File]::AppendAllText('C:/tmp/x','y')", "$w = New-Object IO.StreamWriter('/tmp/x')",
  `cmd /c "echo x > ${BS}tmp${BS}f"`, `bash -c 'echo x > C:/tmp/f'`, `node -e "fs.writeFileSync('/tmp/x','')"`, `Set-Location x; 'a' | Set-Content /tmp/a`,
];
const OK_PS = [
  'Get-Content /tmp/f', 'Get-ChildItem C:/tmp', 'Copy-Item C:/tmp/a ./b', 'Copy-Item -Path C:/tmp/a -Destination out.txt', 'Set-Content -Path x.txt -Value "/tmp/x"',
  'Set-Content x.txt -Encoding utf8 -Value C:/tmp/x', 'echo hi > out.txt', 'echo hi 2>&1', 'echo hi >&2', 'Copy-Item a b -Force', 'Set-Content x.txt -Va /tmp/v', '[IO.File]::ReadAllText("/tmp/x")', 'Get-Date | Out-File out.txt',
  'Write-Output "C:/tmp"', 'New-Item -Path src/tmp/x', `Out-File $env:TEMP${BS}x.txt`, 'Copy-Item a $env:TEMP', 'echo hi > C:/tmp.old/f', 'git commit -m "x"', '',
];

test('a shell redirect, write command, wrapper or script in tmp is refused when it names the drive root (Bash)', () => {
  for (const c of BAD_SHELL) assert.ok(TG.refusal(bash(c), TEMP), `should refuse: ${JSON.stringify(c)}`);
});

test('what git bash converts itself, and reads of the drive root, stay allowed (Bash)', () => {
  for (const c of OK_SHELL) assert.strictEqual(TG.refusal(bash(c), TEMP), null, `should allow: ${JSON.stringify(c)}`);
});

test('the PowerShell tool is guarded: every rooted spelling is the drive root, so bare /tmp is refused too', () => {
  for (const c of BAD_PS) assert.ok(TG.refusal(ps(c), TEMP), `should refuse: ${JSON.stringify(c)}`);
  for (const c of OK_PS) assert.strictEqual(TG.refusal(ps(c), TEMP), null, `should allow: ${JSON.stringify(c)}`);
});

test('a cd into the drive root tmp makes a following relative write a write there, until the next cd', () => {
  for (const c of BAD_CD) assert.ok(TG.refusal(bash(c), TEMP), `should refuse: ${JSON.stringify(c)}`);
  for (const c of OK_CD) assert.strictEqual(TG.refusal(bash(c), TEMP), null, `should allow: ${JSON.stringify(c)}`);
  for (const c of BAD_PS_CD) assert.ok(TG.refusal(ps(c), TEMP), `should refuse: ${JSON.stringify(c)}`);
});

test('a PowerShell call that is not a string command, or a tool the guard does not cover, is allowed', () => {
  for (const p of [{ tool_name: 'PowerShell', tool_input: {} }, { tool_name: 'PowerShell', tool_input: { command: 5 } }, { tool_name: 'Task', tool_input: { command: 'echo x > /tmp/f' } }]) assert.strictEqual(TG.refusal(p, TEMP), null);
});

test('the refusals added by the amendment keep the one-line rule and the 400-byte bound', () => {
  const dir = 'C:\\' + 'long\\'.repeat(200) + 'belay-w1';
  for (const p of [bash('echo x > C:/tmp/f'), ps('Set-Content /tmp/f x'), bash(`bash -c 'echo x > C:/tmp/f'`)]) {
    const reason = TG.refusal(p, dir);
    assert.ok(reason && !reason.includes('\n'));
    assert.ok(Buffer.byteLength(TG.denyOutput(reason), 'utf8') < 400);
  }
});

test('a script run by name is read when it was edited after the worker\'s first launch, and refused when its own text writes the drive root', () => {
  const WT = require('../../src/run/worker-temp.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-tmpscript-')).split(path.sep).join('/');
  try {
    const wtemp = WT.make('run-script', 'w1', { root: dir });
    const birth = WT.birthOf(wtemp);
    assert.ok(birth > 0);
    const put = (name, text, whenMs) => { const p = `${dir}/${name}`; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); const t = new Date(whenMs); fs.utimesSync(p, t, t); };
    const after = birth + 60 * 1000; const before = birth - 60 * 1000;
    put('w.js', "require('fs').writeFileSync('/tmp/x', 'y')\n", after);
    put('w.py', "open('/tmp/x', 'w').write('y')\n", after);
    put('w.sh', 'echo x > C:/tmp/f\n', after);
    put('ok.sh', 'echo x > /tmp/f\n', after);
    put('w.ps1', "Set-Content '/tmp/x' 1\n", after);
    put('w.cmd', `echo x > ${BS}tmp${BS}f\r\n`, after);
    put('fine.js', "console.log('hi')\n", after);
    put('old.js', "require('fs').writeFileSync('/tmp/x', 'y')\n", before);
    put('big.js', '// /tmp/x\n' + 'x'.repeat(250000), after);
    put('tests/t.js', "'/tmp/x'\n", after);
    put('tests/old.test.js', "'/tmp/x'\n", before);
    const run = (c, tool = 'Bash', temp = wtemp) => TG.refusal({ tool_name: tool, cwd: dir, tool_input: { command: c } }, temp);
    for (const c of ['node w.js', 'node --require ./x.js w.js', 'python w.py', 'python3 ./w.py', 'bash w.sh', './w.sh', 'sh w.sh', 'cd . && node w.js', `node ${dir}/w.js`, 'powershell -File w.ps1', 'pwsh -NoProfile -File ./w.ps1', 'cmd /c w.cmd', 'w.cmd', 'node tests/t.js', 'node --test w.js', 'node --test tests/t.js']) assert.ok(run(c), `should refuse: ${c}`);
    assert.ok(run(`.${BS}w.ps1`, 'PowerShell'), 'PowerShell runs a script by name too');
    for (const c of ['node fine.js', 'bash ok.sh', 'node old.js', 'node big.js', 'node tests/old.test.js', 'node --test tests/old.test.js', 'node missing.js', 'node -e "console.log(1)" w.js']) assert.strictEqual(run(c), null, `should allow: ${c}`);
    // not a worker folder (the headless orchestrator's, an operator's): there is no launch time, so no file is read, however fresh
    for (const c of ['node w.js', 'bash w.sh', 'node --test tests/t.js']) assert.strictEqual(run(c, 'Bash', TEMP), null, `no launch time, nothing read: ${c}`);
    assert.strictEqual(run('node w.js', 'Bash', dir), null, 'a folder without a belay run above it has no launch time');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('in a worker temp folder a script is read when it was edited after the first launch of the worker, however long ago, and not before', () => {
  const WT = require('../../src/run/worker-temp.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-tmpbirth-')).split(path.sep).join('/');
  try {
    const wtemp = WT.make('run-b', 'w1', { root });
    assert.ok(wtemp);
    const birth = WT.birthOf(wtemp);
    assert.ok(birth > 0, 'a folder under belay/<run>/ with the marker has a birth time');
    assert.strictEqual(WT.birthOf(root), null, 'any other folder has none');
    const put = (name, text, whenMs) => { const p = root + '/' + name; fs.writeFileSync(p, text); const t = new Date(whenMs); fs.utimesSync(p, t, t); };
    const body = "require('fs').writeFileSync('/tmp/x', 'y')\n";
    put('after.js', body, birth + 90 * 60 * 1000);       // written 90 minutes after launch: past the old one-hour gate, still the worker's
    put('before.js', body, birth - 5 * 60 * 1000);       // five minutes before launch: a repository file the worker did not touch
    const run = (c) => TG.refusal({ tool_name: 'Bash', cwd: root, tool_input: { command: c } }, wtemp);
    assert.ok(run('node after.js'));
    assert.strictEqual(run('node after.js'), TG.SCRIPT_MESSAGE, 'a script that only names the path has its own reason, not the write refusal');
    assert.ok(Buffer.byteLength(TG.denyOutput(TG.SCRIPT_MESSAGE), 'utf8') < 400 && !TG.SCRIPT_MESSAGE.includes('\n'));
    assert.match(TG.SCRIPT_MESSAGE, /names \/tmp.*use \$TEMP.*npm test/);
    put('writes.sh', 'echo x > C:/tmp/f\n', birth + 90 * 60 * 1000);
    assert.ok(run('bash writes.sh') && run('bash writes.sh') !== TG.SCRIPT_MESSAGE, 'a script whose text writes there keeps the write refusal');
    assert.match(run('echo x > C:/tmp/f'), /^Do not write to/, 'and so does a write on the command line');
    assert.strictEqual(run('node before.js'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the hook process answers a PowerShell call and a Bash redirect with a deny, and stays silent for the allowed forms', () => {
  for (const p of [ps('Set-Content /tmp/f x'), bash('echo x > C:/tmp/f')]) {
    const r = runHook(JSON.stringify({ hook_event_name: 'PreToolUse', ...p }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
  for (const p of [ps('Get-Content /tmp/f'), bash('echo x > /tmp/f')]) assert.strictEqual(runHook(JSON.stringify(p)).stdout, '');
});
