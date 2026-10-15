'use strict';
// proc-identity.cjs — ADR 0039 decisions 1 to 3. Proof that a pid is the process belay means.
// `process.kill(pid, 0)` proves only that some process holds the pid; Windows reuses pids quickly.
// So a kill carries an identity: a live child handle, or an expected creation time read once at
// spawn. One CIM query (a snapshot of every process) is the only source of creation times. Only kill
// paths call it; no read verb does (invariant 9).

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';
const SNAPSHOT_TIMEOUT_MS = 5000;

const PS_SNAPSHOT = 'Get-CimInstance Win32_Process | ForEach-Object { $c=$null; if ($_.CreationDate) { $c=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; [pscustomobject]@{p=$_.ProcessId;pp=$_.ParentProcessId;c=$c;n=$_.Name} } | ConvertTo-Json -Compress';

// pid -> { ppid, created (ms since epoch or null), image }. Resolves null when it cannot be read
// (non-Windows, timeout, bad output). Never rejects.
function parseSnapshot(stdout) {
  let rows;
  try { rows = JSON.parse(String(stdout)); } catch { return null; }
  if (!Array.isArray(rows)) rows = [rows];
  const map = new Map();
  for (const r of rows) {
    if (!r || !Number.isInteger(r.p)) continue;
    map.set(r.p, { ppid: Number.isInteger(r.pp) ? r.pp : null, created: Number.isFinite(r.c) ? r.c : null, image: r.n == null ? null : String(r.n) });
  }
  return map.size ? map : null;
}
// DIAG (temporary): BELAY_DIAG_SNAPSHOT_STALL_MS stalls every real snapshot inside PowerShell, before the query,
// so the product's own timeout and retry run unchanged against a slow snapshot.
const DIAG_STALL = Number(process.env.BELAY_DIAG_SNAPSHOT_STALL_MS) || 0;
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', (DIAG_STALL ? `Start-Sleep -Milliseconds ${DIAG_STALL}; ` : '') + PS_SNAPSHOT];

// PowerShell's own TEMP. Every PowerShell start writes two __PSScriptPolicyTest_* probe files to TEMP and deletes
// them a moment later; one ended in that moment leaves them for good. A Windows child that is not detached dies
// with its parent, so a process that exits while a snapshot starts (an adapter's startup probe, then stdin end; an
// adapter Claude Code ends after its session) left them in the shared TEMP. `detached` cannot help: a detached
// PowerShell writes nothing to its pipes. So the snapshot runs with TEMP set to this directory, and each snapshot
// first removes the probe files in it that are older than SWEEP_AGE_MS: any left over, never one being probed.
const SNAP_TEMP = path.join(os.tmpdir(), 'belay-snapshot');
const SWEEP_AGE_MS = 30000;
const PROBE_FILE = /^__PSScriptPolicyTest_/;
function snapshotEnv() {
  try {
    fs.mkdirSync(SNAP_TEMP, { recursive: true });
    const cutoff = Date.now() - SWEEP_AGE_MS;
    for (const n of fs.readdirSync(SNAP_TEMP)) {
      if (!PROBE_FILE.test(n)) continue;
      const f = path.join(SNAP_TEMP, n);
      try { if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f); } catch { /* gone, or held */ }
    }
  } catch { return process.env; } // unwritable: the shared TEMP, as before
  return { ...process.env, TEMP: SNAP_TEMP, TMP: SNAP_TEMP };
}

// DIAG (temporary): BELAY_SNAPSHOT_LOG names a file; every snapshot appends one JSON line.
function snapLog(rec) {
  const f = process.env.BELAY_SNAPSHOT_LOG;
  if (!f) return;
  try { fs.appendFileSync(f, JSON.stringify({ caller: process.pid, file: process.argv[1] && path.basename(process.argv[1]), ...rec }) + String.fromCharCode(10)); } catch { /* best effort */ }
}
function processSnapshot({ timeoutMs = SNAPSHOT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!IS_WINDOWS) return resolve(null);
    const t0 = Date.now();
    try {
      const cp = execFile('powershell.exe', PS_ARGS, { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: snapshotEnv() },
        (e, stdout, stderr) => {
          const m = e ? null : parseSnapshot(stdout);
          snapLog({ kind: 'async', t0, t1: Date.now(), ms: Date.now() - t0, timeoutMs, ps: cp && cp.pid, err: e ? (e.killed ? 'killed' : (e.code || String(e.message).slice(0, 80))) : null, signal: e && e.signal, bytes: String(stdout || '').length, rows: m ? m.size : 0, stderr: String(stderr || '').slice(0, 120) });
          resolve(m);
        });
    } catch (e) { snapLog({ kind: 'async', t0, t1: Date.now(), ms: Date.now() - t0, err: 'throw ' + String(e && e.message).slice(0, 80) }); resolve(null); }
  });
}

// The same query, blocking. For test harnesses that kill synchronously (tests/acceptance/lib.cjs); product code
// uses the async one so it never stalls an event loop.
function processSnapshotSync({ timeoutMs = SNAPSHOT_TIMEOUT_MS } = {}) {
  if (!IS_WINDOWS) return null;
  const t0 = Date.now();
  try { const m = parseSnapshot(require('node:child_process').execFileSync('powershell.exe', PS_ARGS, { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: snapshotEnv() })); snapLog({ kind: 'sync', t0, t1: Date.now(), ms: Date.now() - t0, timeoutMs, err: null, rows: m ? m.size : 0 }); return m; }
  catch (e) { snapLog({ kind: 'sync', t0, t1: Date.now(), ms: Date.now() - t0, timeoutMs, err: e && (e.code || 'error'), signal: e && e.signal, rows: 0 }); return null; }
}

