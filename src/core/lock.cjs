'use strict';
// lock.cjs — ownership, the pipe name and the pid check. No sqlite, no embedder: status.get reaches
// this module and nothing heavier (api.md §4).
//
// Ownership is an atomic `mkdir <data>/owner.lock` holding the owner's pid and pipe name (ADR 0002 §2).
// A lock whose pid is dead is stale and may be taken over. The prototype's takeover let two processes
// both rmSync the stale directory and both then mkdir it, so both believed they had won. Here a
// takeover first *renames* the stale directory to a name unique to this process: rename fails for
// everyone but the first, so exactly one process ever removes a given stale lock, and the losers fall
// back through the loop to a plain mkdir race that the filesystem settles.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function pipeName(dataDir) {
  const h = crypto.createHash('sha1').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\belay-${h}` : path.join(dataDir, `belay-${h}.sock`);
}

// build step 6c, design item 1, ADR 0019 decision 3: the
// worker adapter's own pipe, one per adapter pid, so a reattached adapter under a new epoch never
// answers on the name its predecessor used and a stale name cannot be dialled without first passing the
// CLI's own pid check (src/cli/adapter-pipe.cjs). Pure function of its arguments; never stored.
function adapterPipeName(dataDir, pid) {
  const base = pipeName(dataDir);
  return process.platform === 'win32' ? `${base}-${pid}` : base.replace(/\.sock$/, `-${pid}.sock`);
}

// The data dir is echoed back to callers in status.get, so it needs one canonical spelling: a caller
// that passes forward slashes must read back what it sent, not the same directory spelled differently.
// Forward slashes everywhere on Windows; on POSIX a backslash is a legal filename character, so
// path.resolve's own output is left exactly as it is.
const resolveDataDir = d => (process.platform === 'win32' ? path.resolve(d).replace(/\\/g, '/') : path.resolve(d));

function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // exists, owned by someone else, still alive
}

const lockPath = dataDir => path.join(dataDir, 'owner.lock');
const metaPath = dataDir => path.join(lockPath(dataDir), 'owner.json');

// Read-only: never creates the data dir, the lock dir or anything else.
function readOwnerLock(dataDir) {
  try { return JSON.parse(fs.readFileSync(metaPath(dataDir), 'utf8')); }
  catch { return null; }
}

const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } };

// Returns { won: true, lockDir } or { won: false, holder }.
function acquireLock(dataDir, info, opts = {}) {
  const attempts = opts.attempts || 5;
  const dir = lockPath(dataDir), meta = metaPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(meta, JSON.stringify({ pid: process.pid, ...info, acquired_at: Date.now() }));
      return { won: true, lockDir: dir };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { /* mid-write or gone */ }
      if (holder && holder.pid !== process.pid && pidAlive(holder.pid)) return { won: false, holder };
      if (!holder) {
        // The winner writes owner.json immediately after mkdir; a directory younger than a second with
        // no metadata is a race in progress, not a corpse.
        let age = Infinity;
        try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; }
        if (age < 1000) { sleepSync(200); continue; }
      }
      // Stale. Claim the right to remove it by renaming it out of the way; only one renamer succeeds.
      const stale = `${dir}.stale-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      try { fs.renameSync(dir, stale); }
      catch { sleepSync(50); continue; } // another process got there first; re-read the new state
      try { fs.rmSync(stale, { recursive: true, force: true }); } catch { /* leaves a dead dir, not a lock */ }
    }
  }
  return { won: false, holder: readOwnerLock(dataDir) };
}

// The lock's metadata is written the instant the directory is made, because a stale-lock takeover needs
// a pid to check and a directory with no metadata is only a race in progress for one second. But the
// owner is not serving yet at that moment, so what it publishes first is `listening: false`, and this
// rewrites it once the pipe is up. A reader that finds `listening === false` knows the difference
// between an owner that is starting and one that is wedged, and takes neither for a server.
// Only the process named in the lock may amend it.
function markListening(lockDir, at = Date.now()) {
  const meta = path.join(lockDir, 'owner.json');
  let cur;
  try { cur = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { return false; }
  if (cur.pid !== process.pid) return false;
  fs.writeFileSync(meta, JSON.stringify({ ...cur, listening: true, listening_at: at }));
  return true;
}

// Only the process named in the lock may release it, so a takeover cannot be undone by its victim.
function releaseLock(lockDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    if (m.pid !== process.pid) return false;
  } catch { /* no metadata: it is ours to clean or already gone */ }
  try { fs.rmSync(lockDir, { recursive: true, force: true }); return true; } catch { return false; }
}

module.exports = { pipeName, adapterPipeName, pidAlive, resolveDataDir, acquireLock, releaseLock, markListening, readOwnerLock, lockPath, metaPath };
