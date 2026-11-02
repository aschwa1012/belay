'use strict';
// store-invariants-fixture.cjs — builds a real-schema store from a JSON fixture (tests/fixtures/store-invariants/).
// A fixture is { rows: {table: [row]} } (clean.json) or { rule, base: 'clean', append: {table: [row]}, corrupt? } (planted/*.json).
// Rows are inserted in order, so seq follows the array order. Missing written_at / written_by default to 1000 / 'operator'.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ensureSchema } = require('../../src/core/schema.cjs');

const DIR = path.join(__dirname, '..', 'fixtures', 'store-invariants');
const NEEDS_STAMP = new Set(['run', 'worker', 'task', 'lease']);

function load(name) { return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8')); }

function merged(fx) {
  if (fx.rows) return JSON.parse(JSON.stringify(fx.rows));
  const rows = merged(load(fx.base));
  for (const [t, rs] of Object.entries(fx.append || {})) rows[t] = (rows[t] || []).concat(rs);
  return rows;
}

// -> { dbPath, db (open only when keepOpen), close() }
function materialize(fx, dir, { wal = false, keepOpen = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  ensureSchema(db);
  for (const [table, rows] of Object.entries(merged(fx))) {
    for (const r of rows) {
      const row = NEEDS_STAMP.has(table) ? { written_at: 1000, written_by: 'operator', ...r } : r;
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    }
  }
  // padding so a corruption has a page to hit
  if (fx.corrupt) for (let i = 0; i < 300; i++) db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run('pad' + i, 'x'.repeat(200));
  if (!keepOpen) db.close();
  if (fx.corrupt) {
    const fd = fs.openSync(dbPath, 'r+');
    const size = fs.fstatSync(fd).size;
    const pg = 4096;
    for (const page of [Math.floor(size / pg) - 1, Math.floor(size / pg) - 2]) {
      if (page > 1) fs.writeSync(fd, Buffer.alloc(pg, 0xff), 0, pg, page * pg);
    }
    fs.closeSync(fd);
  }
  return { dbPath, db: keepOpen ? db : null, close() { try { if (db.isOpen) db.close(); } catch { /* closed */ } } };
}

module.exports = { load, materialize, DIR };
