'use strict';
// native-memory.cjs — ADR 0024 amendment 3: the file-system half of the native_memory guarantee. surface.cjs resolves and compares the
// folder as a string; this module follows what is on disk (junctions, 8.3 names) before and after the folder is created, and checks
// that a worker's settings.json still says what the harness's record of the launch says. The lever's value is read only from that
// record (the worker row's native_memory column); settings.json is an output, never an input.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./surface.cjs');

const fwd = (p) => String(p).replace(/\\/g, '/');
const lc = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const refuse = (message, detail, code = 'E_ARGS') => Object.assign(new Error(message), { code, detail });

// The real path of `p`, or of its deepest existing ancestor with the missing tail appended, so a folder that does not exist yet
// but sits below a junction is judged by where it would land. `strict` (the worker's folder, not a config directory): a link that
// exists but does not resolve (a dangling junction) is refused, not walked past to its parent, since it could be retargeted.
function realOf(p, strict = false) {
  let cur = path.resolve(p); const tail = [];
  for (;;) {
    try { return fwd(path.join(fs.realpathSync.native(cur), ...tail)); } catch (e) {
      const up = path.dirname(cur);
      if (up === cur || !e || e.code !== 'ENOENT') return fwd(path.resolve(p));
      if (strict && fs.lstatSync(cur, { throwIfNoEntry: false })) {
        throw refuse('native_memory passes through a link that does not resolve, so where it would land cannot be judged', { native_memory: fwd(p), link: fwd(cur), reason: 'unresolvable_link' });
      }
      tail.unshift(path.basename(cur)); cur = up;
    }
  }
}

function assertOutsideConfig(folder) {
  const real = realOf(folder, true);
  for (const c of S.claudeConfigDirs()) {
    const realC = realOf(c);
    if (S.under(lc(real), lc(realC)) || S.under(lc(real), lc(c))) {
      throw refuse("native_memory resolves into Claude Code's config directory, where its default memory folder lives", { native_memory: folder, real, config_dir: realC, reason: 'claude_config_dir' });
    }
  }
}

// The folder, or the deepest ancestor of it that exists, must be a directory: a regular file there would make the create throw
// EEXIST or ENOTDIR after a worker's directory and record already exist. Nothing is created.
function assertCreatable(folder) {
  for (let cur = path.resolve(folder); ;) {
    const st = fs.statSync(cur, { throwIfNoEntry: false });
    if (st) {
      if (!st.isDirectory()) throw refuse('native_memory is, or sits below, something that is not a directory', { native_memory: fwd(folder), blocking: fwd(cur), reason: 'not_a_directory' });
      return;
    }
    const up = path.dirname(cur);
    if (up === cur) return;
    cur = up;
  }
}

// The checks that need no folder to exist, shared by the spawn's validation and prepareFolder: the string form, the real path
// against the config directories, and that the folder can be created. Returns the resolved folder; creates nothing.
function checkFolder(dir) {
  const folder = S.checkNativeMemory(dir);
  assertOutsideConfig(folder);
  assertCreatable(folder);
  return folder;
}

// Check the string form, then the real path, create the folder, then check the real path again. Returns the resolved folder.
// `seam.beforeMkdir` (tests only) runs between the first check and the create, where a folder swap would land.
function prepareFolder(dir, seam = {}) {
  const folder = checkFolder(dir);
  if (seam.beforeMkdir) seam.beforeMkdir(folder);
  fs.mkdirSync(folder, { recursive: true });
  assertOutsideConfig(folder);
  return folder;
}

// A hash of the settings.json the harness wrote for this worker, taken straight after the write; null when it cannot be read.
function fingerprint(settingsFile) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(settingsFile)).digest('hex'); } catch { return null; }
}

// The settings.json on disk must agree with the record: off means autoMemoryEnabled false and no autoMemoryDirectory; on means
// enabled and the recorded folder. A missing file is a first launch. Anything else is refused by name.
function verifySettings(settingsFile, record) {
  let st;
  try { st = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw refuse('the worker settings.json cannot be read, so it cannot be checked against the native_memory record', { settings: settingsFile, cause: e && e.message }, 'E_NATIVE_MEMORY_MISMATCH');
  }
  const wantOn = record != null;
  const dir = st && st.autoMemoryDirectory;
  const agrees = st && typeof st === 'object' && (wantOn ? st.autoMemoryEnabled === true && S.sameDir(dir, record) : st.autoMemoryEnabled === false && !('autoMemoryDirectory' in st));
  if (!agrees) {
    throw refuse('the worker settings.json disagrees with the harness record of native_memory; the launch is refused', {
      settings: settingsFile, recorded: record == null ? null : record,
      found: st && typeof st === 'object' ? { autoMemoryEnabled: st.autoMemoryEnabled === undefined ? null : st.autoMemoryEnabled, autoMemoryDirectory: dir === undefined ? null : dir } : null,
    }, 'E_NATIVE_MEMORY_MISMATCH');
  }
}

