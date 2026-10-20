'use strict';
// native-memory.cjs — ADR 0024 amendment 3: the file-system half of the native_memory guarantee. surface.cjs resolves and compares the
// folder as a string; this module follows what is on disk (junctions, 8.3 names) before and after the folder is created, and checks
// that a worker's settings.json still says what the harness's record of the launch says. The lever's value is read only from that
// record (the worker row's native_memory column); settings.json is an output, never an input.

const fs = require('node:fs');
const path = require('node:path');
const S = require('./surface.cjs');

const fwd = (p) => String(p).replace(/\\/g, '/');
const lc = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const refuse = (message, detail, code = 'E_ARGS') => Object.assign(new Error(message), { code, detail });

// The real path of `p`, or of its deepest existing ancestor with the missing tail appended, so a folder that does not exist yet
// but sits below a junction is judged by where it would land.
function realOf(p) {
  let cur = path.resolve(p); const tail = [];
  for (;;) {
    try { return fwd(path.join(fs.realpathSync.native(cur), ...tail)); } catch (e) {
      const up = path.dirname(cur);
      if (up === cur || !e || e.code !== 'ENOENT') return fwd(path.resolve(p));
      tail.unshift(path.basename(cur)); cur = up;
    }
  }
}

function assertOutsideConfig(folder) {
  const real = realOf(folder);
  for (const c of S.claudeConfigDirs()) {
    const realC = realOf(c);
    if (S.under(lc(real), lc(realC)) || S.under(lc(real), lc(c))) {
      throw refuse("native_memory resolves into Claude Code's config directory, where its default memory folder lives", { native_memory: folder, real, config_dir: realC, reason: 'claude_config_dir' });
    }
  }
}

// Check the string form, then the real path, create the folder, then check the real path again. Returns the resolved folder.
function prepareFolder(dir) {
  const folder = S.checkNativeMemory(dir);
  assertOutsideConfig(folder);
  fs.mkdirSync(folder, { recursive: true });
  assertOutsideConfig(folder);
  return folder;
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

// Called by the manager before every Claude Code launch and before an adopted worker's files are rewritten. A refusal is noted on the worker and, when no process of it is alive,
// written as a dead row naming the cause.
function guardLaunch(ctx, w, pidAlive) {
  if (w.substrate !== 'claude-code') return;
  try { verifySettings(w.workerSettingsPath || fwd(path.join(w.dir, 'settings.json')), w.nativeMemory); } catch (e) {
    w.lastError = { where: 'native_memory', code: e.code, message: e.message };
    w.launchFailed = true;
    if (!(w.pid && pidAlive(w.pid))) {
      w.deathEstablishedBy = 'native_memory_settings_mismatch';
      Promise.resolve(ctx.writeRow(w, 'dead')).catch((err) => { w.lastError = { where: 'native_memory.write', code: err && err.code, message: err && err.message }; });
    }
    throw e;
  }
}

module.exports = { prepareFolder, assertOutsideConfig, verifySettings, guardLaunch };
