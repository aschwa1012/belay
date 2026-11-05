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
// Fails closed: a directory that exists and cannot be read is an error the operator check turns into a refusal; an absent directory
// means nothing was ever registered. One file that cannot be read or parsed (an unclean shutdown can leave a renamed file whose data
// never reached the disk: all NUL bytes) is "unproven", never a throw: while the pid its file name gives is alive it counts as a
// spawned process with an unknown window, and the refusal names the file; once that pid is gone, a file from this boot still gives a
// bounded lifetime to the writer's refresh that finds it (unprovenLife), which then moves it to `corrupt/` (never deleted). `belay
// doctor` lists what is there.

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
// `write` writes the whole text (writeFileSync on an fd loops over short writes) and flushes the temp file to the disk before the
// rename, so a power loss after the rename cannot leave the new name over unwritten data.
const io = { write: (p, text) => { const fd = fs.openSync(p, 'w'); try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }, rename: (a, b) => fs.renameSync(a, b), read: (p) => fs.readFileSync(p, 'utf8'), stat: (p) => fs.statSync(p, { bigint: true }), statAsync: (p) => fs.promises.stat(p, { bigint: true }), readAsync: (p) => fs.promises.readFile(p, 'utf8'), readdirAsync: (p) => fs.promises.readdir(p), sleep: (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } } };
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 12; // attempts after the first; the waits double from 5 ms to a cap of 80 ms, about 0.7 s in all
const backoff = (i) => Math.min(5 * 2 ** i, 80);
let tmpSeq = 0;
// A live record is stamped at most this often. The stamp timers fire every 30 s (run/seen-stamp.cjs), and touch skips a stamp when the
// last one is under 30 s old, so a tick that fires a moment early is skipped and the gap between two stamps can reach two periods (60 s).
const SEEN_REFRESH_MS = 30000;
const BOOT_SLACK_MS = 5000; // the boot time is derived from the uptime, so a record counts as older than the boot only by more than this
const UNKNOWN_START_SLACK_MS = 2000; // a record with no creation time and no spawn time: it was made this long after the process started, at most

