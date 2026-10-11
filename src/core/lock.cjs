'use strict';
// lock.cjs — ownership, the pipe name and the pid check. No sqlite, no embedder: status.get reaches
// this module and nothing heavier (api.md §4).
//
// Ownership is the directory <data>/owner.lock holding owner.json, the owner's pid and pipe name (ADR
// 0002 §2). A lock whose pid is dead is stale and may be taken over, by exactly one process.
//
// Two earlier takeovers each let two processes win. The prototype's let two racers both remove the
// stale directory and both mkdir it. Its successor renamed the stale directory aside first, but the
// rename names a path, not the lock a racer judged stale: a racer that read the dead pid, then lost the
// CPU while another racer took over, renamed the *new, live* lock aside and won as well (seen on a slow
// CI runner). So nothing here acts on a path on the strength of an earlier read:
//  - a lock is published whole: its directory is built aside with owner.json inside, then renamed into
//    place, which fails while any directory is there. A lock directory never exists without metadata.
//  - a stale lock is taken over in place. The taker first publishes a claim directory inside the lock
//    whose name carries the stale lock's own identity (its token), so only one process can claim that
//    lock, and a claim made on the strength of an old read lands on a name nobody else is using. The
//    claimant then re-reads owner.json; only if it still names the very lock it judged stale does it
//    replace it, by rename, so a reader sees the old metadata or the new and never a torn file.
//  - a claimant that died before replacing the metadata leaves a claim naming a dead pid; the next
//    claim for the same lock takes the next number.
//  - a release renames the directory aside before removing it, so the path is either the live lock or
//    free, never half-removed.

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
const rid = () => crypto.randomBytes(6).toString('hex');
const aside = (p, what) => `${p}.${what}-${process.pid}-${rid()}`;
// Windows answers a rename with these while another process has a file inside open for a moment.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

// owner.json as one of four facts: ok, absent (no file), corrupt (not JSON; never written by this
// module, which only ever renames a whole file into place), or unknown (there, but unreadable just now).
function readMeta(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { state: e.code === 'ENOENT' ? 'absent' : 'unknown' }; }
  try { const meta = JSON.parse(text); if (meta && typeof meta === 'object') return { state: 'ok', meta }; } catch { /* corrupt */ }
  return { state: 'corrupt' };
}

// Builds a directory aside and renames it to `target`, which fails while anything is at `target`
// (Windows refuses a rename onto any directory; POSIX onto a non-empty one, and these never are empty).
// Returns true only if this call put it there.
function publishDir(target, files) {
  const tmp = aside(target, 'tmp');
  try { fs.mkdirSync(tmp); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(tmp, name), body);
    for (let i = 0; i < 5; i++) {
      try { fs.renameSync(tmp, target); return true; } catch (e) {
        if (fs.existsSync(target) || !TRANSIENT.has(e.code)) return false;
        sleepSync(10);
      }
    }
    return false;
  } finally { if (fs.existsSync(tmp)) removeDir(tmp); }
}

