'use strict';
// copy-read.cjs — the read fallback when no owner answers (api.md §1, ADR 0005 §3).
//
// A plain read-only open of the live WAL file creates `-wal` and `-shm` sidecars beside it: a
// filesystem side effect of a command whose whole contract is that it does not write (a hazard
// that must not return in a new code path). `immutable=1` avoids the sidecars and is silently wrong, reporting
// "no such table" for a table that exists while a writer holds uncheckpointed frames. Copying the
// database *with its sidecars* and reading the copy was the only strategy that measured correct.
//
// The copy lives in the OS temp dir and is deleted afterwards, so nothing lands in the data dir. The
// copy is opened read-write on purpose: recovering the copied WAL is what makes the read current, and
// a store missing tables self-heals in the throwaway rather than throwing at prepare time.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sweep, PARENT } = require('./copy-sweep.cjs');
const { err } = require('./errors.cjs');

const SUFFIXES = ['', '-wal', '-shm'];
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } };

// The copy reads the source through a plain Node open, never `copyFileSync`. On Windows CopyFileW opens
// its source without write sharing, so an owner elected while a reader copies the store could not open it
// for writing: SQLite fell back to read-only without saying so, and the owner's first write failed
// "attempt to write a readonly database". Node opens every file with read, write and delete sharing, so
// a reader copying this way never denies a writer. `onChunk` is a test seam, called after each chunk
// while the source is still open.
const CHUNK = 1 << 20;
// Test seam: tests that count store copies set `hooks.copy(src, dst)`, called once per file whose copy has
// opened its source. Product code never sets it.
const hooks = { copy: null, budgetMs: null };
function copyShared(src, dst, onChunk) {
  const fin = fs.openSync(src, 'r');
  if (hooks.copy) hooks.copy(src, dst);
  try {
    const fout = fs.openSync(dst, 'w');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (let pos = 0; ;) {
        const n = fs.readSync(fin, buf, 0, CHUNK, pos);
        if (n === 0) break;
        for (let off = 0; off < n;) off += fs.writeSync(fout, buf, off, n - off);
        pos += n;
        if (onChunk) onChunk(pos);
      }
    } finally { fs.closeSync(fout); }
  } finally { fs.closeSync(fin); }
}

// A live owner holds `-shm` as a memory mapping, and on Windows a mapped file cannot always be copied:
// the copy fails EBUSY, intermittently, exactly when there is an owner worth reading around. That
// made a read of a busy store throw instead of answering, which is the one thing a read must never do.
//
// `-shm` is the WAL's shared index. SQLite states it holds no persistent content and rebuilds it from
// the `-wal` on open, so a copy without it is still current: what carries the uncommitted frames is the
// `-wal`, and that one is not mapped this way. So the two files that hold data are retried and then
// raised, and `-shm` is retried and then left behind. Returns whether the file was copied.
function copyWithRetry(src, dst, optional, onChunk) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { copyShared(src, dst, onChunk); return true; }
    catch (e) {
      if (e.code === 'ENOENT') return false;
      if (!BUSY.has(e.code)) throw e;
      if (attempt < 3) { sleepSync(20 * (attempt + 1)); continue; }
      if (optional) return false; // rebuilt from the -wal by whoever opens the copy
      throw e;
    }
  }
  return false;
}

// Another reader removes an empty parent between our mkdir and mkdtemp. On Windows a directory just
// removed is "delete pending", so mkdir/mkdtemp fail EPERM (or EACCES) rather than ENOENT; all three
// are retried with a short backoff (nominally 5, 10, 20 ... ms, jittered, 300 ms at most in all), then the real error is thrown.
const RETRY_CODES = new Set(['ENOENT', 'EPERM', 'EACCES']);
function makeTmpDir(parent, fsx = fs, sleep = sleepSync) {
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      fsx.mkdirSync(parent, { recursive: true });
      return fsx.mkdtempSync(path.join(parent, process.pid + '-'));
    } catch (e) {
      if (!RETRY_CODES.has(e.code) || attempt >= 8 || waited >= 300) throw e;
      const cap = Math.min(5 * 2 ** (attempt - 1), 300 - waited);
      // Jitter (half to full of the nominal delay) so racing readers do not retry in lockstep.
      const ms = Math.max(1, Math.floor(cap * (0.5 + Math.random() / 2)));
      sleep(ms); waited += ms;
    }
  }
}

