'use strict';
// worker-temp.cjs — ADR 0084 amendment 1: every worker gets its own temp folder, <base>/belay/<run id>/<worker id>, made at each
// launch and removed when the run's manager shuts down. buildEnv points TEMP, TMP and TMPDIR at it, so `os.tmpdir()`, `tempfile`
// and Git Bash's own `/tmp` mount land in a folder belay owns instead of the operator's. <base> is the OS temp dir, or
// %LOCALAPPDATA%\Temp when that lies in the home folder outside AppData (the Windows Search index and Defender crawl it, and a
// worker's temp traffic would pin kernel pool memory: tests/helpers/temp-root.cjs refuses the same place). It is never under the
// data directory, which defaults to <project>/.belay. Each run folder holds one owner file per adapter that launched into it (pid,
// start time, run, data directory, time), rewritten at every launch; a later start sweeps a run folder whose launchers are all gone and
// that has been idle a day, by renaming it aside and re-checking before it removes anything.
// Never throws: a folder that cannot be made means the worker keeps the inherited temp dir (make returns null).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = 'belay';
const OWNER_RE = /^\.owner-(\d+)\.json$/; // one file per adapter that launched into the run, so no launcher overwrites another's
const ownerFile = (pid) => `.owner-${pid}.json`;
const TOMB_RE = /^\.gone-(.+)-[0-9a-f]{8}$/; // a run folder renamed aside by a sweep, before it is removed
const SWEEP_IDLE_MS = 24 * 60 * 60 * 1000;
const SEGMENT = /^(?!\.{1,2}$)[\w.-]+$/; // a run or worker id used as a folder name; anything else gets no folder
const seg = (x) => typeof x === 'string' && SEGMENT.test(x) && !x.startsWith('.gone-');

const norm = (p) => { let r = path.resolve(String(p)); try { r = fs.realpathSync.native(r); } catch { /* not there yet: as written */ } return r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); };
const under = (child, parent) => child === parent || child.startsWith(`${parent}/`);

// The folder under which `belay/` lives.
function base(env = process.env, home = os.homedir(), platform = process.platform) {
  const tmp = os.tmpdir();
  if (platform !== 'win32' || !home) return tmp;
  const h = norm(home); const d = norm(tmp);
  if (under(d, h) && !under(d, `${h}/appdata`)) return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Temp');
  return tmp;
}
const runDirOf = (runId, root = base()) => path.join(root, ROOT, String(runId));
const dirFor = (runId, workerId, root) => path.join(runDirOf(runId, root), String(workerId));

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
function realDir(p) { try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } }

let swept = null; // the summary of this process's one sweep, reported by closeRun

// The folder for a worker of a run, made if it is not there. A link in any of the three places is refused (a worker's own `mklink`
// must not turn the cleanup into a delete of another tree). This adapter's owner file (pid, start time, run, data dir, time) is
// rewritten first; a sweep by another process that renames the run folder aside between two steps makes the step fail, and the
// whole sequence is run once more. The sweep skips this run: a process resuming a parked worker long after its folder went idle
// must not delete the folder it is about to use.
function restoreTomb(top, runId, run) {
  try {
    for (const n of fs.readdirSync(top)) {
      const m = TOMB_RE.exec(n);
      if (m && m[1] === runId && realDir(path.join(top, n))) { fs.renameSync(path.join(top, n), run); return; }
    }
  } catch { /* the folder is made new */ }
}
function makeOnce(runId, workerId, root, dataDir) {
  const top = path.join(root, ROOT);
  if (!realDir(top)) { if (isLink(top)) return null; fs.mkdirSync(top, { recursive: true }); }
  const run = path.join(top, String(runId));
  if (!realDir(run) && !isLink(run)) restoreTomb(top, String(runId), run); // a sweep that renamed this run aside: take it back whole
  if (!realDir(run)) { if (isLink(run)) return null; fs.mkdirSync(run); }
  fs.writeFileSync(path.join(run, ownerFile(process.pid)), JSON.stringify({ pid: process.pid, created: Math.round(Date.now() - process.uptime() * 1000), run_id: String(runId), data_dir: dataDir, at: Date.now() }));
  const dir = path.join(run, String(workerId));
  if (!realDir(dir)) { if (isLink(dir)) return null; fs.mkdirSync(dir); }
  return realDir(dir) ? path.resolve(dir) : null;
}
function make(runId, workerId, { root = base(), dataDir = null } = {}) {
  if (!seg(runId) || !seg(workerId)) return null;
  try {
    if (swept === null) { fs.mkdirSync(path.join(root, ROOT), { recursive: true }); swept = sweep({ root, skipRun: String(runId) }); }
  } catch { /* no sweep this time */ }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return makeOnce(runId, workerId, root, dataDir); } catch { /* a sweep renamed the folder aside, or a transient error: once more */ }
  }
  return null;
}

// The birth time of a worker's temp folder, the moment of its first launch; null for any other folder (one without a belay run folder
// above it carrying an owner file), so a hook running in the operator's own temp dir never takes its birth for a launch.
function birthOf(dir) {
  try {
    const run = path.dirname(path.resolve(dir));
    if (path.basename(path.dirname(run)) !== ROOT || !fs.readdirSync(run).some((n) => OWNER_RE.test(n))) return null;
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() ? st.birthtimeMs : null;
  } catch { return null; }
}

