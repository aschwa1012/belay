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
  // `every` as a number runs the writer on that many attempts and then stops, the way an owner's heartbeat stops.
  const fire = () => { if (!armed) return; if (!every) armed = false; fired++; if (typeof every === 'number' && fired >= every) armed = false; writer(); };
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

test('a writer that changes the store on every attempt until the retry budget ends gives E_BUSY and leaves no copy behind', async () => {
  const st = makeStore();
  const budget = hooks.budgetMs; hooks.budgetMs = 150;
  try {
    const t0 = Date.now();
    const r = await read(st, { file: 'db', chunk: 1 }, () => { bump(st, st.d); st.d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }, true);
    const ms = Date.now() - t0;
    assert.equal(r.value, undefined);
    assert.equal(r.error.code, 'E_BUSY');
    assert.equal(r.error.detail.reason, 'copy-changed');
    assert.match(r.error.message, /changed during each of \d+ copies/);
    assert.ok(r.copies >= 3, 'at least three copies were tried: ' + r.copies);
    assert.equal(r.error.detail.attempts, r.copies);
    assert.equal(r.fired, r.copies);
    assert.ok(ms < 150 + 10000, 'the retries end soon after the budget: ' + ms + ' ms');
  } finally { hooks.budgetMs = budget; done(st); }
});

