'use strict';
// drive-tmp.cjs — the drive-root tmp folder (C:\tmp on Windows) listed at run start and again at run end, so the run receipt
// can name what appeared there while the run was going. A record, never a gate: nothing is stopped, refused, deleted or
// written to the store, and an absent or unreadable folder gives `scanned: false` with the reason. The scan is bounded: the top
// level and the children of each top-level folder, at most `cap` entries; past that it stops and says `truncated`.

const fs = require('node:fs');
const path = require('node:path');

const CAP = 2000; // entries read at each scan
const LISTED = 50; // new or changed entries named in the receipt; the count is always whole

// The folder to scan. A test names a sandbox with BELAY_DRIVE_TMP_DIR (honoured only in test mode); otherwise Windows' system
// drive root + tmp, and null elsewhere (the folder is a Windows drive-root hazard).
function folder(env = process.env) {
  if (env.BELAY_TEST_MODE === '1' && env.BELAY_DRIVE_TMP_DIR) return String(env.BELAY_DRIVE_TMP_DIR).replace(/\\/g, '/');
  if (process.platform !== 'win32') return null;
  return `${String(env.SystemDrive || 'C:').replace(/[\\/]+$/, '')}/tmp`;
}

// The entry cap; a test lowers it with BELAY_DRIVE_TMP_CAP (test mode only).
function cap(env = process.env) {
  const n = Number(env.BELAY_DRIVE_TMP_CAP);
  return env.BELAY_TEST_MODE === '1' && Number.isInteger(n) && n > 0 ? n : CAP;
}

// The names in one folder, read through a handle so the read itself stops: at most `max` of them, and `more` says whether another existed.
function readNames(full, max) {
  const d = fs.opendirSync(full);
  const list = [];
  let more = false;
  try {
    for (;;) {
      const e = d.readSync();
      if (!e) break;
      if (list.length >= max) { more = true; break; }
      list.push(e);
    }
  } finally { try { d.closeSync(); } catch { /* already closed */ } }
  return { list, more };
}

// { dir, scanned, reason?, truncated, entries: Map(rel -> {size, mtime_ms, dir, link?}) }. A link (symlink or junction) is listed
// by lstat and never followed or descended into.
function snapshot(dir, limit = cap()) {
  const snap = { dir, scanned: false, truncated: false, entries: new Map() };
  if (!dir) { snap.reason = 'no drive-root tmp folder on this platform'; return snap; }
  try {
    const top = readNames(dir, limit);
    snap.scanned = true;
    if (top.more) snap.truncated = true;
    const add = (rel, full, isDir) => {
      try {
        const st = fs.lstatSync(full);
        const link = st.isSymbolicLink();
        snap.entries.set(rel, { size: st.size, mtime_ms: Math.round(st.mtimeMs), dir: isDir && !link, ...(link ? { link: true } : {}) });
      } catch { /* gone between the listing and the stat */ }
    };
    for (const e of top.list) add(e.name, path.join(dir, e.name), e.isDirectory());
    for (const e of top.list) {
      if (!e.isDirectory()) continue;
      const room = limit - snap.entries.size;
      let kids;
      try { kids = readNames(path.join(dir, e.name), Math.max(room, 0)); } catch { continue; }
      for (const k of kids.list) add(`${e.name}/${k.name}`, path.join(dir, e.name, k.name), k.isDirectory());
      if (kids.more) { snap.truncated = true; break; }
    }
  } catch (e) {
    snap.scanned = false;
    snap.reason = e && e.code === 'ENOENT' ? 'the folder does not exist' : `unreadable: ${(e && e.code) || (e && e.message) || e}`;
    snap.entries = new Map();
  }
  return snap;
}

// The receipt block: what is new or changed in `after` against `before`. Never throws.
function receiptBlock(before, after) {
  const base = { dir: (after && after.dir) || (before && before.dir) || null };
  if (!before || !before.scanned) return { drive_tmp: { ...base, scanned: false, reason: (before && before.reason) || 'not scanned at run start', truncated: false } };
  if (!after || !after.scanned) return { drive_tmp: { ...base, scanned: false, reason: (after && after.reason) || 'not scanned at run end', truncated: false } };
  const found = [];
  for (const [rel, now] of after.entries) {
    const was = before.entries.get(rel);
    if (!was) found.push({ path: rel, change: 'new', size: now.size, mtime_ms: now.mtime_ms, dir: now.dir });
    else if (was.size !== now.size || was.mtime_ms !== now.mtime_ms) found.push({ path: rel, change: 'changed', size: now.size, mtime_ms: now.mtime_ms, dir: now.dir });
  }
  return { drive_tmp: {
    ...base, scanned: true, truncated: before.truncated || after.truncated, entries_at_start: before.entries.size, entries_at_end: after.entries.size,
    new_or_changed_count: found.length, new_or_changed: found.slice(0, LISTED), listed_truncated: found.length > LISTED,
  } };
}

function lines(receipt) {
  const d = receipt && receipt.drive_tmp;
  if (!d || !d.scanned || !(d.new_or_changed_count || d.truncated)) return [];
  return [`drive tmp ${d.dir}: ${d.new_or_changed_count} new or changed during the run${d.truncated ? ' (scan truncated)' : ''}; see the receipt`];
}

module.exports = { folder, cap, snapshot, receiptBlock, lines, CAP, LISTED };
