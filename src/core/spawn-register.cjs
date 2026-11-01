'use strict';
// spawn-register.cjs — ADR 0045 decision 4, across stores. An owner's operator check refuses a peer that descends from a process belay
// spawned; its own store's worker rows name only that store's workers, so a worker of another run's store (or its headless
// orchestrator) was not recognised, and its children walked up to an older shell and passed. Every harness that spawns a worker or a
// headless orchestrator writes one small record here, keyed by pid, the moment the child exists, and removes it when the child
// exits. The directory is machine-wide (the temp directory), so every owner on the machine reads the same list.
//
// Trust: the records are written by the harness, the parent of the process they name (invariant 1), and only the harness's code
// adds one. A process that deletes a record is a same-user process that could do far more (ADR 0045 "What this does not stop").
// A record is not simply deleted when its process is gone: it becomes a tombstone under `exited/` that keeps the process's lifetime
// (spawn-provenance.cjs reads it), because a process it left behind has a chain that ends at itself and, without the tombstone, looks
// like an operator's detached tool to an owner started later.
// Fails closed: a directory that exists and cannot be read, or a record that cannot be parsed, is an error the operator check turns
// into a refusal; an absent directory means nothing was ever registered.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pidAlive } = require('./lock.cjs');

const dir = () => process.env.BELAY_SPAWN_REGISTRY || path.join(os.tmpdir(), 'belay-spawned');
const fileOf = (pid) => path.join(dir(), `${Number(pid)}.json`);
const exitedDir = () => path.join(dir(), 'exited');
const tombFile = (t) => path.join(exitedDir(), `${Number(t.pid)}-${Number.isFinite(t.created) ? t.created : 0}.json`);
// The file calls, in one object so a test can fail them in a chosen order (a Windows rename onto a file another process has open
// answers EPERM, EBUSY or EACCES for a moment; production never changes this).
const io = { rename: (a, b) => fs.renameSync(a, b), read: (p) => fs.readFileSync(p, 'utf8'), sleep: (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } } };
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 12; // attempts after the first; the waits double from 5 ms to a cap of 80 ms, about 0.7 s in all
const backoff = (i) => Math.min(5 * 2 ** i, 80);
let tmpSeq = 0;
// A live record is stamped at most this often. The stamp timers fire every 30 s (run/seen-stamp.cjs), so a stamp is skipped only when the
// last one is under 30 s old: the gap between two stamps is at most one timer period plus the timer's lateness, about 30 s.
const SEEN_REFRESH_MS = 30000;
const BOOT_SLACK_MS = 5000; // the boot time is derived from the uptime, so a record counts as older than the boot only by more than this
const UNKNOWN_START_SLACK_MS = 2000; // a record with no creation time and no spawn time: it was made this long after the process started, at most

