'use strict';
// schema-stamp.cjs — memory plan gate G3: the store records which schema and which build wrote it, and a
// core older than the store refuses to open it. Without this an older binary silently runs its own
// migrations over a newer layout (claude-mem's plan 21).
//
// SCHEMA_VERSION is bumped by a human, in the same change that makes a layout change an older core could
// not read correctly (a dropped or retyped column, a changed row meaning). Additive columns in MIGRATIONS
// do not need a bump: an older core ignores a column it does not select.
//
// Reading never writes (invariant 6): `checkSchema` only reads and `stampStore` is called only by the
// owner's own open for write. A read goes through a copy, and the check runs on that copy.

const fs = require('node:fs');
const path = require('node:path');
const { err } = require('./errors.cjs');

const SCHEMA_VERSION = 1;
const ROOT = path.resolve(__dirname, '..', '..');

function metaGet(db, key) {
  const t = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!t) return null;
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}

// Refuse a store whose recorded schema is newer than this core knows. Reads only; call before
// ensureSchema so a refused store is left byte-for-byte as it was. A store with no stamp predates G3 and
// is schema 1 by definition. A value that is not a positive integer is also refused: it was not written
// by any core this one can reason about.
function checkSchema(db, dbPath) {
  const raw = metaGet(db, 'schema_version');
  if (raw === null) return { schema_version: null };
  const v = Number(raw);
  const writtenBy = metaGet(db, 'written_by');
  if (!Number.isInteger(v) || v < 1) {
    throw err('E_SCHEMA_NEWER',
      `the store at ${dbPath} records schema_version ${JSON.stringify(raw)}, which is not a positive integer (written by ${writtenBy || 'unknown'}), so it was not opened and nothing was written; this is a malformed stamp, not a newer schema: delete the schema_version row from the store's meta table by hand, or restore the store from a backup`,
      { store_schema: raw, known_schema: SCHEMA_VERSION, written_by: writtenBy, db: dbPath, reason: 'malformed' });
  }
  if (v > SCHEMA_VERSION) {
    throw err('E_SCHEMA_NEWER',
      `the store at ${dbPath} records schema_version ${raw} (written by ${writtenBy || 'unknown'}) and this core knows schema ${SCHEMA_VERSION} at most, so it was not opened and nothing was written; upgrade belay`,
      { store_schema: raw, known_schema: SCHEMA_VERSION, written_by: writtenBy, db: dbPath, reason: 'newer' });
  }
  return { schema_version: v };
}

// The commit of the checkout this code runs from, read from .git files, never by spawning git. A worktree
// has `.git` as a file naming its gitdir; a ref is a loose file or a line in packed-refs. A published
// package has no .git, so package.json's `gitHead` (npm writes one) is tried, then 'unknown'. Cost: three
// to five small file reads, once per owner start; nothing on any call path.
function readCommit(root = ROOT) {
  try {
    let gitDir = path.join(root, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return 'unknown';
      gitDir = path.resolve(root, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 12);
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return 'unknown';
    const name = ref[1].trim();
    let common = gitDir;
    try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a worktree */ }
    for (const d of [gitDir, common]) {
      try { return fs.readFileSync(path.join(d, name), 'utf8').trim().slice(0, 12); } catch { /* try the next */ }
    }
    for (const line of fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split('\n')) {
      const [sha, n] = line.trim().split(' ');
      if (n === name && /^[0-9a-f]{40}$/.test(sha)) return sha.slice(0, 12);
    }
  } catch { /* not a checkout */ }
  try {
    const g = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).gitHead;
    if (typeof g === 'string' && g) return g.slice(0, 12);
  } catch { /* no package.json */ }
  return 'unknown';
}

let cached;
function writtenBy() {
  if (cached) return cached;
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || 'unknown'; } catch { /* keep unknown */ }
  cached = `belay@${version}+${readCommit()}`;
  return cached;
}

// The stamp, one transaction: written_by names the build that last opened the store for write;
// schema_version only ever rises (a store already at this version or a legacy one becomes this version).
function stampStore(db, by = writtenBy()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const put = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
    put.run('schema_version', String(SCHEMA_VERSION));
    put.run('written_by', by);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already out */ } throw e; }
  return { schema_version: SCHEMA_VERSION, written_by: by };
}

module.exports = { SCHEMA_VERSION, checkSchema, stampStore, writtenBy, readCommit, metaGet };