// The refusals, each by name: the folder's real path (a junction planted since the spawn), the record against settings.json, and
// settings.json against the bytes this manager wrote. SYNCHRONOUS on purpose: the manager calls it first in launch(), so a
// check-then-spawn (the Codex one-process-per-turn test) stays one tick. It returns when the launch may go ahead and throws the
// refusal otherwise; the caller then awaits refuse() for the row. Only a Claude Code launch is guarded. Nothing here is a read of
// settings.json at spawn time: the file can still change between this check and Claude Code's own read, and that window is not closed.
function checkLaunch(w) {
  if (w.substrate !== 'claude-code') return;
  if (w.adoptRefusal) throw w.adoptRefusal; // the adopt could not write this worker's files from a record the checker now refuses
  if (w.nativeMemory != null) prepareFolder(w.nativeMemory);
  const file = w.workerSettingsPath || fwd(path.join(w.dir, 'settings.json'));
  verifySettings(file, w.nativeMemory);
  if (w.settingsFingerprint && fingerprint(file) !== w.settingsFingerprint) {
    throw refuse('the worker settings.json is not what the harness wrote for this worker; the launch is refused', { settings: file, reason: 'settings_changed' }, 'E_NATIVE_MEMORY_MISMATCH');
  }
  if (w.nativeMemoryRefused) { w.nativeMemoryRefused = false; w.launchFailed = false; } // the cause is gone: this launch may write its running row
}

// Who opted in to a worker's native_memory is its own fact on the worker row (`native_memory_auth`), written once by the spawn that took the
// lever and carried unchanged by every later row. It is not the row's run_id, which every writer sets to itself (a refusal's dead row, a stop),
// so a run that was refused cannot pass as the run that opted in. A run id can also be used again by a later run, so the grant names the run's
// lifetime: the seq of the first run row after the last row that ended one, the same for every epoch of a run that lapsed and reattached.
const UNKNOWN = Symbol('lifetime unknown');
async function lifetimeOf(core, runId) {
  if (!core || !core.run || typeof core.run.get !== 'function') return null;
  const got = await core.run.get();
  const rows = ((got && got.epochs) || []).filter((r) => r && r.id === runId && Number.isInteger(r.seq)).sort((x, y) => x.seq - y.seq);
  let start = null; let cur = null;
  for (const r of rows) { if (start == null) start = r.seq; cur = start; if (r.ended_at != null) start = null; }
  return cur;
}
async function authorize(core, runId, folder) {
  return folder == null ? null : JSON.stringify({ run_id: runId, lifetime: await lifetimeOf(core, runId) });
}
function authOf(raw) {
  try { const a = JSON.parse(raw); return a && typeof a === 'object' && !Array.isArray(a) ? a : null; } catch { return null; }
}

// An adopted worker's native_memory is the record of the run that opted in. It is carried only into that run in that lifetime (a restart by
// another adapter of it) or into a run whose own lever names the same folder; any other run never opted in, so the folder is not written
// into its settings and its relaunch is refused. A lifetime that cannot be read grants nothing. Returns the refusal, or null. A stop is
// never affected: it goes through.
async function adoptDenied(w, runId, levers, core) {
  if (w.nativeMemory == null) return null;
  const auth = authOf(w.nativeMemoryAuth);
  if (auth && auth.run_id === runId) {
    let now = UNKNOWN; try { now = await lifetimeOf(core, runId); } catch { now = UNKNOWN; }
    if (now === auth.lifetime) return null;
  }
  const lever = levers && levers.native_memory;
  let same = false;
  try { same = typeof lever === 'string' && S.sameDir(S.checkNativeMemory(lever), w.nativeMemory); } catch { same = false; }
  if (same) return null;
  return refuse("the worker's native_memory was recorded by another run, and this run's own native_memory lever does not name it; a relaunch is refused (a stop still goes through)",
    { worker_id: w.id, native_memory: w.nativeMemory, opted_in_by: auth ? { run_id: auth.run_id == null ? null : auth.run_id, lifetime: auth.lifetime === undefined ? null : auth.lifetime } : null, run_id: runId, reason: 'foreign_native_memory' });
}

// A refusal is noted on the worker and, when no process of it is alive, written as a dead row naming the cause; the row is awaited
// and carried in the error, so a caller never sees a refusal before its row is confirmed. Throws `e`. An adopt (a stop, a message)
// never calls checkLaunch: a stop always goes through.
async function refuseLaunch(ctx, w, e, pidAlive) {
  w.lastError = { where: 'native_memory', code: e.code, message: e.message };
  w.launchFailed = true; w.nativeMemoryRefused = true;
  if (!(w.pid && pidAlive(w.pid))) {
    w.deathEstablishedBy = e.code === 'E_NATIVE_MEMORY_MISMATCH' ? 'native_memory_settings_mismatch' : 'native_memory_folder_refused';
    w.settled = true; w.settledState = 'dead'; // dead now: a settled state fixed by the life before (paused, stopped) must not be what worker_wait answers
    let row = null;
    try { row = await ctx.writeRow(w, 'dead'); } catch (err) { w.lastError = { where: 'native_memory.write', code: err && err.code, message: err && err.message }; e.detail = { ...e.detail, dead_row_error: err && err.message }; }
    e.detail = { ...e.detail, dead_row: row ? { seq: row.seq == null ? null : row.seq, state: row.state, death_established_by: row.death_established_by == null ? null : row.death_established_by } : null };
    w.paused = null; w.parkRequested = null; // the park this refused relaunch would have cleared: the worker is dead now, so a later restart is allowed once the cause is gone
  }
  throw e;
}

module.exports = { adoptDenied, authorize, lifetimeOf, checkFolder, assertCreatable, prepareFolder, assertOutsideConfig, verifySettings, checkLaunch, refuseLaunch, fingerprint };