// Renames a directory aside, then removes it, so its path goes from present to free in one step.
function removeDir(dir) {
  for (let i = 0; i < 20; i++) {
    const gone = aside(dir, 'gone');
    try { fs.renameSync(dir, gone); fs.rmSync(gone, { recursive: true, force: true }); return true; } catch (e) {
      if (e.code === 'ENOENT' && !fs.existsSync(dir)) return true;
      if (!TRANSIENT.has(e.code)) break;
      sleepSync(10);
    }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

// Replaces a file whole, by rename, retried while a reader briefly holds it open.
function replaceFile(file, body) {
  const tmp = aside(file, 'tmp');
  fs.writeFileSync(tmp, body);
  for (let i = 0; i < 100; i++) {
    try { fs.renameSync(tmp, file); return true; } catch (e) {
      if (!TRANSIENT.has(e.code)) break;
      sleepSync(10);
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* gone */ }
  return false;
}

// The identity of the lock a racer judged stale, safe as a file name. A lock with no readable metadata
// (written by something other than this module) is 'nometa'.
const lockId = seen => (seen.state !== 'ok' ? 'nometa'
  : String(seen.meta.token || `${seen.meta.pid}-${seen.meta.acquired_at}`).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64));
const sameLock = (a, b) => (a.state === 'ok' ? b.state === 'ok' && lockId(a) === lockId(b) : b.state === 'absent' || b.state === 'corrupt');

function readSettled(file) {
  let seen = readMeta(file);
  for (let i = 0; i < 20 && seen.state === 'unknown'; i++) { sleepSync(10); seen = readMeta(file); }
  return seen;
}

// Takes over the stale lock `seen` in place. 'won', or 'lost' when the lock is no longer the one judged
// stale or another live process holds the claim on it.
function takeOver(dir, meta, seen, body) {
  const id = lockId(seen);
  let claim = null;
  for (let n = 0; n < 32 && !claim; n++) {
    const c = path.join(dir, `claim-${id}-${n}`);
    if (publishDir(c, { 'claimant.json': JSON.stringify({ pid: process.pid, at: Date.now() }) })) { claim = c; break; }
    const by = readSettled(path.join(c, 'claimant.json'));
    if (by.state === 'ok' && by.meta.pid === process.pid) { claim = c; break; }
    if (by.state !== 'ok' || pidAlive(by.meta.pid)) return 'lost'; // a live claimant, or the lock went away
    // that claimant died before finishing; the next number is the next claim on the same lock
  }
  if (!claim) return 'lost';
  // Holding the only claim on this lock. Proceed only if owner.json still names it: a racer that read
  // the stale lock long ago may find a newer, live one here, and it must not touch it.
  if (!sameLock(seen, readSettled(meta))) { removeDir(claim); return 'lost'; }
  if (replaceFile(meta, body())) return 'won';
  const now = readMeta(meta);
  if (now.state === 'ok' && now.meta.pid === process.pid) return 'won';
  removeDir(claim);
  return 'lost';
}

const mtime = p => { try { return fs.statSync(p).mtimeMs; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; } };

// Returns { won: true, lockDir } or { won: false, holder }. `opts.onStale(seen)` is a test seam, called
// after a racer has judged a lock stale and before it acts, where a slow racer loses the CPU.
function acquireLock(dataDir, info, opts = {}) {
  const attempts = opts.attempts || 10;
  const dir = lockPath(dataDir), meta = metaPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const body = () => JSON.stringify({ pid: process.pid, ...info, token: rid(), acquired_at: Date.now() });
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (publishDir(dir, { 'owner.json': body() })) return { won: true, lockDir: dir };
    const seen = readMeta(meta);
    if (seen.state === 'unknown') { sleepSync(20); continue; }
    if (seen.state === 'ok' && seen.meta.pid !== process.pid && pidAlive(seen.meta.pid)) return { won: false, holder: seen.meta };
    if (seen.state !== 'ok') {
      if (!fs.existsSync(dir)) continue; // released in between; publish again
      // Not written by this module, which publishes a lock whole. Younger than a second, it may still
      // be being written by whatever did make it; older, it is a corpse.
      let age;
      try { age = Date.now() - Math.max(mtime(dir), mtime(meta)); } catch { continue; }
      if (age < 1000) { sleepSync(200); continue; }
    }
    if (opts.onStale) opts.onStale(seen);
    let outcome = 'lost';
    try { outcome = takeOver(dir, meta, seen, body); } catch { /* the lock moved under us; re-read it */ }
    if (outcome === 'won') return { won: true, lockDir: dir };
    sleepSync(50);
  }
  return { won: false, holder: readOwnerLock(dataDir) };
}

// The lock's metadata is published with the directory, because a stale-lock takeover needs a pid to
// check. But the owner is not serving yet at that moment, so what it publishes first is
// `listening: false`, and this rewrites it once the pipe is up. A reader that finds
// `listening === false` knows the difference between an owner that is starting and one that is wedged,
// and takes neither for a server. Only the process named in the lock may amend it.
function markListening(lockDir, at = Date.now()) {
  const meta = path.join(lockDir, 'owner.json');
  const cur = readSettled(meta);
  if (cur.state !== 'ok' || cur.meta.pid !== process.pid) return false;
  return replaceFile(meta, JSON.stringify({ ...cur.meta, listening: true, listening_at: at }));
}

// Only the process named in the lock may release it, so a takeover cannot be undone by its victim.
function releaseLock(lockDir) {
  const m = readSettled(path.join(lockDir, 'owner.json'));
  if (m.state === 'ok' && m.meta.pid !== process.pid) return false;
  // no metadata: it is ours to clean or already gone
  return removeDir(lockDir);
}

module.exports = { pipeName, adapterPipeName, pidAlive, resolveDataDir, acquireLock, releaseLock, markListening, readOwnerLock, lockPath, metaPath };