// Write `text` to `target` so a reader sees the old file or the whole new one. The temp name is unique per call (process, counter,
// time), so two writers of one target never share it. Many processes write here at once and Windows refuses a rename onto a file
// another process has open, so a transient refusal is retried with a bounded backoff; a target that already holds exactly this text
// is a success whoever wrote it. Anything else still failing after the retries throws, and the temp file is removed.
function writeAtomic(target, text) {
  const tmp = `${target}.${process.pid}.${++tmpSeq}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    for (let i = 0; ; i++) {
      try { io.rename(tmp, target); return; }
      catch (e) {
        if (!e || !TRANSIENT.has(e.code)) throw e;
        let same = false;
        try { same = io.read(target) === text; } catch { /* unreadable or gone: not the same */ }
        if (same) return;
        if (i >= RETRIES) throw e;
        io.sleep(backoff(i));
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch { /* renamed into place, or never written */ } }
}

// Read and parse one register file. A file another process is renaming over answers a transient error for a moment: retry it. A
// missing file throws ENOENT as ever (the caller decides); a persistent error or an unparseable file throws, and the caller fails closed.
function readJson(file) {
  for (let i = 0; ; i++) {
    try { return JSON.parse(io.read(file)); }
    catch (e) { if (!e || !TRANSIENT.has(e.code) || i >= RETRIES) throw e; io.sleep(backoff(i)); }
  }
}

// -> the record written. `created` is the process's creation time when known (it usually is not yet at spawn; `update` fills it).
function register({ pid, kind, dataDir = null, workerId = null, created = null, spawnedAt = null, seenAt = null }) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`spawn register: not a pid: ${pid}`);
  fs.mkdirSync(dir(), { recursive: true });
  const rec = { pid, created: Number.isFinite(created) ? created : null, kind: kind || 'worker', data_dir: dataDir, worker_id: workerId, spawned_at: Number.isFinite(spawnedAt) ? spawnedAt : null, by_pid: process.pid, at: Date.now() };
  if (Number.isFinite(seenAt)) rec.seen_at = seenAt;
  writeAtomic(fileOf(pid), JSON.stringify(rec));
  return rec;
}

// register, for a caller that must not go on without the record: the error names what could not be recorded.
function registerProcess(rec, what) {
  try { return register(rec); }
  catch (e) { throw new Error(`${what} (pid ${rec.pid}) could not be recorded in the spawn register (${(e && e.message) || e}); another store on this machine could not tell its children from an operator`); }
}

function update(pid, created, expect = null) {
  if (!Number.isFinite(created)) return false;
  let rec;
  try { rec = readJson(fileOf(pid)); } catch { return false; }
  if (!matches(rec, expect)) return false;
  if (rec.created === created) return true;
  register({ pid, kind: rec.kind, dataDir: rec.data_dir, workerId: rec.worker_id, created, spawnedAt: rec.spawned_at, seenAt: rec.seen_at });
  return true;
}

// The earliest moment the record's process can have existed: its creation time, else the time before the spawn call, else the time of the record less a slack.
const startOf = (rec) => Number.isFinite(rec.created) ? rec.created : Number.isFinite(rec.spawned_at) ? rec.spawned_at : (Number(rec.at) || Date.now()) - UNKNOWN_START_SLACK_MS;

function saveTombstone(t) {
  fs.mkdirSync(exitedDir(), { recursive: true });
  writeAtomic(tombFile(t), JSON.stringify(t));
  return t;
}
function dropTombstone(t) { try { fs.unlinkSync(tombFile(t)); } catch { /* already gone */ } }

// Turn a record into its tombstone: { pid, created, from, until, kind, via }. `until` null means the process may still be alive.
const tombstoneOf = (rec, until) => ({ pid: rec.pid, created: Number.isFinite(rec.created) ? rec.created : null, from: startOf(rec), until, kind: rec.kind || 'worker', via: null });

// The machine's boot time (ms since the epoch), derived from the uptime. A process cannot outlive a boot, so a record older than it names
// a process that is gone, whatever answers to its pid now.
const bootMs = (now = Date.now()) => now - Math.round(os.uptime() * 1000);

// The last moment the harness knew the record's process was alive: a stamp the adapter holding it wrote, else the record's own time.
const lastSeen = (rec) => Number.isFinite(rec.seen_at) ? rec.seen_at : (Number(rec.at) || startOf(rec));

// Is the record's process the one running under its pid in `snap`? A recorded creation time must match the snapshot's; a record without
// one is the process only if it was created no later than the record was written (a reused pid is younger).
function sameProcess(rec, snap) {
  const e = snap.get(rec.pid);
  if (!e) return false;
  if (Number.isFinite(rec.created)) return e.created == null || e.created === rec.created;
  return e.created == null || e.created <= (Number(rec.at) || Date.now()) + UNKNOWN_START_SLACK_MS;
}

// Is the record the one the caller means? `expect` names the identity the caller judged: any of kind, workerId, dataDir (compared as
// paths), spawnedAt and created (each compared only when both sides know one; spawnedAt is the caller's own clock reading at the spawn,
// which update() preserves, so it tells two spawns of one id or one store apart before the creation time is read). A field left out is not checked; no `expect` matches any record. A pid
// number alone is not an identity: Windows reuses it, and another store's spawn may hold the number by the time the caller acts.
const samePath = (a, b) => {
  const n = (p) => path.resolve(String(p)).split(String.fromCharCode(92)).join('/');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
function matches(rec, expect) {
  if (!expect) return true;
  if (expect.kind != null && (rec.kind || 'worker') !== expect.kind) return false;
  if (expect.workerId != null && rec.worker_id !== expect.workerId) return false;
  if (expect.dataDir != null && !(rec.data_dir != null && samePath(rec.data_dir, expect.dataDir))) return false;
  if (Number.isFinite(expect.spawnedAt) && Number.isFinite(rec.spawned_at) && rec.spawned_at !== expect.spawnedAt) return false;
  if (Number.isFinite(expect.created) && Number.isFinite(rec.created) && rec.created !== expect.created) return false;
  return true;
}

// Retire a record whose process has exited. The tombstone is written first: when it cannot be, the record stays, so the next read
// retires it again (and throws, which the operator check turns into a refusal) rather than forgetting the process.
// A record that is not `expect`'s (another spawn took the number) is left alone.
function unregister(pid, expect = null) {
  let rec;
  try { rec = readJson(fileOf(pid)); } catch { return; }
  if (!matches(rec, expect)) return;
  try { saveTombstone(tombstoneOf(rec, Date.now())); } catch { return; }
  try { fs.unlinkSync(fileOf(pid)); } catch { /* someone else removed it */ }
}

// Stamp the record with the time its process was seen alive. Called only by the adapter that holds the child, from the row writes it
// already makes (a writer), never from a read: reading the register stamps nothing. At most every SEEN_REFRESH_MS.
function touch(pid, now = Date.now()) {
  let rec;
  try { rec = readJson(fileOf(pid)); } catch { return false; }
  if (now - lastSeen(rec) < SEEN_REFRESH_MS) return false;
  try { writeAtomic(fileOf(pid), JSON.stringify({ ...rec, seen_at: now })); return true; } catch { return false; }
}

// Stamp the record with the time its process was seen alive, with no 30 s guard: for a record whose harness may be hard-killed at any
// moment and whose process starts descendants of its own (a check command, check-register.cjs), where the stamp must be fresher than
// the provenance slack. A worker's stamp is touch(). -> true when written.
function stampNow(pid, now = Date.now(), expect = null) {
  let rec;
  try { rec = readJson(fileOf(pid)); } catch { return false; }
  if (!matches(rec, expect)) return false;
  try { writeAtomic(fileOf(pid), JSON.stringify({ ...rec, seen_at: now })); return true; } catch { return false; }
}

// Retire the record of a process a caller has found dead (run.end closing a row whose adapter never wrote its exit). A pid that still
// answers is left alone. The lifetime closes at the last moment the process was seen alive (the record's stamp, or `seenFloor`, a time a
// writer recorded such as the row's last event), not now. -> true when a record was retired.
// `expect` (see matches) names the record the caller judged; another spawn's record under the same pid stays.
function retire(pid, now = Date.now(), seenFloor = null, { checked = false, expect = null } = {}) {
  let rec;
  try { rec = readJson(fileOf(pid)); } catch { return false; }
  if (!matches(rec, expect)) return false;
  if (!checked && pidAlive(pid)) return false; // `checked`: the caller has shown the process under this pid is not the record's
  try { saveTombstone(tombstoneOf(rec, Math.min(Math.max(lastSeen(rec), Number.isFinite(seenFloor) ? seenFloor : 0), now))); } catch { return false; }
  try { fs.unlinkSync(fileOf(pid)); } catch { /* someone else removed it */ }
  return true;
}

// The records, split into those whose process is alive and those whose is gone — computed, never written. Throws when the directory
// or a record cannot be read. Given `snap` (a process snapshot) the check is by identity, not by pid alone: a record is alive only when
// the process under its pid is the one it names (creation time; a record with none, only if the process is no younger than the record),
// and never when it began before the current boot. Without one, a pid check as before. A dead record carries the tombstone that keeps
// its lifetime, closed at the last moment it was seen alive (a stamp the harness wrote, see touch), never at the time it is read; a
// pre-boot record has none (its lifetime ended with the boot).
function scan({ snap = null, now = Date.now(), boot = bootMs(now) } = {}) {
  let names;
  try { names = fs.readdirSync(dir()); } catch (e) { if (e && e.code === 'ENOENT') return { live: [], dead: [] }; throw e; }
  const out = { live: [], dead: [] };
  for (const n of names) {
    if (!/^[0-9]+[.]json$/.test(n)) continue; // a temp file being renamed into place, the exited directory, or something else
    const file = path.join(dir(), n);
    let rec;
    try { rec = readJson(file); } catch (e) { if (e && e.code === 'ENOENT') continue; throw new Error(`spawn register: ${n} cannot be read (${e.message})`); }
    if (!rec || !Number.isInteger(rec.pid)) throw new Error(`spawn register: ${n} names no pid`);
    const preBoot = !!snap && startOf(rec) + BOOT_SLACK_MS < boot;
    const alive = snap ? !preBoot && sameProcess(rec, snap) : pidAlive(rec.pid);
    if (alive) out.live.push(rec);
    else out.dead.push({ rec, file, tomb: preBoot ? null : tombstoneOf(rec, Math.min(lastSeen(rec), now)) });
  }
  return out;
}

// Persist what scan found dead: the tombstone first (unless `tombstones` is false), then the record goes. Writers only. Throws when a
// tombstone cannot be written, which leaves the record for the next read.
function settle(dead, { tombstones: keep = true } = {}) {
  for (const d of dead) {
    if (keep && d.tomb) saveTombstone(d.tomb);
    // The record is read again just before it goes: one re-registered under the same pid since the scan (a new worker took the number)
    // is a different record and stays.
    let now;
    try { now = readJson(d.file); } catch { continue; } // gone, or unreadable: nothing of this scan's to remove
    if (!now || now.pid !== d.rec.pid || now.created !== d.rec.created || now.at !== d.rec.at) continue;
    try { fs.unlinkSync(d.file); } catch { /* someone else removed it */ }
  }
}

// -> the raw records that are alive. `persist` false is a pure read: nothing is written.
function live({ persist = true, ...opts } = {}) {
  const r = scan(opts);
  if (persist) settle(r.dead);
  return r.live;
}

// -> [{ pid, created, kind, data_dir, worker_id }] of the records that are alive (see scan for `snap`).
function list(opts) {
  return live(opts).map((rec) => ({ pid: rec.pid, created: Number.isFinite(rec.created) ? rec.created : null, kind: rec.kind || 'worker', data_dir: rec.data_dir || null, worker_id: rec.worker_id || null }));
}

// -> the tombstones of exited processes (and of the descendants spawn-provenance.cjs has recorded). Throws when one cannot be read.
function tombstones() {
  let names;
  try { names = fs.readdirSync(exitedDir()); } catch (e) { if (e && (e.code === 'ENOENT')) return []; throw e; }
  const out = [];
  for (const n of names) {
    if (!/^[0-9]+-[0-9]+[.]json$/.test(n)) continue;
    let t;
    try { t = readJson(path.join(exitedDir(), n)); } catch (e) { if (e && e.code === 'ENOENT') continue; throw new Error(`spawn register: exited/${n} cannot be read (${e.message})`); }
    if (!t || !Number.isInteger(t.pid) || !Number.isFinite(t.from)) throw new Error(`spawn register: exited/${n} names no pid or start`);
    out.push({ pid: t.pid, created: Number.isFinite(t.created) ? t.created : null, from: t.from, until: Number.isFinite(t.until) ? t.until : null, kind: t.kind || 'worker', via: t.via == null ? null : t.via, via_from: Number.isFinite(t.via_from) ? t.via_from : null });
  }
  return out;
}

// What `belay run` tells its owner it spawned besides the workers: the headless orchestrator, once its pid is known. The interactive
// orchestrator is the human's own session (its plugin runs the CLI), so it is listed nowhere.
function runSpawned(interactive, orchestratorPid) {
  return !interactive && Number.isInteger(orchestratorPid) ? [{ pid: orchestratorPid, created: null, kind: 'orchestrator' }] : [];
}

module.exports = { matches, register, registerProcess, update, unregister, retire, touch, stampNow, scan, settle, list, live, tombFile, startOf, bootMs, BOOT_SLACK_MS, tombstones, saveTombstone, dropTombstone, dir, runSpawned, io };