// A copy is only a snapshot if nothing wrote to the store while it was taken. A writer that checkpoints
// (a TRUNCATE once the owner is idle, a last close that deletes the -wal) moves pages from the -wal into the
// database file between two chunks, and the copy then holds old pages of one and new pages of the other: it
// opens, queries run, and the answer matches neither state. So the size, mtime and identity of the three
// files are read before and after the copy, and a copy over a change is discarded and taken again. Any
// change retries, an appended -wal included: the exemption is not proven.
// Retries are bounded by time, not by a count: a live owner heartbeats every second and checkpoints on a timer,
// each of which changes the stamp, so a few tries a few ms apart can all land inside one slow stretch on a loaded
// host and fail together. The read keeps taking the copy again until RETRY_BUDGET_MS (1.5 heartbeats) have passed
// since its first attempt, with at least COPY_TRIES attempts. A quiet store is copied once and never waits; only
// a copy that changed retries. The worst case added to a read is the budget, plus up to about 160 ms of quietStamp's
// own window waits, plus one copy (whose busy-file retries add up to 120 ms per file), plus one backoff of at most
// 50 ms. The wait between attempts yields to the event loop (a caller's own pipe still answers a bounded request);
// each copy attempt, and quietStamp's short window waits, stay synchronous.
// `hooks.budgetMs` is a test seam.
const COPY_TRIES = 3;
const RETRY_BUDGET_MS = 1500;
const BACKOFF_CAP_MS = 50;
// A file's mtime has a granularity (about 1.5 ms on NTFS, up to 15.6 ms on power saver), so two writes inside one
// tick leave the same size and mtime. Two things cover that. The -wal header carries the checkpoint sequence and
// both salts (bytes 12 to 24), which every WAL restart changes, so a restart-and-rewrite that kept every size is
// seen. With no -wal at all the database file is written in place and there is no such header: the copy waits
// until the files' newest mtime is a full window behind the clock, so any write during the copy lands on a
// later tick and changes the stamp.
const TICK_WINDOW_MS = 20;
const stamp = p => { try { const st = fs.statSync(p, { bigint: true }); return `${st.size}:${st.mtimeNs}:${st.dev}:${st.ino}`; } catch { return 'absent'; } };
function walHeader(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(12);
    return b.toString('hex', 0, fs.readSync(fd, b, 0, 12, 12));
  } catch { return 'absent'; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* read-only handle */ } }
}
const stampAll = src => SUFFIXES.map(suf => stamp(src + suf)).join('|') + '|' + walHeader(src + '-wal');
// The stamp the copy is judged against. With no -wal its own mtimes must already be a full window behind the
// clock: a window checked before the stamp is not enough, since a write can land between the two and put the
// stamp's mtime in the current tick, hiding a second write of the same size during the copy. So the stamp is
// taken, and if it is too fresh the copy waits out the rest of the window and stamps again.
function quietStamp(src) {
  for (let i = 0; i < 4; i++) {
    const key = stampAll(src);
    if (key.endsWith('|absent') === false) return key; // a -wal exists: its header covers a same-tick restart
    let newest = 0;
    for (const suf of SUFFIXES) { try { newest = Math.max(newest, fs.statSync(src + suf).mtimeMs); } catch { /* absent */ } }
    const wait = Math.ceil(newest + TICK_WINDOW_MS - Date.now());
    if (wait <= 0) return key;
    sleepSync(Math.min(wait, 2 * TICK_WINDOW_MS));
  }
  return null; // never went quiet: a writer is active
}

async function withCopy(dataDir, fn) {
  const src = path.join(dataDir, 'memory.db');
  // BELAY_RO_TMP_ROOT is a test-only override of the temp root.
  const root = process.env.BELAY_RO_TMP_ROOT || os.tmpdir();
  sweep(root); // reclaim dead readers' leftovers (copy-sweep.cjs); never throws
  const parent = path.join(root, PARENT);
  const tmpDir = makeTmpDir(parent);
  const dst = path.join(tmpDir, 'memory.db');
  try {
    let present = false, settled = false, attempt = 0, copies = 0;
    const budget = hooks.budgetMs === null ? RETRY_BUDGET_MS : hooks.budgetMs, began = Date.now();
    while (!settled && (attempt < COPY_TRIES || Date.now() - began < budget)) {
      attempt++;
      const before = quietStamp(src);
      if (before === null) { await sleep(Math.min(5 * attempt, BACKOFF_CAP_MS)); continue; }
      copies++;
      present = false;
      for (const suf of SUFFIXES) {
        const copied = copyWithRetry(src + suf, dst + suf, suf === '-shm');
        if (copied && suf === '') present = true;
      }
      settled = stampAll(src) === before;
      if (!settled) {
        for (const suf of SUFFIXES) { try { fs.rmSync(dst + suf, { force: true }); } catch { /* removed with the dir */ } }
        await sleep(Math.min(5 * attempt, BACKOFF_CAP_MS));
      }
    }
    if (!settled) throw err('E_BUSY', `the store ${src} changed during each of ${copies} copies over ${Date.now() - began} ms: a writer is checkpointing or committing; nothing was read, try again`, { db: src, reason: 'copy-changed', attempts: copies });
    return await fn(dst, present ? 'copy' : 'none');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir, next boot clears it */ }
  }
}

module.exports = { withCopy, makeTmpDir, copyWithRetry, copyShared, hooks, SUFFIXES };
