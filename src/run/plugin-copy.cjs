'use strict';
// plugin-copy.cjs — ADR 0037 amendment 2 (the launcher copies src/mod, hashes the copy, passes it to
// --plugin-dir) and amendment 5 decision 4 (the hash covers the files present at spawn).
//
// Claude Code writes into a plugin directory it loads: `.claude-plugin/types/**` and a root
// `tsconfig.json` (wake2 VERDICTS, engine_writes_into_copy). Those two are excluded from the hash by
// name; every other file, belay-run.json included, is covered. The copy leaves out `tests/` (not part of
// the plugin's behaviour, and not loaded) and any `node_modules`.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PLUGIN_NAME = 'belay';
const RUN_FILE = 'belay-run.json';
const fwd = (p) => String(p).split('\\').join('/');

// Relative paths (forward slashes) that Claude Code adds by itself.
const isEngineFile = (rel) => rel === 'tsconfig.json' || rel === '.claude-plugin/types' || rel.startsWith('.claude-plugin/types/');
const isLeftOut = (rel) => rel === 'tests' || rel.startsWith('tests/') || rel.split('/').includes('node_modules');

function listFiles(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// sha256 over the sorted (relative path, content hash) pairs of every file but the engine's own.
function hashPlugin(dir) {
  const files = listFiles(dir).filter((r) => !isEngineFile(r)).sort();
  const h = crypto.createHash('sha256');
  const perFile = {};
  for (const r of files) {
    perFile[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex');
    h.update(r); h.update('\0');
    h.update(perFile[r]); h.update('\n');
  }
  return { hash: h.digest('hex'), files, perFile };
}

// The files that differ between a copy now and its spawn-time per-file hashes (added, removed or changed).
function changedFiles(dir, spawnPerFile) {
  const now = hashPlugin(dir).perFile;
  const names = new Set([...Object.keys(spawnPerFile || {}), ...Object.keys(now)]);
  return [...names].filter((n) => (spawnPerFile || {})[n] !== now[n]).sort();
}

// Copies the mod source to `dest` (replacing what was there), writes belay-run.json from the launcher's own
// values, and hashes the result. Returns { dir, name, hash, files }.
function installPlugin({ src, dest, run }) {
  fs.rmSync(dest, { recursive: true, force: true });
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (isEngineFile(r) || isLeftOut(r)) continue;
      if (e.isDirectory()) { fs.mkdirSync(path.join(dest, r), { recursive: true }); walk(r); }
      else if (e.isFile()) { fs.mkdirSync(path.dirname(path.join(dest, r)), { recursive: true }); fs.copyFileSync(path.join(src, r), path.join(dest, r)); }
    }
  };
  fs.mkdirSync(dest, { recursive: true });
  walk('');
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (manifest.name !== PLUGIN_NAME) throw new Error(`the mod's plugin.json names "${manifest.name}", expected "${PLUGIN_NAME}"`);
  fs.writeFileSync(path.join(dest, RUN_FILE), `${JSON.stringify(run, null, 2)}\n`);
  const { hash, files, perFile } = hashPlugin(dest);
  return { dir: fwd(dest), name: PLUGIN_NAME, hash, files: files.length, perFile };
}

const modSourceDir = () => fwd(path.join(__dirname, '..', 'mod'));

module.exports = { PLUGIN_NAME, RUN_FILE, installPlugin, hashPlugin, changedFiles, modSourceDir, isEngineFile };
