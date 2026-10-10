'use strict';
// memory-rows.test.cjs — the pure row helpers of ADR 0040 §2, and filterSql against an in-memory DB.

const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { core } = require('./helpers.cjs');

const m = core('memory-rows.cjs');

test('deriveTitle takes the first non-empty line, collapsed, within 160 bytes', () => {
  assert.strictEqual(m.deriveTitle('\n  \n  Fixed   the\tlease  race \nsecond line'), 'Fixed the lease race');
  assert.strictEqual(m.deriveTitle(''), '');
  assert.strictEqual(m.deriveTitle(null), '');
  assert.strictEqual(Buffer.byteLength(m.deriveTitle('x'.repeat(500))), 160);
  const wide = m.deriveTitle('é'.repeat(200)); // two bytes each: cut on a character edge
  assert.strictEqual(wide, 'é'.repeat(80));
  assert.ok(!m.deriveTitle('😀'.repeat(100)).includes('�'));
});

test('indexRowOf keeps ids and titles only and defaults status and title', () => {
  const row = { id: 'm1', type: 'fact', text: 'Body line\nmore', tags: ['t'], namespace: 'ns', worker_id: 'w1', created_at: 5, status: null, task_id: 'T-1', embedding: Buffer.from([1]) };
  assert.deepStrictEqual(m.indexRowOf(row, 0.8), {
    id: 'm1', type: 'fact', status: 'unverified', score: 0.8, title: 'Body line', created_at: 5, namespace: 'ns', worker_id: 'w1', task_id: 'T-1',
  });
  const own = m.indexRowOf({ ...row, title: 'Own', status: 'verified', task_id: undefined });
  assert.strictEqual(own.title, 'Own');
  assert.strictEqual(own.status, 'verified');
  assert.strictEqual(own.score, null);
  assert.strictEqual(own.task_id, null);
  assert.ok(!('text' in own) && !('tags' in own));
});

test('parseReceipt accepts each kind', () => {
  assert.deepStrictEqual(m.parseReceipt('checkpoint:cp-12'), { kind: 'checkpoint', ref: 'cp-12' });
  assert.deepStrictEqual(m.parseReceipt('task:T-3'), { kind: 'task', ref: 'T-3' });
  assert.deepStrictEqual(m.parseReceipt('memory:abc123'), { kind: 'memory', ref: 'abc123' });
  assert.deepStrictEqual(m.parseReceipt('commit:abcdef1'), { kind: 'commit', ref: 'abcdef1' });
  assert.deepStrictEqual(m.parseReceipt('commit:' + 'A'.repeat(40)), { kind: 'commit', ref: 'A'.repeat(40) });
  assert.deepStrictEqual(m.parseReceipt('test:node --test tests/x.cjs: 12 pass'), { kind: 'test', ref: 'node --test tests/x.cjs: 12 pass' });
});

test('parseReceipt refuses every malformed form with a reason', () => {
  for (const s of [undefined, null, 5, '', 'nocolon', ':x', 'task:', 'task: ', 'task:has space', 'memory:' + 'a'.repeat(129),
    'commit:abc123', 'commit:' + 'a'.repeat(41), 'commit:xyzxyzxyz', 'test:', 'test:   ', 'test:' + 'x'.repeat(201), 'review:abc', 'Task:T-1']) {
    const r = m.parseReceipt(s);
    assert.ok(typeof r.error === 'string' && r.error, `expected an error for ${JSON.stringify(s)}`);
    assert.ok(!('kind' in r));
  }
  assert.strictEqual(m.parseReceipt('test:' + 'x'.repeat(200)).kind, 'test');
});

test('rareTokens picks identifiers, numbers, paths and codes, case-sensitively', () => {
  const t = m.rareTokens('The pidAlive check in src/core/store.cjs failed with E_NO_OWNER after 2026 ms; see the lease. EPERM too, a_b no.');
  for (const x of ['pidAlive', 'src/core/store.cjs', 'E_NO_OWNER', '2026', 'EPERM']) assert.ok(t.has(x), x);
  for (const x of ['The', 'check', 'lease', 'ab_c', 'too', 'ms']) assert.ok(!t.has(x), x);
  assert.strictEqual(m.rareTokens('pidalive').size, 0);
  assert.ok(m.rareTokens('PidAlive').has('PidAlive'));
  assert.strictEqual(m.rareTokens(null).size, 0);
});

