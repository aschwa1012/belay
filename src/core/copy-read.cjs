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

const SUFFIXES = ['', '-wal', '-shm'];
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } };

// A live owner holds `-shm` as a memory mapping, and on Windows a mapped file cannot always be copied:
// `copyFileSync` fails EBUSY, intermittently, exactly when there is an owner worth reading around. That
// made a read of a busy store throw instead of answering, which is the one thing a read must never do.
//
// `-shm` is the WAL's shared index. SQLite states it holds no persistent content and rebuilds it from
// the `-wal` on open, so a copy without it is still current: what carries the uncommitted frames is the
// `-wal`, and that one is not mapped this way. So the two files that hold data are retried and then
// raised, and `-shm` is retried and then left behind. Returns whether the file was copied.
function copyWithRetry(src, dst, optional) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { fs.copyFileSync(src, dst); return true; }
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

async function withCopy(dataDir, fn) {
  const src = path.join(dataDir, 'memory.db');
  // BELAY_RO_TMP_ROOT is a test-only override of the temp root.
  const root = process.env.BELAY_RO_TMP_ROOT || os.tmpdir();
  sweep(root); // reclaim dead readers' leftovers (copy-sweep.cjs); never throws
  const parent = path.join(root, PARENT);
  const tmpDir = makeTmpDir(parent);
  const dst = path.join(tmpDir, 'memory.db');
  let present = false;
  try {
    for (const suf of SUFFIXES) {
      const copied = copyWithRetry(src + suf, dst + suf, suf === '-shm');
      if (copied && suf === '') present = true;
    }
    return await fn(dst, present ? 'copy' : 'none');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp dir, next boot clears it */ }
  }
}

module.exports = { withCopy, makeTmpDir, copyWithRetry, SUFFIXES };
