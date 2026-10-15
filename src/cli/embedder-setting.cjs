'use strict';
// embedder-setting.cjs — the one small function that persists the operator's choice of `memory.on_embedder_failure` (ADR 0034
// amendment 1) in belay's config file, and the one that reads it back as a default for a run whose spec does not say.
//
// The file is belay.config.json, found the way every command finds it (config.cjs `discover`, never the home directory). The value
// lives in its `memory` block: { "memory": { "on_embedder_failure": "keyword" } }. The write is atomic (a temp file beside it, then
// a rename), keeps every other key as it was, and returns the old and new value as its receipt. The settings CLI (cli/settings-levers)
// has its own validated writer for the same file; the two are to be unified there, and this one is deliberately the whole of what a
// resume needs. Nothing here imports src/core beyond the tiny embedder-mode module (no store, no embedder).

const fs = require('node:fs');
const C = require('./config.cjs');
const EM = require('../core/embedder-mode.cjs');

const seams = { rename: (from, to) => fs.renameSync(from, to) }; // a test makes the rename fail

// The mode the config file gives, canonical, or null (no file, no block, an unreadable file, or a value that is not one).
function readConfigMode(cwd) {
  try {
    const found = C.discover(cwd);
    if (!found.found || found.parse_error) return null;
    const m = found.config.memory;
    return m && typeof m === 'object' ? EM.normalize(m.on_embedder_failure) : null;
  } catch { return null; }
}

// SWAP POINT: this is the small stand-in for the settings CLI's validated writer, `writeSetting(found, key, value, ctx)` in
// src/cli/cmd-settings.cjs (branch cli/settings-levers). It has the same signature and return shape on purpose, so that at the merge
// the one call in cmd-pause.cjs (runForm) can be pointed at that function and this file's writer deleted; readConfigMode stays.
//
// writeSetting(found, key, value, ctx): `found` is config.discover's result, `key` must be 'memory.on_embedder_failure', `value` a mode
// (the old names accepted, the new stored), `ctx.cwd` says where to create belay.config.json (at the project root, config.writeDirOf)
// when none was found. The whole memory block is validated with parseMemoryBlock before anything is written; the write is atomic (a
// temp file beside it, then a rename) and keeps every other key. Returns { code, text, json }: code 0 with json { key, path, created,
// old, new }; code 2 when refused (a bad key or value, a block that does not validate, a config file that is not a JSON object), nothing
// written; code 1 when the write itself failed, the old file untouched.
function writeSetting(found, key, value, ctx = {}) {
  const refuse = (code, message) => ({ code, text: `belay settings: ${message}\n`, json: { error: message, key } });
  if (key !== CONFIG_KEY) return refuse(2, `${key} is not a setting this writer knows (it writes ${CONFIG_KEY})`);
  const mode = EM.normalize(value);
  if (mode === null) return refuse(2, `${key} must be one of ${EM.describe()}`);
  if (found && found.found && found.parse_error) return refuse(2, `not writing: ${found.parse_error}`);
  const existing = found && found.found ? { ...found.config } : {};
  const block = existing.memory && typeof existing.memory === 'object' && !Array.isArray(existing.memory) ? { ...existing.memory } : {};
  const next = { ...block, on_embedder_failure: mode };
  const checked = require('../core/memory-levers.cjs').parseMemoryBlock(next);
  if (checked.error) return refuse(2, checked.error);
  const file = found && found.found ? found.path : `${C.writeDirOf(ctx.cwd || process.cwd())}/${C.CONFIG_NAME}`;
  const old = EM.normalize(block.on_embedder_failure);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ ...existing, memory: next }, null, 2)}\n`);
    seams.rename(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return { code: 1, text: `belay settings: could not write ${file}: ${err.message}\n`, json: { error: `could not write ${file}: ${err.message}`, key, path: file } };
  }
  const created = !(found && found.found);
  return { code: 0, text: `${key}: ${old || 'unset'} -> ${mode} (${file}${created ? ', created' : ''})\n`, json: { key, path: file, created, old, new: mode } };
}

const CONFIG_KEY = 'memory.on_embedder_failure';

module.exports = { writeSetting, readConfigMode, seams, CONFIG_KEY };
