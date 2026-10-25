'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// A read's copy of the store is a snapshot only if nothing wrote while it was taken. A writer that truncates
// or restarts the WAL, or closes the last connection, moves pages into the database file between two chunks
// and leaves a copy of old and new pages that opens, queries and answers wrongly. The copy compares the size
// and mtime of the database and its sidecars before and after, and takes the copy again on any change.
// The writer here is a real SQLite connection, run from inside the copy by the `hooks.copy` seam (a source
// file just opened) or a stalled `readSync` chunk: deterministic, no load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { withCopy, hooks } = require(path.join(__dirname, '..', '..', 'src', 'core', 'copy-read.cjs'));

const ROWS = 4000, SPLIT = 2000;
const pay = g => (String(g).padStart(6, '0') + 'x').repeat(86).slice(0, 600);

// A store of about 2.5 MB whose database file holds generation 1 and whose WAL holds generation 2.
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-copy-tear-'));
  const p = path.join(dir, 'memory.db');
  const d = new DatabaseSync(p);
  d.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(id INTEGER PRIMARY KEY, gen INTEGER, payload TEXT); CREATE INDEX t_pay ON t(payload)');
  const st = { dir, p, d, gen: 0, history: ['0,0'] };
  st.ins = d.prepare('INSERT INTO t VALUES(?,?,?)');
  d.exec('BEGIN'); for (let i = 0; i < ROWS; i++) st.ins.run(i, 0, pay(0)); d.exec('COMMIT');
  bump(st, d); d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); bump(st, d);
  return st;
}
// Full: every row to a new generation. Partial: only the first SPLIT rows, so most pages are not rewritten.
function bump(st, d, partial) {
  st.gen++;
  d.exec('BEGIN IMMEDIATE');
  d.prepare('UPDATE t SET gen=?, payload=? WHERE id<?').run(st.gen, pay(st.gen), partial ? SPLIT : ROWS);
  d.exec('COMMIT');
  const hi = st.history[st.history.length - 1].split(',')[1];
  st.history.push(partial ? `${st.gen},${hi}` : `${st.gen},${st.gen}`);
}
// The state the copy shows as 'low,high' generations, or throws if it is not one uniform state per half.
function stateOf(dbPath) {
  const d = new DatabaseSync(dbPath);
  try {
    d.exec('PRAGMA journal_mode=WAL');
    const g = d.prepare('SELECT id>=? h, gen, count(*) c FROM t NOT INDEXED GROUP BY h, gen').all(SPLIT);
    assert.equal(g.length, 2, 'one generation per half: ' + JSON.stringify(g));
    assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    return g.map(r => r.gen).join(',');
  } finally { d.close(); }
}

// Run `writer` once, at the point `at` of the copy's first attempt: {file:'db', chunk:n} after n chunks of
// the database file, {open:'wal'} when the WAL has just been opened. `every` runs it on every attempt.
function withWriterAt(at, writer, every = false) {
  const origRead = fs.readSync, origOpen = fs.openSync, paths = new Map();
  const kind = p => p.endsWith('-wal') ? 'wal' : p.endsWith('-shm') ? 'shm' : 'db';
  let chunks = 0, fired = 0, armed = true;
  const fire = () => { if (!armed) return; if (!every) armed = false; fired++; writer(); };
  fs.openSync = (p, ...a) => { const fd = origOpen(p, ...a); paths.set(fd, String(p)); return fd; };
  fs.readSync = (fd, ...a) => {
    const n = origRead(fd, ...a);
    if (at.file && n > 0 && kind(paths.get(fd) || '') === at.file && ++chunks === at.chunk) fire();
    return n;
  };
  hooks.copy = src => { if (at.open === kind(src)) fire(); if (every && at.file) chunks = 0; };
  return { restore() { fs.readSync = origRead; fs.openSync = origOpen; hooks.copy = null; }, fired: () => fired };
}

async function read(st, at, writer, every) {
  const w = withWriterAt(at, writer, every);
  const copies = [];
  const prev = hooks.copy; hooks.copy = (src, dst) => { prev(src, dst); if (!src.endsWith('-wal') && !src.endsWith('-shm')) copies.push(src); };
  try {
    const value = await withCopy(st.dir, async dbPath => stateOf(dbPath));
    return { value, fired: w.fired(), copies: copies.length };
  } catch (e) { return { error: e, fired: w.fired(), copies: copies.length }; }
  finally { w.restore(); }
}
const done = st => { try { st.d.close(); } catch { /* closed */ } fs.rmSync(st.dir, { recursive: true, force: true }); };
const last = st => st.history[st.history.length - 1];

for (const at of [{ file: 'db', chunk: 1 }, { file: 'db', chunk: 2 }, { open: 'wal' }]) {
  test(`a TRUNCATE checkpoint during the copy (${JSON.stringify(at)}) is retried, never read torn`, async () => {
    const st = makeStore();
    try {
      const r = await read(st, at, () => { bump(st, st.d); st.d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); });
      assert.equal(r.fired, 1);
      assert.equal(r.value, last(st), r.error && r.error.message);
      assert.equal(r.copies, 2, 'the copy was taken again');
    } finally { done(st); }
  });
}

test('a RESTART checkpoint then a partial update during the copy is retried, never read torn', async () => {
  const st = makeStore();
  try {
    const r = await read(st, { file: 'db', chunk: 1 }, () => { st.d.exec('PRAGMA wal_checkpoint(RESTART)'); bump(st, st.d, true); });
    assert.equal(r.value, last(st), r.error && r.error.message);
    assert.equal(r.copies, 2);
  } finally { done(st); }
});

test('a TRUNCATE then a partial update during the copy is retried, never read torn', async () => {
  const st = makeStore();
  try {
    const r = await read(st, { open: 'wal' }, () => { st.d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); bump(st, st.d, true); });
    assert.equal(r.value, last(st), r.error && r.error.message);
  } finally { done(st); }
});

test('an owner elected during the copy that writes and closes (WAL deleted) is retried, never read torn', async () => {
  const st = makeStore();
  st.d.close(); // no owner at the reader's ask: a clean database
  try {
    const r = await read(st, { file: 'db', chunk: 2 }, () => {
      const n = new DatabaseSync(st.p); n.exec('PRAGMA wal_autocheckpoint=0');
      bump(st, n); n.close();
    });
    assert.equal(r.value, last(st), r.error && r.error.message);
    assert.equal(r.copies, 2);
  } finally { done(st); }
});

test('a writer that changes the store on every attempt gives E_BUSY and leaves no copy behind', async () => {
  const st = makeStore();
  try {
    const r = await read(st, { file: 'db', chunk: 1 }, () => { bump(st, st.d); st.d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }, true);
    assert.equal(r.value, undefined);
    assert.equal(r.error.code, 'E_BUSY');
    assert.match(r.error.message, /changed during each of 3 copies/);
    assert.equal(r.copies, 3);
    assert.equal(r.fired, 3);
  } finally { done(st); }
});

test('a store nothing writes to is copied once', async () => {
  const st = makeStore();
  try {
    const r = await read(st, { open: 'never' }, () => assert.fail('no writer'));
    assert.equal(r.value, last(st));
    assert.equal(r.copies, 1);
  } finally { done(st); }
});