test('dupVeto distinguishes E_NO_OWNER from E_OWNER_LOST and passes the same fact', () => {
  assert.strictEqual(m.dupVeto('The call rejects with E_NO_OWNER when none is elected', 'The call rejects with E_NO_OWNER when none is elected.'), null);
  const v = m.dupVeto('rejects with E_NO_OWNER when none is elected', 'rejects with E_OWNER_LOST when none is elected');
  assert.deepStrictEqual(v, { only_in_query: ['E_NO_OWNER'], only_in_row: ['E_OWNER_LOST'] });
  assert.deepStrictEqual(m.dupVeto({ text: 'see store.cjs' }, 'see store.cjs and 4096'), { only_in_query: [], only_in_row: ['4096'] });
  assert.strictEqual(m.dupVeto('plain words only here', 'other plain words'), null);
});

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE memory_entries (id TEXT PRIMARY KEY, type TEXT, status TEXT, worker_id TEXT, task_id TEXT, run_id TEXT, tags TEXT, created_at INTEGER)');
  const ins = d.prepare('INSERT INTO memory_entries VALUES (?,?,?,?,?,?,?,?)');
  ins.run('a', 'fact', null, 'w1', 'T-1', 'r1', null, 100);
  ins.run('b', 'observation', 'verified', 'w2', null, 'r1', '["T-2","w2"]', 200);
  ins.run('c', 'summary', 'refuted', 'w1', null, 'r2', 'not json', 300);
  ins.run('d', 'fact', 'unverified', 'w3', 'T-2', 'r2', '["T-1"]', 400);
  return d;
}
const ids = (d, filter, alias = 'm') => {
  const { where, params } = m.filterSql(filter, alias);
  const sql = `SELECT ${alias}.id FROM memory_entries ${alias}${where ? ' WHERE ' + where : ''} ORDER BY ${alias}.created_at`;
  return d.prepare(sql).all(...params).map(r => r.id);
};

test('filterSql runs against an in-memory DB', () => {
  const d = db();
  assert.deepStrictEqual(m.filterSql({}, 'm'), { where: '', params: [] });
  assert.deepStrictEqual(m.filterSql(undefined), { where: '', params: [] });
  assert.deepStrictEqual(ids(d, {}), ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(ids(d, { types: ['fact'] }), ['a', 'd']);
  assert.deepStrictEqual(ids(d, { types: ['fact', 'summary'] }), ['a', 'c', 'd']);
  assert.deepStrictEqual(ids(d, { statuses: ['unverified'] }), ['a', 'd']); // null reads as unverified
  assert.deepStrictEqual(ids(d, { statuses: ['verified', 'refuted'] }), ['b', 'c']);
  assert.deepStrictEqual(ids(d, { worker_id: 'w1' }), ['a', 'c']);
  assert.deepStrictEqual(ids(d, { run_id: 'r2' }), ['c', 'd']);
  assert.deepStrictEqual(ids(d, { task_id: 'T-1' }), ['a']); // d's tag is ignored: its column is set
  assert.deepStrictEqual(ids(d, { task_id: 'T-2' }), ['b', 'd']); // b by tag (column null), d by column
  assert.deepStrictEqual(ids(d, { since_ms: 200, until_ms: 300 }), ['b', 'c']);
  assert.deepStrictEqual(ids(d, { types: ['fact'], worker_id: 'w3', since_ms: 400 }), ['d']);
  assert.deepStrictEqual(ids(d, { types: ['nothing'] }), []);
  assert.deepStrictEqual(ids(d, { task_id: 'x\' OR \'1\'=\'1' }), []); // parameters, never interpolated
  d.close();
});

test('filterSql works with no alias', () => {
  const d = db();
  const { where, params } = m.filterSql({ statuses: ['refuted'], worker_id: 'w1' });
  assert.deepStrictEqual(d.prepare(`SELECT id FROM memory_entries WHERE ${where}`).all(...params).map(r => r.id), ['c']);
  d.close();
});

test('filterSql refuses what it cannot honour instead of widening', () => {
  for (const f of [{ nope: 1 }, { types: [] }, { types: 'fact' }, { types: [1] }, { statuses: ['done'] }, { worker_id: '' },
    { run_id: 5 }, { since_ms: -1 }, { until_ms: 'x' }, { since_ms: NaN }, [], 'str']) {
    assert.throws(() => m.filterSql(f, 'm'), e => e.code === 'E_ARGS', JSON.stringify(f));
  }
  assert.throws(() => m.filterSql({}, 'm; DROP TABLE x'), e => e.code === 'E_ARGS');
});

test('STATUSES and SOURCES are the ADR 0040 values', () => {
  assert.deepStrictEqual([...m.STATUSES], ['unverified', 'verified', 'refuted']);
  assert.deepStrictEqual([...m.SOURCES], ['model', 'harness', 'operator', 'summariser']);
});
