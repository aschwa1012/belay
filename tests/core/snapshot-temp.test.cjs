'use strict';
// snapshot-temp.test.cjs — the snapshot PowerShell's probe files never reach the shared TEMP. A Windows child dies
// with its parent, and a PowerShell ended in its first ~200 ms leaves its __PSScriptPolicyTest_* files behind for
// good, so the snapshot runs with TEMP set to belay's own directory and sweeps the stale ones (proc-identity.cjs).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pidAlive } = require('../../src/run/process.cjs');

const ID = path.join(__dirname, '..', '..', 'src', 'core', 'proc-identity.cjs').split(path.sep).join('/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probeFiles = (d) => { try { return fs.readdirSync(d).filter((n) => n.startsWith('__PSScriptPolicyTest_')); } catch { return []; } };

// A node process with TEMP set to `dir` runs `body` with the module loaded as ID, printing any pid it spawns.
function child(dir, body) {
  const src = `const cp=require('node:child_process');const ef=cp.execFile;cp.execFile=(...a)=>{const c=ef(...a);process.stdout.write(c.pid+'\\n');return c;};`
    + `const ID=require(${JSON.stringify(ID)});${body}`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', src], { windowsHide: true, env: { ...process.env, TEMP: dir, TMP: dir }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.once('exit', () => resolve(out.trim().split(/\s+/).map(Number).filter(Number.isInteger)));
  });
}

test('a parent that exits while its snapshot is starting leaves no PowerShell probe files in its TEMP', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-snaptemp-'));
  try {
    const delays = [100, 130, 160, 190, 220, 260, 300, 400];
    const dirs = delays.map((ms) => { const d = path.join(base, String(ms)); fs.mkdirSync(d); return d; });
    const psPids = [];
    for (let i = 0; i < delays.length; i++) psPids.push(...await child(dirs[i], `ID.processSnapshot();setTimeout(()=>process.exit(0),${delays[i]});`));
    assert.strictEqual(psPids.length, delays.length, `every parent named its snapshot pid: ${psPids}`);
    const t0 = Date.now(); // a snapshot that outlived its parent ends on its own
    while (psPids.some((p) => pidAlive(p)) && Date.now() - t0 < 20000) await sleep(100);
    assert.deepStrictEqual(dirs.map(probeFiles).flat(), [], 'a probe file reached the parent\'s TEMP');
    for (const d of dirs) assert.deepStrictEqual(fs.readdirSync(d).filter((n) => n !== 'belay-snapshot'), [], `only belay's own directory in ${d}`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a snapshot sweeps the stale probe files in its own TEMP and keeps a fresh one', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-snapsweep-'));
  try {
    const own = path.join(dir, 'belay-snapshot');
    fs.mkdirSync(own);
    const stale = path.join(own, '__PSScriptPolicyTest_stale.abc.ps1');
    const fresh = path.join(own, '__PSScriptPolicyTest_fresh.abc.ps1');
    const other = path.join(own, 'not-a-probe.txt');
    for (const f of [stale, fresh, other]) fs.writeFileSync(f, '');
    const old = (Date.now() - 120000) / 1000;
    fs.utimesSync(stale, old, old); fs.utimesSync(other, old, old);
    await child(dir, 'ID.processSnapshot().then((s)=>process.stdout.write(String(s?s.size:0)+"\\n"));');
    assert.ok(!fs.existsSync(stale), 'a probe file older than the sweep age is removed');
    assert.ok(fs.existsSync(fresh), 'a probe file a starting PowerShell may still hold is kept');
    assert.ok(fs.existsSync(other), 'only probe files are swept');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
