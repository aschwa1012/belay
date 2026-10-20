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

// Check the string form, then the real path, create the folder, then check the real path again. Returns the resolved folder.
// `seam.beforeMkdir` (tests only) runs between the first check and the create, where a folder swap would land.
function prepareFolder(dir, seam = {}) {
  const folder = S.checkNativeMemory(dir);
  assertOutsideConfig(folder);
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

// Called (and awaited) by the manager before every Claude Code launch of a process it is about to start. The refusals, each by name:
// the folder's real path (a junction planted since the spawn), the record against settings.json, and settings.json against the
// bytes this manager wrote. A refusal is noted on the worker and, when no process of it is alive, written as a dead row naming
// the cause; the row is awaited and carried in the error, so a caller never sees a refusal before its row is confirmed.
// An adopt (a second manager, a stop or message) never calls this: it regenerates the file from the record and refuses nothing.
async function guardLaunch(ctx, w, pidAlive) {
  if (w.substrate !== 'claude-code') return;
  try {
    if (w.nativeMemory != null) prepareFolder(w.nativeMemory);
    const file = w.workerSettingsPath || fwd(path.join(w.dir, 'settings.json'));
    verifySettings(file, w.nativeMemory);
    if (w.settingsFingerprint && fingerprint(file) !== w.settingsFingerprint) {
      throw refuse('the worker settings.json is not what the harness wrote for this worker; the launch is refused', { settings: file, reason: 'settings_changed' }, 'E_NATIVE_MEMORY_MISMATCH');
    }
  } catch (e) {
    w.lastError = { where: 'native_memory', code: e.code, message: e.message };
    w.launchFailed = true;
    if (!(w.pid && pidAlive(w.pid))) {
      w.deathEstablishedBy = e.code === 'E_NATIVE_MEMORY_MISMATCH' ? 'native_memory_settings_mismatch' : 'native_memory_folder_refused';
      let row = null;
      try { row = await ctx.writeRow(w, 'dead'); } catch (err) { w.lastError = { where: 'native_memory.write', code: err && err.code, message: err && err.message }; e.detail = { ...e.detail, dead_row_error: err && err.message }; }
      e.detail = { ...e.detail, dead_row: row ? { seq: row.seq == null ? null : row.seq, state: row.state, death_established_by: row.death_established_by == null ? null : row.death_established_by } : null };
    }
    throw e;
  }
}

module.exports = { prepareFolder, assertOutsideConfig, verifySettings, guardLaunch, fingerprint };