// Write `text` to `target` so a reader sees the old file or the whole new one, flushed to the disk before it takes the name. The
// temp name is unique per call (process, counter, time), so two writers of one target never share it. Many processes write here at once and Windows refuses a rename onto a file
// another process has open, so a transient refusal is retried with a bounded backoff; a target that already holds exactly this text
// is a success whoever wrote it. Anything else still failing after the retries throws, and the temp file is removed.
function writeAtomic(target, text) {
  const tmp = `${target}.${process.pid}.${++tmpSeq}.${Date.now().toString(36)}.tmp`;
  try {
    io.write(tmp, text);
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
// missing file throws ENOENT as ever (the caller decides); a persistent error or an unparseable file throws, and the caller decides
// (a scan makes it unproven, below).
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

// Fill in a record's creation time. The record is written again through `register`, so its `at` becomes the time of this write (the
// lifetime the record closes at is read from `seen_at`/`at`, so a later `at` only lengthens it: fail closed); `spawned_at` is kept.
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
// An unproven tombstone (see tombstoneScan) is moved aside, never deleted.
// A lifetime read from an unproven file (unprovenLife) has no tombstone file of its own: dropping it moves that file aside.
// dropTombstone for the owner's prune, off its loop; a file another owner removed first is not an error.
async function dropTombstoneAsync(t) { try { await fs.promises.unlink(tombFile(t)); } catch { /* already gone */ } }
function dropTombstone(t) { if (t.unproven) { moveAside(t.unproven); return; } try { fs.unlinkSync(tombFile(t)); } catch { /* already gone */ } }

// ---- unproven files: a record or tombstone that cannot be read or parsed, or names no pid --------------------------------------
const corruptDir = () => path.join(dir(), 'corrupt');

// Why the file cannot be trusted, in the words the operator sees.
function unreadableWhy(file, err) {
  if (err && err.code) return `unreadable (${err.code})`; // the read itself failed, after its retries
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return `unreadable (${(e && e.code) || (err && err.code) || 'error'})`; }
  if (!buf.length) return 'zero bytes';
  if (buf.every((b) => b === 0)) return `all ${buf.length} bytes NUL`;
  return err ? `does not parse (${err.message})` : 'names no pid';
}

// -> { pid, created, name, file, why, at }. The pid is the one the file name gives; `created` is the creation time a tombstone's name
// carries (null for a record). `at` is the file's last write time: the harness writes a record or tombstone only once its process
// exists, so the process began no later than that.
function unprovenOf(file, name, err, created = null) {
  let at = null;
  try { at = fs.statSync(file).mtimeMs; } catch { /* unknown */ }
  return { pid: Number(/^(?:exited\/)?([0-9]+)/.exec(name)[1]), created, name, file, why: unreadableWhy(file, err), at };
}

// Is the unproven file's process alive, by the rules a record is judged by as far as the file still tells: a pid in the snapshot, the
// creation time when the name gives one, and else not younger than the file (a younger process is a reuse of the number); a file
// written before the boot names a process the boot ended. Without a snapshot, the boot rule and a pid check. An unknown fact counts
// toward alive.
function unprovenAlive(u, snap, boot) {
  if (Number.isFinite(u.at) && u.at + BOOT_SLACK_MS < boot) return false;
  if (!snap) return pidAlive(u.pid);
  const e = snap.get(u.pid);
  if (!e) return false;
  if (u.created != null && e.created != null) return e.created === u.created;
  return e.created == null || !Number.isFinite(u.at) || e.created <= u.at + UNKNOWN_START_SLACK_MS;
}
const unprovenKind = (u) => `process named by the unreadable spawn-register file ${u.file} (${u.why})`;
// The start of a live unproven file's process: the snapshot's creation time, else 0 (every root since counts as covered).
const unprovenFrom = (u, snap) => { const e = snap && snap.get(u.pid); return e && Number.isFinite(e.created) ? e.created : 0; };

// The lifetime a dead unproven file still gives, for the refresh that finds it (spawn-provenance.cjs): its process ran some time
// between the boot and the file's last write, and a process it left behind is matched by its parent pid only (`ppid_only`), from the
// creation time the name gives (else the boot) to the file's write time plus two stamp periods (untilOf's bound), capped at now. A
// file from before the boot gives none: the boot ended its tree. -> a lifetime, or null.
function unprovenLife(u, now = Date.now(), boot = bootMs(now)) {
  if (Number.isFinite(u.at) && u.at + BOOT_SLACK_MS < boot) return null;
  const until = Number.isFinite(u.at) ? Math.min(u.at + 2 * SEEN_REFRESH_MS, now) : now;
  return { pid: u.pid, created: u.created, from: u.created != null ? u.created : boot, until, kind: unprovenKind(u), via: null, via_from: null, ppid_only: true, unproven: u };
}

// A rename retried through the transient refusals writeAtomic retries (a scanner opens a freshly renamed file). Throws when it still fails.
function renameRetry(a, b) {
  for (let i = 0; ; i++) {
    try { io.rename(a, b); return; } catch (e) { if (!e || !TRANSIENT.has(e.code) || i >= RETRIES) throw e; io.sleep(backoff(i)); }
  }
}

// Move an unproven file to corrupt/ under a name of its own, if it is still the file that was judged: one a writer has since replaced
// with a good record stays, and one found good after the move goes back. Never deletes. -> the new path, or null when it was left
// (the move failed: the next writer tries again). Throws when a good record was moved and cannot be put back, so the check that
// moved it refuses rather than leave a live process's record in corrupt/.
function moveAside(u) {
  const good = (f) => { try { const r = readJson(f); return !!r && Number.isInteger(r.pid); } catch { return false; } };
  if (!fs.existsSync(u.file) || good(u.file)) return null;
  const to = path.join(corruptDir(), `${u.name.replace('/', '-')}.${Date.now()}`);
  try { fs.mkdirSync(corruptDir(), { recursive: true }); renameRetry(u.file, to); } catch { return null; }
  if (!good(to)) return to;
  if (fs.existsSync(u.file)) return null; // a newer record took the name again; this copy stays in corrupt/, where doctor shows it
  try { renameRetry(to, u.file); } catch (e) { throw new Error(`spawn register: the record ${u.file} was made good while it was being moved aside and could not be put back from ${to} (${(e && e.code) || e})`); }
  return null;
}

// Turn a record into its tombstone: { pid, created, from, until, kind, via }. `until` null means the process may still be alive.
const tombstoneOf = (rec, until) => ({ pid: rec.pid, created: Number.isFinite(rec.created) ? rec.created : null, from: startOf(rec), until, kind: rec.kind || 'worker', via: null });

// The machine's boot time (ms since the epoch), derived from the uptime. A process cannot outlive a boot, so a record older than it names
// a process that is gone, whatever answers to its pid now.
const bootMs = (now = Date.now()) => now - Math.round(os.uptime() * 1000);

// The last moment the harness knew the record's process was alive: a stamp the adapter holding it wrote, else the record's own time.
const lastSeen = (rec) => Number.isFinite(rec.seen_at) ? rec.seen_at : (Number(rec.at) || startOf(rec));

// Where a dead record's lifetime ends. The process may have lived up to two stamp periods past its last stamp (a skipped tick, or a
// harness hard-killed between ticks while its process ran on), so the lifetime runs to lastSeen + 2 * SEEN_REFRESH_MS; a record never
// stamped counts from its write time the same way. `seenFloor` (a time a writer recorded, such as the row's last event) can only push
// the end later. Capped at `now`, the moment it was found dead, and never left open up to it: a window open to the time it is read would
// take in the boot-time processes of a machine whose uptime did not reset (Fast Startup) or of a hard-killed run. Known limit: when the
// holder that stamps is hard-killed while its process keeps running, the window closes 60 s after the last stamp.
const untilOf = (rec, now, seenFloor = null) => Math.min(Math.max(lastSeen(rec) + 2 * SEEN_REFRESH_MS, Number.isFinite(seenFloor) ? seenFloor : 0), now);

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
// answers is left alone. The lifetime closes at untilOf: two stamp periods after the last stamp (the record's write time when never
// stamped), or `seenFloor` (a time a writer recorded, such as the row's last event) if later, capped at now. -> true when a record was retired.
// `expect` (see matches) names the record the caller judged; another spawn's record under the same pid stays.
function retire(pid, now = Date.now(), seenFloor = null, { checked = false, expect = null } = {}) {
  let rec;
  try { rec = readJson(fileOf(pid)); } catch { return false; }
  if (!matches(rec, expect)) return false;
  if (!checked && pidAlive(pid)) return false; // `checked`: the caller has shown the process under this pid is not the record's
  try { saveTombstone(tombstoneOf(rec, untilOf(rec, now, seenFloor))); } catch { return false; }
  try { fs.unlinkSync(fileOf(pid)); } catch { /* someone else removed it */ }
  return true;
}

// The records, split into those whose process is alive and those whose is gone — computed, never written. Throws when the directory
// cannot be read; a record that cannot is unproven (unprovenAlive): alive, it is listed with an unknown creation time, a window from its
// process's start, and a kind that names the file; gone, it is dead with `unproven` set and no tombstone. Given `snap` (a process
// snapshot) the check is by identity, not by pid alone: a record is alive only when the process under its pid is the one it names (creation time; a record with none, only if the process is no younger than the record),
// and never when it began before the current boot. Without one, a pid check as before. A dead record carries the tombstone that keeps
// its lifetime, closed at untilOf (two stamp periods after the last stamp the harness wrote, see touch), never left open to the time it
// is read; a pre-boot record has none (its lifetime ended with the boot).
function scan({ snap = null, now = Date.now(), boot = bootMs(now) } = {}) {
  let names;
  try { names = fs.readdirSync(dir()); } catch (e) { if (e && e.code === 'ENOENT') return { live: [], dead: [] }; throw e; }
  const out = { live: [], dead: [] };
  for (const n of names) {
    if (!/^[0-9]+[.]json$/.test(n)) continue; // a temp file being renamed into place, the exited directory, or something else
    const file = path.join(dir(), n);
    let rec; let err = null;
    try { rec = readJson(file); } catch (e) { if (e && e.code === 'ENOENT') continue; err = e; }
    if (err || !rec || !Number.isInteger(rec.pid)) {
      const u = unprovenOf(file, n, err);
      if (!unprovenAlive(u, snap, boot)) { out.dead.push({ rec: null, file, tomb: null, unproven: u }); continue; }
      out.live.push({ pid: u.pid, created: null, kind: unprovenKind(u), data_dir: null, worker_id: null, spawned_at: unprovenFrom(u, snap), at: u.at, unproven: u });
      continue;
    }
    const preBoot = !!snap && startOf(rec) + BOOT_SLACK_MS < boot;
    const alive = snap ? !preBoot && sameProcess(rec, snap) : pidAlive(rec.pid);
    if (alive) out.live.push(rec);
    else out.dead.push({ rec, file, tomb: preBoot ? null : tombstoneOf(rec, untilOf(rec, now)) });
  }
  return out;
}

// Persist what scan found dead: the tombstone first (unless `tombstones` is false), then the record goes. Writers only. Throws when a
// tombstone cannot be written, which leaves the record for the next read.
function settle(dead, { tombstones: keep = true } = {}) {
  for (const d of dead) {
    // An unproven file leaves no tombstone. One from before the boot is moved now; one from this boot still gives a lifetime
    // (unprovenLife), so it stays for spawn-provenance's refresh, which reads it, records what it reached, and then moves it.
    if (d.unproven) { if (!unprovenLife(d.unproven)) moveAside(d.unproven); continue; }
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

// -> { list, dead }: the tombstones of exited processes (and of the descendants spawn-provenance.cjs has recorded), and the unproven
// ones whose process is gone (a writer's refresh reads their lifetime, unprovenLife, and moves them aside). Throws when the directory cannot be read. An unproven tombstone whose process
// is alive (unprovenAlive, with the creation time its name gives) is listed as a live descendant that names the file, so the chains it
// could cover are refused; it is never dropped, only moved aside (dropTombstone).
function tombstoneScan({ snap = null, now = Date.now(), boot = bootMs(now) } = {}) {
  let names;
  try { names = fs.readdirSync(exitedDir()); } catch (e) { if (e && (e.code === 'ENOENT')) return { list: [], dead: [] }; throw e; }
  const out = { list: [], dead: [] };
  forgetUnlisted(exitedDir(), names);
  for (const n of names) {
    if (!/^[0-9]+-[0-9]+[.]json$/.test(n)) continue;
    const file = path.join(exitedDir(), n);
    let t; let err = null;
    try { t = readTombstone(file); } catch (e) { if (e && e.code === 'ENOENT') continue; err = e; }
    if (err || !t || !Number.isInteger(t.pid) || !Number.isFinite(t.from)) {
      const u = unprovenOf(file, `exited/${n}`, err, Number(/-([0-9]+)[.]json$/.exec(n)[1]) || null);
      if (!unprovenAlive(u, snap, boot)) { out.dead.push(u); continue; }
      // via_from is now: the boot was judged above by the file's write time, so spawn-provenance's boot rule must not drop it again
      out.list.push({ pid: u.pid, created: u.created, from: unprovenFrom(u, snap), until: null, kind: 'descendant', via: unprovenKind(u), via_from: now, unproven: u });
      continue;
    }
    out.list.push({ pid: t.pid, created: Number.isFinite(t.created) ? t.created : null, from: t.from, until: Number.isFinite(t.until) ? t.until : null, kind: t.kind || 'worker', via: t.via == null ? null : t.via, via_from: Number.isFinite(t.via_from) ? t.via_from : null });
  }
  return out;
}
const tombstones = (opts) => tombstoneScan(opts).list;

// A closed tombstone (a valid one whose `until` is set) is read once per process and kept, keyed by its file's identity: modification
// time in nanoseconds, size and file id, from a bigint stat (a Windows file id does not fit a double). A file replaced since (a rename
// onto the name) has another identity and is read again; a stat costs a small part of a read, so a check costs a stat per tombstone and
// a read per new or changed one, not a read of the whole history. An open tombstone (`until` null) and a file that does not parse are
// read every time. The kept value is copied out, never shared.
const closedSeen = new Map(); // file -> { id, t }
const identityOf = (st) => `${st.mtimeNs}:${st.size}:${st.ino}`;
const isClosed = (t) => !!t && Number.isInteger(t.pid) && Number.isFinite(t.from) && Number.isFinite(t.until);
function keep(file, id, t) { if (isClosed(t)) closedSeen.set(file, { id, t: { ...t } }); else closedSeen.delete(file); }
function readTombstone(file) {
  const id = identityOf(io.stat(file)); // throws ENOENT for a file gone since the listing: the caller skips it
  const kept = closedSeen.get(file);
  if (kept && kept.id === id) return { ...kept.t };
  const t = readJson(file);
  keep(file, id, t);
  return t;
}
// The tombstone directory listed and read without blocking the event loop, closed files through the same kept values the check
// uses. -> { names, list }: every tombstone file name, and every valid tombstone that read (one that does not read or parse is left
// out; the check judges it). Throws when the directory exists and cannot be read.
async function tombstonesAsync({ batch = 32 } = {}) {
  let names;
  try { names = (await io.readdirAsync(exitedDir())).filter((n) => /^[0-9]+-[0-9]+[.]json$/.test(n)); } catch (e) { if (e && e.code === 'ENOENT') return { names: [], list: [] }; throw e; }
  const list = [];
  for (let i = 0; i < names.length; i += batch) {
    await Promise.all(names.slice(i, i + batch).map(async (n) => {
      const file = path.join(exitedDir(), n);
      try {
        const id = identityOf(await io.statAsync(file)); // the identity before the read, as readTombstone takes it
        const kept = closedSeen.get(file);
        let t;
        if (kept && kept.id === id) t = { ...kept.t };
        else { t = JSON.parse(await io.readAsync(file)); keep(file, id, t); }
        if (t && Number.isInteger(t.pid) && Number.isFinite(t.from)) list.push(t);
      } catch { /* gone, unreadable or unparseable: left to the check */ }
    }));
  }
  return { names, list };
}
// Fill the kept closed tombstones off the event loop (an owner calls it when it starts serving), so its first check does not read the
// whole history at once. It decides nothing: a check still lists, stats and judges every file itself. Never throws.
async function warmTombstones(o) { try { return (await tombstonesAsync(o)).list.length; } catch { return 0; } }
function forgetUnlisted(dirPath, names) {
  if (!closedSeen.size) return;
  const listed = new Set(names.map((n) => path.join(dirPath, n)));
  for (const f of [...closedSeen.keys()]) if (path.dirname(f) === dirPath && !listed.has(f)) closedSeen.delete(f);
}

// What `belay doctor` reports, and nothing is written: the unproven files in the register now, each with `alive` by unprovenAlive
// without a snapshot (the boot rule, then whether a process holds the pid; the owner's check also compares creation times, so a pid
// held by a younger process counts here and not there), and the files moved to corrupt/. -> { dir, corrupt, unproven: [{ name, file, why, alive }], moved: [name], error? }
function problems() {
  const out = { dir: dir(), corrupt: corruptDir(), unproven: [], moved: [] };
  try { out.moved = fs.readdirSync(corruptDir()).sort(); } catch (e) { if (!e || e.code !== 'ENOENT') out.error = `${corruptDir()} cannot be read (${e && e.code})`; }
  try {
    const r = scan();
    const t = tombstoneScan();
    const row = (u, alive) => ({ name: u.name, file: u.file, why: u.why, alive });
    out.unproven = [...r.live.filter((x) => x.unproven).map((x) => row(x.unproven, true)), ...r.dead.filter((d) => d.unproven).map((d) => row(d.unproven, false)),
      ...t.list.filter((x) => x.unproven).map((x) => row(x.unproven, true)), ...t.dead.map((u) => row(u, false))];
  } catch (e) { out.error = `the register cannot be read (${(e && e.message) || e})`; }
  return out;
}

// What `belay run` tells its owner it spawned besides the workers: the headless orchestrator, once its pid is known. The interactive
// orchestrator is the human's own session (its plugin runs the CLI), so it is listed nowhere.
// `created` is the orchestrator's creation time once it is known; until then the entry matches by pid alone (fail closed).
function runSpawned(interactive, orchestratorPid, created = null) {
  return !interactive && Number.isInteger(orchestratorPid) ? [{ pid: orchestratorPid, created: Number.isFinite(created) ? created : null, kind: 'orchestrator' }] : [];
}

module.exports = { matches, register, registerProcess, update, unregister, retire, touch, stampNow, scan, settle, list, live, tombFile, startOf, bootMs, BOOT_SLACK_MS, SEEN_REFRESH_MS, tombstones, tombstoneScan, tombstonesAsync, warmTombstones, saveTombstone, dropTombstone, dropTombstoneAsync, moveAside, unprovenLife, problems, dir, runSpawned, io };