// A live owner heartbeats every second and checkpoints on a timer, and each changes the stamp. A copy
// that spans one is discarded; three tries a few ms apart can all land inside one slow stretch on a loaded
// host. The retries run on a time budget, so a writer that stops is waited out and the read answers.
test('a writer that changes the store on the first copies and then stops is waited out, never E_BUSY', async () => {
  const st = makeStore();
  try {
    const r = await read(st, { file: 'db', chunk: 1 }, () => { bump(st, st.d); st.d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }, 5);
    assert.equal(r.fired, 5);
    assert.equal(r.value, last(st), r.error && r.error.message);
    assert.equal(r.copies, 6, 'five copies were discarded, the sixth was quiet');
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

// F1: a write inside one mtime tick leaves the same size and mtime. The test pins the mtime of the database
// and its sidecars to a fixed instant before the copy and again after the writer, which is what a same-tick
// write looks like to a stat.
const pin = (st, t) => { for (const suf of ['', '-wal', '-shm']) { try { fs.utimesSync(st.p + suf, t, t); } catch { /* absent or mapped */ } } };
const sizes = st => ['', '-wal'].map(s => { try { return fs.statSync(st.p + s).size; } catch { return -1; } }).join(',');

test('a WAL restart and an in-place checkpoint that keep every size and mtime are still retried', async () => {
  const st = makeStore();
  try {
    st.d.exec('PRAGMA wal_checkpoint(PASSIVE)'); // the database is current and the WAL is full-size and backfilled
    const t = new Date(Date.now() - 60000); pin(st, t);
    const probe = 'SELECT gen FROM t WHERE id IN (0, 1500, 3999) ORDER BY id';
    const w = withWriterAt({ file: 'db', chunk: 1 }, () => {
      const one = st.d.prepare('UPDATE t SET gen=? WHERE id=?');
      const before = sizes(st);
      st.d.exec('BEGIN'); one.run(101, 0); one.run(101, 3999); st.d.exec('COMMIT');
      st.d.exec('PRAGMA wal_checkpoint(PASSIVE)');
      st.d.exec('BEGIN'); one.run(102, 1500); st.d.exec('COMMIT'); // restarts the WAL again
      pin(st, t);
      assert.equal(sizes(st), before, 'the writer kept every size');
    });
    const copies = []; const inner = hooks.copy; hooks.copy = (src, dst) => { inner(src, dst); if (src === st.p) copies.push(src); };
    let got;
    try {
      got = await withCopy(st.dir, async dbPath => { const c = new DatabaseSync(dbPath); try { return JSON.stringify(c.prepare(probe).all().map(r => r.gen)); } finally { c.close(); } });
    } finally { w.restore(); }
    assert.equal(w.fired(), 1);
    assert.equal(copies.length, 2, 'the copy was taken again');
    assert.equal(got, JSON.stringify(st.d.prepare(probe).all().map(r => r.gen)));
  } finally { done(st); }
});

test('with no WAL the copy waits out the mtime tick after the last write, and a same-tick write is retried', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-copy-tick-'));
  const p = path.join(dir, 'memory.db');
  const d = new DatabaseSync(p);
  try {
    d.exec('PRAGMA journal_mode=DELETE; CREATE TABLE t(id INTEGER PRIMARY KEY, gen INTEGER, payload BLOB)');
    d.exec('BEGIN'); const ins = d.prepare('INSERT INTO t VALUES(?,?,?)');
    for (let i = 0; i < 3; i++) ins.run(i, 0, Buffer.alloc(1 << 20, 7));
    d.exec('COMMIT');
    assert.equal(fs.existsSync(p + '-wal'), false);
    const opened = [];
    const w = withWriterAt({ file: 'db', chunk: 1 }, () => d.exec('UPDATE t SET gen=gen+1'));
    const inner = hooks.copy; hooks.copy = (src, dst) => { inner(src, dst); if (src === p) opened.push(Date.now() - fs.statSync(p).mtimeMs); };
    let gens;
    try {
      gens = await withCopy(dir, async dbPath => { const c = new DatabaseSync(dbPath); try { return c.prepare('SELECT DISTINCT gen FROM t').all().map(r => r.gen).join(','); } finally { c.close(); } });
    } finally { w.restore(); }
    assert.ok(opened[0] >= 19, `the first attempt began ${opened[0]} ms after the last write`);
    assert.equal(opened.length, 2, 'the in-place write during the copy forced a second copy');
    assert.equal(gens, '1');
  } finally { try { d.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); }
});

test('with no WAL a write between the window wait and the stamp does not hide a second same-tick write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-copy-tick2-'));
  const p = path.join(dir, 'memory.db');
  const d = new DatabaseSync(p);
  const origStat = fs.statSync;
  const TICK = 20;
  try {
    d.exec('PRAGMA journal_mode=DELETE; CREATE TABLE t(id INTEGER PRIMARY KEY, gen INTEGER, payload BLOB)');
    d.exec('BEGIN'); const ins = d.prepare('INSERT INTO t VALUES(?,?,?)');
    for (let i = 0; i < 3; i++) ins.run(i, 0, Buffer.alloc(1 << 20, 7));
    d.exec('COMMIT');
    d.exec('UPDATE t SET gen=gen+1'); // the first update grows the file; the writes under test keep its size
    // A write is pinned to the same mtime as the one before it only when it lands inside one tick of it, which is
    // what the filesystem would do.
    let t = null, first = true;
    const write = () => {
      d.exec('UPDATE t SET gen=gen+1');
      const now = Date.now();
      if (t === null) t = now; else if (now - t < TICK) { /* same tick */ } else t = null;
      if (t !== null) fs.utimesSync(p, new Date(t), new Date(t));
      if (t === null) t = -1e9;
    };
    // The first write lands as the copy takes its first stamp of the database, the second after the first chunk.
    fs.statSync = (q, o) => { if (first && o && o.bigint && String(q) === p) { first = false; write(); } return origStat(q, o); };
    const w = withWriterAt({ file: 'db', chunk: 1 }, write);
    let gens;
    try {
      gens = await withCopy(dir, async dbPath => { const c = new DatabaseSync(dbPath); try { return c.prepare('SELECT DISTINCT gen FROM t').all().map(r => r.gen).join(','); } finally { c.close(); } });
    } finally { w.restore(); fs.statSync = origStat; }
    assert.equal(gens, String(d.prepare('SELECT DISTINCT gen FROM t').get().gen));
    assert.equal(gens, '3');
  } finally { fs.statSync = origStat; try { d.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); }
});