// Bytes under a folder, links not followed.
function size(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      n += e.isDirectory() ? size(p) : (fs.lstatSync(p).size || 0);
    }
  } catch { /* counted as far as it could be read */ }
  return n;
}
// Removes a folder: a link at its top is unlinked, and rmSync (which uses lstat) unlinks any link inside it; none is followed.
function removeDir(dir, out, id) {
  let st = null;
  try { st = fs.lstatSync(dir); } catch { return; }
  try {
    if (st.isSymbolicLink()) { try { fs.unlinkSync(dir); } catch { fs.rmdirSync(dir); } } // a junction goes as a directory entry
    else { out.bytes += size(dir); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    out.removed += 1;
  } catch (e) { out.failed.push({ worker_id: id, code: (e && e.code) || String(e) }); }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };

// The owner files of a run folder, each { pid, mtimeMs }; null when there is none, one is not a small regular file of valid JSON naming
// this run and the pid in its name, so a folder that is not plainly belay's own is never judged abandoned.
function owners(dir, name) {
  try {
    const list = fs.readdirSync(dir).filter((n) => OWNER_RE.test(n));
    if (!list.length) return null;
    const out = [];
    for (const n of list) {
      const p = path.join(dir, n);
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.size >= 4096) return null;
      const m = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!m || m.run_id !== name || !Number.isInteger(m.pid) || ownerFile(m.pid) !== n) return null;
      out.push({ pid: m.pid, mtimeMs: st.mtimeMs });
    }
    return out;
  } catch { return null; }
}
const abandoned = (dir, name, now, idleMs) => { const o = owners(dir, name); return !!o && o.every((x) => !alive(x.pid) && now - x.mtimeMs >= idleMs); };

// A run folder is belay's own, and abandoned, when its name is a plain segment and every owner file in it names a pid that is gone and has
// not been rewritten for `idleMs`; any live launcher keeps it. Removal is two steps so a process starting at the same moment is not
// cut: the folder is renamed to a tombstone (atomic; it fails if the folder is in use or already taken), the owner files are read again
// on the renamed folder, and only if it is still abandoned is it removed. On any doubt it is renamed back, or left under the tombstone
// name, which a later sweep judges the same way. Links are never followed. Anything else is left alone.
function sweep({ root = base(), idleMs = SWEEP_IDLE_MS, now = Date.now(), skipRun = null } = {}) {
  const out = { swept: 0, bytes: 0, failed: [], kept: 0 };
  const top = path.join(root, ROOT);
  let names = [];
  try { if (!realDir(top)) return out; names = fs.readdirSync(top); } catch { return out; }
  const drop = (dir, id) => { const r = { removed: 0, bytes: 0, failed: [] }; removeDir(dir, r, id); out.swept += r.removed; out.bytes += r.bytes; out.failed.push(...r.failed); };
  for (const name of names) {
    const run = path.join(top, name);
    try {
      const tomb = TOMB_RE.exec(name);
      if (tomb) { if (tomb[1] !== skipRun && realDir(run) && abandoned(run, tomb[1], now, idleMs)) drop(run, tomb[1]); else out.kept += 1; continue; }
      if (name === skipRun || !seg(name) || !realDir(run) || !abandoned(run, name, now, idleMs)) { out.kept += 1; continue; }
      const aside = path.join(top, `.gone-${name}-${crypto.randomBytes(4).toString('hex')}`);
      try { fs.renameSync(run, aside); } catch { out.kept += 1; continue; }
      if (abandoned(aside, name, now, idleMs)) { drop(aside, name); continue; }
      out.kept += 1;
      try { fs.renameSync(aside, run); } catch { /* the folder was recreated meanwhile: the tombstone stays for a later sweep */ }
    } catch { out.kept += 1; }
  }
  return out;
}

// The run's end: every worker's folder goes, except those the shutdown left alone because the worker may still run or be resumed
// (`left_parked`, `left_stale`, `stop_failed`). This adapter's owner file goes with them; the run folder goes when nothing else is in it
// but owner files of adapters that are gone. Returns `res` with a `worker_temp` block.
function closeRun(workers, runId, res, { root = base() } = {}) {
  const keep = new Set([...((res && res.left_parked) || []), ...((res && res.left_stale) || []), ...(((res && res.stop_failed) || []).map((s) => s && s.worker_id))]);
  const out = { removed: 0, bytes: 0, failed: [], kept: [...keep].filter(Boolean), swept };
  if (seg(runId)) {
    for (const w of workers.values()) if (w && w.id && !keep.has(w.id) && seg(w.id)) removeDir(dirFor(runId, w.id, root), out, w.id);
    const run = runDirOf(runId, root);
    try {
      if (realDir(run)) {
        const rest = fs.readdirSync(run);
        const mine = ownerFile(process.pid);
        if (rest.every((n) => OWNER_RE.test(n))) {
          const others = rest.filter((n) => n !== mine).map((n) => Number(OWNER_RE.exec(n)[1]));
          if (!others.some(alive)) fs.rmSync(run, { recursive: true, force: true });
          else fs.rmSync(path.join(run, mine), { force: true });
        }
      }
    } catch { /* left; the sweep takes it */ }
  }
  return { ...(res || {}), worker_temp: out };
}

// One log line for the adapter's shutdown line.
const describe = (t) => (t ? `temp removed=${t.removed} bytes=${t.bytes} kept=${t.kept.length} failed=${t.failed.length}${t.swept && t.swept.swept ? ` swept=${t.swept.swept}` : ''}` : '');

module.exports = { make, closeRun, sweep, birthOf, dirFor, runDirOf, base, describe, OWNER_RE, ownerFile, forgetSweep: () => { swept = null; }, ROOT };
