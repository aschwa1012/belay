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
const { createGate } = require('./snapshot-gate.cjs');
// ADR 0048 decision 1: one attempt. BELAY_SNAPSHOT_TIMEOUT_MS overrides the default: a positive integer, floor 1000 ms;
// anything else is ignored, the default is used, and the ignored text is kept in SNAPSHOT_TIMEOUT_IGNORED for the log.
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15000;
const MIN_SNAPSHOT_TIMEOUT_MS = 1000;
function readSnapshotTimeout(raw) {
  if (raw == null || raw === '') return { ms: DEFAULT_SNAPSHOT_TIMEOUT_MS, ignored: null };
  const t = String(raw).trim();
  const n = /^[0-9]+$/.test(t) ? Number(t) : NaN;
  if (Number.isSafeInteger(n) && n >= MIN_SNAPSHOT_TIMEOUT_MS) return { ms: n, ignored: null };
  return { ms: DEFAULT_SNAPSHOT_TIMEOUT_MS, ignored: String(raw).slice(0, 40) };
}
const SNAPSHOT_TIMEOUT = readSnapshotTimeout(process.env.BELAY_SNAPSHOT_TIMEOUT_MS);
const SNAPSHOT_TIMEOUT_MS = SNAPSHOT_TIMEOUT.ms;
const SNAPSHOT_TIMEOUT_IGNORED = SNAPSHOT_TIMEOUT.ignored;

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
// ADR 0048 decision 6: BELAY_TEST_SNAPSHOT_STALL_MS (an integer, 1 to 30000, anything else ignored) prepends a sleep to
// every real snapshot inside PowerShell, so the product's own timeout runs unchanged against a slow snapshot. It can
// only make a snapshot slower: it changes nothing a snapshot contains or any identity decision. It stays in product
// code because only an environment variable reaches the processes a test spawns (the built CLI, the adapter).
const envStall = () => stallMs(process.env.BELAY_TEST_SNAPSHOT_STALL_MS);
function stallMs(raw) {
  if (raw == null || !/^[0-9]{1,5}$/.test(String(raw).trim())) return 0;
  const n = Number(raw);
  return n >= 1 && n <= 30000 ? n : 0;
}
function psArgs(stall = envStall()) { return ['-NoProfile', '-NonInteractive', '-Command', (stall ? `Start-Sleep -Milliseconds ${stall}; ` : '') + PS_SNAPSHOT]; }

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

// BELAY_SNAPSHOT_LOG names a file; every snapshot a process takes appends one JSON line (ADR 0048 decision 6). Off unless
// set; written only on paths that already take a snapshot, so a read command writes nothing (invariant 6).
function snapLog(rec) {
  const f = process.env.BELAY_SNAPSHOT_LOG;
  if (!f) return;
  const stall = envStall();
  try { fs.appendFileSync(f, JSON.stringify({ caller: process.pid, file: process.argv[1] && path.basename(process.argv[1]), ...(stall ? { stall_ms: stall } : {}), ...(SNAPSHOT_TIMEOUT_IGNORED != null ? { timeout_env_ignored: SNAPSHOT_TIMEOUT_IGNORED } : {}), ...rec }) + String.fromCharCode(10)); } catch { /* best effort */ }
}
// One real snapshot: one PowerShell, one attempt. Callers reach it only through the gate (below).
function rawSnapshot({ timeoutMs = SNAPSHOT_TIMEOUT_MS, batch = null } = {}) {
  return new Promise((resolve) => {
    if (!IS_WINDOWS) return resolve(null);
    const t0 = Date.now();
    const extra = () => (batch ? { start_seq: batch.startSeq, served: batch.callers, callers_kind: [...batch.kinds] } : {});
    try {
      const cp = execFile('powershell.exe', psArgs(), { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: snapshotEnv() },
        (e, stdout, stderr) => {
          const m = e ? null : parseSnapshot(stdout);
          snapLog({ kind: 'async', t0, t1: Date.now(), ms: Date.now() - t0, timeoutMs, ps: cp && cp.pid, err: e ? (e.killed ? 'killed' : (e.code || String(e.message).slice(0, 80))) : null, signal: e && e.signal, bytes: String(stdout || '').length, rows: m ? m.size : 0, stderr: String(stderr || '').slice(0, 120), ...extra() });
          resolve(m);
        });
    } catch (e) { snapLog({ kind: 'async', t0, t1: Date.now(), ms: Date.now() - t0, err: 'throw ' + String(e && e.message).slice(0, 80), ...extra() }); resolve(null); }
  });
}
// The process's one gate (ADR 0048 decision 2). `snapshotShared` -> { snap, error, startSeq, reqSeq, ms, ... }.
const gate = createGate({ take: (o) => rawSnapshot(o), timeoutMs: SNAPSHOT_TIMEOUT_MS });
const snapshotShared = (o) => gate.request(o);
// pid -> { ppid, created, image } from the next snapshot to start, or null when unreadable. Never rejects.
async function processSnapshot({ kind = 'kill' } = {}) { return (await gate.request({ kind })).snap; }

// The same query, blocking. For test harnesses that kill synchronously (tests/acceptance/lib.cjs); product code
// uses the async one so it never stalls an event loop.
function processSnapshotSync({ timeoutMs = SNAPSHOT_TIMEOUT_MS } = {}) {
  if (!IS_WINDOWS) return null;
  const t0 = Date.now();
  try { const m = parseSnapshot(require('node:child_process').execFileSync('powershell.exe', psArgs(), { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: snapshotEnv() })); snapLog({ kind: 'sync', t0, t1: Date.now(), ms: Date.now() - t0, timeoutMs, err: null, rows: m ? m.size : 0 }); return m; }
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

// The creation time of one pid, from the next snapshot (or `snapshot()`, a test seam returning a Map). One attempt.
// { created, image } or null when the pid is not there or the snapshot was unreadable.
async function createdOf(pid, { snapshot = null, kind = 'own-probe', gate: g = gate } = {}) {
  const snap = snapshot ? await snapshot() : (await g.request({ kind })).snap;
  const e = snap && snap.get(pid);
  return e && e.created != null ? { created: e.created, image: e.image } : null;
}

// A probe for this process's own creation time: the read starts now, and `await probe()` never waits on it
// (null if it is not done yet), so an attach is never delayed by a snapshot. A read that failed is requested again
// the next time the probe is asked while it is null, never awaited, with at most one read in flight (ADR 0048
// decision 3). `snapshot` is a test seam.
function ownCreatedProbe(pid, { snapshot = null } = {}) {
  let created = null; let reading = null;
  const read = () => {
    if (reading) return;
    reading = createdOf(pid, { snapshot }).then((r) => { if (r && r.created != null) created = r.created; }, () => {}).then(() => { reading = null; });
  };
  read();
  const probe = async () => {
    if (created == null && reading) await Promise.race([reading, new Promise((res) => setImmediate(res))]);
    if (created == null) read();
    return created;
  };
  probe.whenSettled = () => reading || Promise.resolve(); // the read in flight, for a test to wait on the real event
  return probe;
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
  IS_WINDOWS, SNAPSHOT_TIMEOUT_MS, SNAPSHOT_TIMEOUT_IGNORED, readSnapshotTimeout, gate, snapshotShared, stallMs, psArgs, processSnapshot, processSnapshotSync, snapshotRetry, createdOf, ownCreatedProbe, handleLive, checkIdentity, descendantsOf, imageIn,
};