// One snapshot, taken again while it is unreadable: `attempts` in all, the wait between them doubling from
// `backoffMs`. A snapshot that reads but lacks a pid is not retried: that is an answer. The default snapshot is
// looked up on the exports at each call, so a test can stand in for it.
async function snapshotRetry({ attempts = 1, backoffMs = 200, snapshot = null } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (i - 1)));
    const s = await (snapshot || module.exports.processSnapshot)();
    if (s) return s;
  }
  return null;
}

// The creation time of one pid, from a snapshot (a fresh one unless `snapshot` is given), read up to
// `attempts` times while the snapshot is unreadable. { created, image } or null when the pid is not there or
// every snapshot was unreadable.
async function createdOf(pid, { snapshot = null, attempts = 1, backoffMs = 250 } = {}) {
  const snap = await snapshotRetry({ attempts, backoffMs, snapshot });
  const e = snap && snap.get(pid);
  return e && e.created != null ? { created: e.created, image: e.image } : null;
}

// A probe for this process's own creation time: the read starts now, and `await probe()` never waits on it
// (null if it is not done yet), so an attach is never delayed by a snapshot.
function ownCreatedProbe(pid) {
  const p = createdOf(pid).catch(() => null);
  return async () => { const r = await Promise.race([p, new Promise((res) => setImmediate(() => res(null)))]); return r && r.created != null ? r.created : null; };
}

// A child handle is live only while neither an exit code nor a signal has been recorded.
function handleLive(h) {
  return !!h && typeof h === 'object' && Number.isInteger(h.pid) && h.exitCode === null && h.signalCode === null;
}

// Image names are compared case-insensitively, and on Windows an extensionless name means `.exe` (a spawnfile of
// `claude` is the image CIM calls `claude.exe`).
const normImage = (n) => { const l = String(n).toLowerCase(); return IS_WINDOWS && !/\.[a-z0-9]+$/.test(l) ? `${l}.exe` : l; };
const sameImage = (a, b) => typeof a === 'string' && typeof b === 'string' && normImage(a) === normImage(b);
const imageIn = (image, want) => {
  if (want == null) return true;
  return (Array.isArray(want) ? want : [want]).some((w) => sameImage(image, w));
};

// Check one pid against its expectation in a snapshot.
// -> { ok: true, identity } or { ok: false, detail }
function checkIdentity(pid, expect, snap) {
  const e = snap && snap.get(pid);
  // `kind` tells a caller what the refusal means: 'absent' and 'mismatch' prove the process belay meant is not
  // there (or not at that pid); 'unverifiable' proves nothing, so the process may still be running.
  if (!snap) return { ok: false, kind: 'unverifiable', detail: `process snapshot unreadable; cannot establish the identity of pid ${pid}` };
  if (!e) return { ok: false, kind: 'absent', detail: `pid ${pid} is not in the process snapshot` };
  if (expect.created == null) return { ok: false, kind: 'unverifiable', detail: `no recorded creation time for pid ${pid}` };
  if (e.created == null) return { ok: false, kind: 'unverifiable', detail: `creation time of pid ${pid} cannot be read` };
  // Exact: two snapshots of one process agree to the millisecond, so any difference is another process.
  if (e.created !== expect.created) {
    return { ok: false, kind: 'mismatch', detail: `pid ${pid} was created at ${e.created}, expected ${expect.created} (a different process holds the pid)` };
  }
  // Same creation time, other image: more likely a naming difference than another process, so it proves nothing.
  if (expect.image != null && !imageIn(e.image, expect.image)) return { ok: false, kind: 'unverifiable', detail: `pid ${pid} is image ${e.image}, expected ${[].concat(expect.image).join(' or ')}` };
  return { ok: true, identity: { via: 'created', created: e.created, image: e.image } };
}

// Descendants of `rootPid` in a snapshot, leaves first, keeping a process only when it was created at
// or after its parent (a stale recorded parent pid names a process that died before it was born).
// Each entry is { pid, created, image }.
function descendantsOf(rootPid, snap) {
  const root = snap && snap.get(rootPid);
  const kids = new Map();
  if (snap) for (const [pid, e] of snap) {
    if (e.ppid == null || pid === e.ppid) continue;
    if (!kids.has(e.ppid)) kids.set(e.ppid, []);
    kids.get(e.ppid).push(pid);
  }
  const out = []; const skipped = []; const seen = new Set([rootPid]);
  const walk = (ppid, pcreated) => {
    for (const pid of kids.get(ppid) || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const e = snap.get(pid);
      if (pcreated != null && (e.created == null || e.created < pcreated)) { skipped.push({ pid, reason: 'created before its recorded parent' }); continue; }
      walk(pid, e.created);
      out.push({ pid, created: e.created, image: e.image });
    }
  };
  if (root) walk(rootPid, root.created);
  return { leavesFirst: out, skipped };
}

module.exports = {
  IS_WINDOWS, processSnapshot, processSnapshotSync, snapshotRetry, createdOf, ownCreatedProbe, handleLive, checkIdentity, descendantsOf, imageIn,
};
