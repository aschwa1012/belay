'use strict';
// worker-temp.cjs — ADR 0084 amendment 1: every worker gets its own temp folder, <base>/belay/<run id>/<worker id>, made at each
// launch and removed when the run's manager shuts down. buildEnv points TEMP, TMP and TMPDIR at it, so `os.tmpdir()`, `tempfile`
// and Git Bash's own `/tmp` mount land in a folder belay owns instead of the operator's. <base> is the OS temp dir, or
// %LOCALAPPDATA%\Temp when that lies in the home folder outside AppData (the Windows Search index and Defender crawl it, and a
// worker's temp traffic would pin kernel pool memory: tests/helpers/temp-root.cjs refuses the same place). It is never under the
// data directory, which defaults to <project>/.belay. Each run folder holds `.owner.json` (the adapter's pid, the data directory,
// the time), refreshed at every launch; a later start sweeps a run folder whose owner is gone and that has been idle a day.
// Never throws: a folder that cannot be made means the worker keeps the inherited temp dir (make returns null).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = 'belay';
const MARKER = '.owner.json';
const SWEEP_IDLE_MS = 24 * 60 * 60 * 1000;
const SEGMENT = /^(?!\.{1,2}$)[\w.-]+$/; // a run or worker id used as a folder name; anything else gets no folder
const seg = (x) => typeof x === 'string' && SEGMENT.test(x);

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
// must not turn the cleanup into a delete of another tree).
function make(runId, workerId, { root = base(), dataDir = null } = {}) {
  if (!seg(runId) || !seg(workerId)) return null;
  try {
    const top = path.join(root, ROOT);
    if (!realDir(top)) { if (isLink(top)) return null; fs.mkdirSync(top, { recursive: true }); }
    if (swept === null) swept = sweep({ root });
    const run = path.join(top, String(runId));
    if (!realDir(run)) { if (isLink(run)) return null; fs.mkdirSync(run); }
    fs.writeFileSync(path.join(run, MARKER), JSON.stringify({ pid: process.pid, run_id: String(runId), data_dir: dataDir, at: Date.now() }));
    const dir = path.join(run, String(workerId));
    if (!realDir(dir)) { if (isLink(dir)) return null; fs.mkdirSync(dir); }
    return realDir(dir) ? path.resolve(dir) : null;
  } catch { return null; }
}

// The birth time of a worker's temp folder, the moment of its first launch; null for any other folder (one without a belay run folder
// above it carrying the marker), so a hook running in the operator's own temp dir never takes its birth for a launch.
function birthOf(dir) {
  try {
    const run = path.dirname(path.resolve(dir));
    if (!fs.lstatSync(path.join(run, MARKER)).isFile() || path.basename(path.dirname(run)) !== ROOT) return null;
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

// A run folder is belay's own, and abandoned, when its name is a plain segment, its marker is a small regular file naming that same run,
// its owner's pid is gone and nothing has refreshed it for `idleMs`. Anything else is left alone.
function sweep({ root = base(), idleMs = SWEEP_IDLE_MS, now = Date.now(), skipRun = null } = {}) {
  const out = { swept: 0, bytes: 0, failed: [], kept: 0 };
  const top = path.join(root, ROOT);
  let names = [];
  try { if (!realDir(top)) return out; names = fs.readdirSync(top); } catch { return out; }
  for (const name of names) {
    const run = path.join(top, name);
    try {
      if (name === skipRun || !seg(name) || !realDir(run)) { out.kept += 1; continue; }
      const mp = path.join(run, MARKER);
      const st = fs.lstatSync(mp);
      const m = st.isFile() && st.size < 4096 ? JSON.parse(fs.readFileSync(mp, 'utf8')) : null;
      if (!m || m.run_id !== name || !Number.isInteger(m.pid) || alive(m.pid) || now - st.mtimeMs < idleMs) { out.kept += 1; continue; }
      const r = { removed: 0, bytes: 0, failed: [] };
      removeDir(run, r, name);
      out.swept += r.removed; out.bytes += r.bytes; out.failed.push(...r.failed);
    } catch { out.kept += 1; }
  }
  return out;
}

// The run's end: every worker's folder goes, except those the shutdown left alone because the worker may still run or be resumed
// (`left_parked`, `left_stale`, `stop_failed`). The run folder goes with the last one. Returns `res` with a `worker_temp` block.
function closeRun(workers, runId, res, { root = base() } = {}) {
  const keep = new Set([...((res && res.left_parked) || []), ...((res && res.left_stale) || []), ...(((res && res.stop_failed) || []).map((s) => s && s.worker_id))]);
  const out = { removed: 0, bytes: 0, failed: [], kept: [...keep].filter(Boolean), swept };
  if (seg(runId)) {
    for (const w of workers.values()) if (w && w.id && !keep.has(w.id) && seg(w.id)) removeDir(dirFor(runId, w.id, root), out, w.id);
    const run = runDirOf(runId, root);
    try { if (realDir(run) && fs.readdirSync(run).every((n) => n === MARKER)) fs.rmSync(run, { recursive: true, force: true }); } catch { /* left; the sweep takes it */ }
  }
  return { ...(res || {}), worker_temp: out };
}

// One log line for the adapter's shutdown line.
const describe = (t) => (t ? `temp removed=${t.removed} bytes=${t.bytes} kept=${t.kept.length} failed=${t.failed.length}${t.swept && t.swept.swept ? ` swept=${t.swept.swept}` : ''}` : '');

module.exports = { make, closeRun, sweep, birthOf, dirFor, runDirOf, base, describe, MARKER, ROOT };
