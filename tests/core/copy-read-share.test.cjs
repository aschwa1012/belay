'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// A read's copy of the store must never stop an owner from opening it for writing. On Windows
// `copyFileSync` (CopyFileW) opened its source without write sharing, so an owner elected during a copy
// opened the store read-only without being told and failed its stamp "attempt to write a readonly
// database". The copy now reads through a plain Node open, and the owner's open retries a read-only open
// for about a second before refusing it by name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SRC = path.join(__dirname, '..', '..', 'src', 'core');
const { Store } = require(path.join(SRC, 'store.cjs'));
const { copyWithRetry } = require(path.join(SRC, 'copy-read.cjs'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'belay-copy-share-'));

// A store of about 3 MB, so a copy reads it in several chunks.
function bigStore(dir) {
  const db = path.join(dir, 'memory.db');
  const s = new Store(db, { stamp: true });
  s.db.exec('CREATE TABLE big(b)');
  const st = s.db.prepare('INSERT INTO big VALUES (?)');
  for (let i = 0; i < 3; i++) st.run(Buffer.alloc(1 << 20, i + 1));
  s.db.close();
  return db;
}

function writerOpens(db) {
  try { const s = new Store(db, { stamp: true }); s.db.exec('INSERT INTO big VALUES (1)'); s.db.close(); return { ok: true }; }
  catch (e) { return { ok: false, code: e.code, errcode: e.errcode, message: e.message }; }
}

function lines(child, onLine) {
  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
  });
}

test('a writer store opens while another process is part way through copy-read\'s copy of it', async () => {
  const dir = tmp();
  const db = bigStore(dir);
  // The child copies with copy-read's own copy and, after its first chunk, with the source still open,
  // says so and blocks until this process has tried to open the store as its owner.
  const code = `
    const fs = require('node:fs');
    const { copyWithRetry } = require(${JSON.stringify(path.join(SRC, 'copy-read.cjs'))});
    let held = false;
    const ok = copyWithRetry(process.argv[1], process.argv[2], false, () => {
      if (held) return; held = true;
      process.stdout.write('mid\\n');
      fs.readSync(0, Buffer.alloc(1));
    });
    process.stdout.write((held ? 'done ' : 'nohook ') + ok + '\\n');`;
  const child = spawn(process.execPath, ['-e', code, db, path.join(dir, 'copy.db')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const seen = [];
  let opened = null;
  const exited = new Promise(r => child.on('exit', c => r(c)));
  lines(child, l => {
    seen.push(l);
    if (l === 'mid') { opened = writerOpens(db); child.stdin.end('x'); }
  });
  const exitCode = await exited;
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(exitCode, 0);
  assert.deepEqual(seen, ['mid', 'done true'], 'the copy stopped part way, with its source open, then finished');
  assert.deepEqual(opened, { ok: true }, 'the owner opened and wrote the store while the copy held it');
});

test('copyWithRetry still copies every byte of the source', () => {
  const dir = tmp();
  const db = bigStore(dir);
  const dst = path.join(dir, 'copy.db');
  let chunks = 0;
  assert.equal(copyWithRetry(db, dst, false, () => { chunks++; }), true);
  assert.ok(chunks > 1, `copied in ${chunks} chunks`);
  assert.ok(fs.readFileSync(db).equals(fs.readFileSync(dst)));
  assert.equal(copyWithRetry(path.join(dir, 'absent.db'), path.join(dir, 'absent-copy.db'), false), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The defence: a process that holds the file the way CopyFileW does (read access, read sharing only).
// Windows only: elsewhere a file open never denies another process write access.
function holdFile(file, ms) {
  const ps = `$ProgressPreference = 'SilentlyContinue'
$h = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read')
[Console]::Out.WriteLine('held'); [Console]::Out.Flush()
if (${ms} -gt 0) { Start-Sleep -Milliseconds ${ms} } else { [Console]::In.ReadLine() | Out-Null }
$h.Close()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const exited = new Promise(r => child.on('exit', c => r(c)));
  const held = new Promise((resolve, reject) => {
    lines(child, l => { if (l === 'held') resolve(); });
    child.on('exit', c => reject(new Error(`the holder exited ${c} before it held the file`)));
  });
  return { child, held, exited };
}

const win = { skip: process.platform !== 'win32' && 'a file open denies write sharing only on Windows' };

test('an owner open retries through a short read-only hold and then writes', win, async () => {
  const dir = tmp();
  const db = bigStore(dir);
  const h = holdFile(db, 200);
  await h.held;
  const t0 = Date.now();
  const opened = writerOpens(db);
  const ms = Date.now() - t0;
  await h.exited;
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(opened, { ok: true }, `opened after ${ms} ms`);
});

test('an owner open held read-only past its retries is refused naming the file, never served read-only', win, async () => {
  const dir = tmp();
  const db = bigStore(dir);
  const h = holdFile(db, 0);
  await h.held;
  let e = null;
  try { new Store(db, { stamp: true }).db.close(); } catch (x) { e = x; }
  h.child.stdin.end('\n');
  await h.exited;
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(e, 'the open was refused');
  assert.equal(e.code, 'E_BUSY');
  assert.equal(e.detail.reason, 'readonly');
  assert.equal(e.detail.db, db);
  assert.ok(e.detail.attempts > 1);
  assert.match(e.message, /another process holds the file/);
});
