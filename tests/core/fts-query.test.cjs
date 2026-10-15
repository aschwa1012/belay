'use strict';
// fts-query.test.cjs — the MATCH builder (ADR 0040 §2): quoting, the three-character floor, and a probe
// against a real fts5 trigram table so the expression is proven to parse, not only to look right.

const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { core } = require('./helpers.cjs');

const { toMatch, MIN_TERM, BM25 } = core('fts-query.cjs');

test('toMatch quotes every term and joins them with OR', () => {
  assert.strictEqual(MIN_TERM, 3);
  assert.deepStrictEqual(toMatch('pidAlive check'), { match: '"pidAlive" OR "check"' });
  assert.deepStrictEqual(toMatch('  spaced\t\nout  '), { match: '"spaced" OR "out"' });
  assert.deepStrictEqual(toMatch('dup dup'), { match: '"dup"' });
});

test('toMatch drops terms under three characters and fails by name when none remain', () => {
  assert.deepStrictEqual(toMatch('an ab pidAlive'), { match: '"pidAlive"' });
  assert.deepStrictEqual(toMatch('ab'), { error: 'E_QUERY_SHORT' });
  assert.deepStrictEqual(toMatch('a b c'), { error: 'E_QUERY_SHORT' });
  assert.deepStrictEqual(toMatch(''), { error: 'E_QUERY_SHORT' });
  assert.deepStrictEqual(toMatch('   '), { error: 'E_QUERY_SHORT' });
  assert.deepStrictEqual(toMatch(null), { error: 'E_QUERY_SHORT' });
  assert.deepStrictEqual(toMatch(42), { error: 'E_QUERY_SHORT' });
  // Length is in characters, not UTF-16 units: an astral character is one.
  assert.deepStrictEqual(toMatch('\u{1F600}\u{1F600}'), { error: 'E_QUERY_SHORT' });
  assert.deepStrictEqual(toMatch('\u{1F600}\u{1F600}\u{1F600}'), { match: '"\u{1F600}\u{1F600}\u{1F600}"' });
});

test('toMatch keeps FTS syntax characters inside quoted phrases and never emits a bare operator', () => {
  for (const q of ['foo*', 'col:val', '^start', '(a OR b)', '-neg', 'x" OR "y', 'NEAR(abc def)', 'AND', 'a"b"c']) {
    const r = toMatch(q);
    if (r.error) continue;
    // After removing each quoted phrase nothing but spaces may remain.
    assert.strictEqual(r.match.replace(/"[^"]*"/g, '').replace(/ OR /g, '').trim(), '', `${q} -> ${r.match}`);
  }
  assert.deepStrictEqual(toMatch('x" ORR "y'), { match: '"ORR"' });
  assert.deepStrictEqual(toMatch('foo* bar:baz'), { match: '"foo*" OR "bar:baz"' });
});

test('toMatch caps the number of terms', () => {
  const q = Array.from({ length: 100 }, (_, i) => `term${i}`).join(' ');
  assert.strictEqual(toMatch(q).match.split(' OR ').length, 32);
});

test('probe: the expression runs against a real fts5 trigram table and syntax characters cannot inject', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE e(id INTEGER PRIMARY KEY, title TEXT, text TEXT);
    CREATE VIRTUAL TABLE f USING fts5(title, text, content='e', content_rowid='id', tokenize='trigram');`);
  const rows = [
    [1, 'liveness', 'the pidAlive check returns false for NO_EMBEDDER cases'],
    [2, 'syntax', 'a:b (c) -d "quoted" star* ^caret'],
    [3, 'other', 'nothing relevant here'],
  ];
  const ins = db.prepare('INSERT INTO e VALUES (?,?,?)');
  for (const r of rows) ins.run(...r);
  db.exec("INSERT INTO f(f) VALUES('rebuild')");
  const find = q => {
    const m = toMatch(q);
    assert.ok(m.match, q);
    return db.prepare('SELECT rowid FROM f WHERE f MATCH ? ORDER BY rowid').all(m.match).map(r => r.rowid);
  };
  assert.deepStrictEqual(find('pidAlive'), [1]);
  assert.deepStrictEqual(find('NO_EMB'), [1]);
  assert.deepStrictEqual(find('pidAlive NO_EMB'), [1]);
  // OR: a row holding only some of the terms matches.
  assert.deepStrictEqual(find('pidAlive relevant'), [1, 3]);
  assert.deepStrictEqual(find('pidAlive nonexistentterm'), [1]);
  for (const q of ['star*', 'a:b', '(c) -d', '^caret', 'x" OR "y', 'NEAR(abc def)', 'title:syntax', 'foo OR liveness', '"unbalanced', '()', '***', '-----']) {
    assert.doesNotThrow(() => (toMatch(q).match ? find(q) : null), q);
  }
  // A column filter or OR in the query is text, not syntax: it does not select a column.
  assert.deepStrictEqual(find('title:syntax'), []);
  assert.deepStrictEqual(find('nothing OR liveness'), [1, 3]);
  // The two-character query the ADR cites returns an empty result from the index; toMatch refuses it instead.
  assert.deepStrictEqual(db.prepare('SELECT rowid FROM f WHERE f MATCH ?').all('"ab"'), []);
  assert.deepStrictEqual(toMatch('ab'), { error: 'E_QUERY_SHORT' });
  db.close();
});

test('toMatch splits on control characters so a NUL never reaches the phrase', () => {
  assert.deepStrictEqual(toMatch('\u0000\u0000\u0000'), { error: 'E_QUERY_SHORT' });
  assert.deepStrictEqual(toMatch('abc\u0000def\u0001ghi'), { match: '"abc" OR "def" OR "ghi"' });
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(c, tokenize='trigram')");
  db.prepare('INSERT INTO t(c) VALUES (?)').run('abcdef ghi');
  for (const q of ['\u0000\u0000\u0000 abc', 'abc\u0000def', '\u001fabcdef\u001f']) {
    const r = toMatch(q);
    if (!r.match) continue;
    assert.doesNotThrow(() => db.prepare('SELECT c FROM t WHERE t MATCH ?').all(r.match), q);
  }
});

test('rows holding more of the rarer terms rank higher, and a title hit outranks a body hit', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE memory_entries(id INTEGER PRIMARY KEY, title TEXT, text TEXT);
    CREATE VIRTUAL TABLE memory_fts USING fts5(title, text, content='memory_entries', content_rowid='id', tokenize='trigram');`);
  const ins = db.prepare('INSERT INTO memory_entries VALUES (?,?,?)');
  ins.run(1, 'note', 'the sandbox directory holds the store for the run');
  ins.run(2, 'note', 'the sandbox directory holds the store and CRLF endings corrupt the checksum');
  ins.run(3, 'note', 'the store is read by the harness');
  ins.run(4, 'checksum', 'unrelated body text about nothing');
  ins.run(5, 'note', 'a checksum is computed over the bytes and nothing else');
  for (let i = 6; i < 40; i++) ins.run(i, 'filler', 'the store of the run and the harness directory');
  db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  const rank = q => db.prepare(`SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? ORDER BY ${BM25}, rowid`).all(toMatch(q).match).map(r => r.rowid);
  // A natural query no row contains in full still finds rows; the row with the rare terms (CRLF, checksum) leads.
  const r = rank('how do CRLF endings corrupt the checksum of the store');
  assert.strictEqual(r[0], 2);
  assert.ok(r.includes(1) && r.includes(5), 'rows holding only some terms match');
  // Title weight: row 4 names the rare term in its title, row 5 only in its body.
  assert.ok(rank('checksum').indexOf(4) < rank('checksum').indexOf(5));
  db.close();
});
