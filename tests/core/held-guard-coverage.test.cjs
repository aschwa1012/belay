'use strict';
// held-guard-coverage.test.cjs — every write of a note's visibility or status goes through a guarded store method. This scans src/core for a raw
// UPDATE or DELETE of memory_entries outside store.cjs, by whole SQL statement (case and whitespace normalised, so a multiline or lowercase write is
// found): the only ones allowed are the archive purge (archive rows only, operator only) and the retitle of a pending note (pending rows are never
// held). A new raw write fails here until it goes through the store or is listed with its reason.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..', '..', 'src', 'core');
const ALLOWED = [
  { file: 'methods-memory-archive.cjs', re: /^delete from memory_entries where id = \?$/, why: 'archive purge: archive/ rows only, operator only, never a held note' },
  { file: 'methods-memory-notes.cjs', re: /^update memory_entries set title = \?, text = \?, text_hash = \?/, why: 'retitle of a pending note: a pending note is never held' },
];
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// Every raw write statement of memory_entries in `text`: from the UPDATE/DELETE keyword to the quote that closes its string. Returns [{ line, sql }].
function rawWrites(text) {
  const out = [];
  const re = /(update\s+memory_entries\b|delete\s+from\s+memory_entries\b)/gi;
  let m;
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index);
    const end = rest.search(/['"`]/);
    out.push({ line: text.slice(0, m.index).split('\n').length, sql: norm(end < 0 ? rest : rest.slice(0, end)) });
  }
  return out;
}
const unlisted = (file, text) => rawWrites(text).filter((w) => !ALLOWED.some((a) => a.file === file && a.re.test(w.sql))).map((w) => `${file}:${w.line}: ${w.sql.slice(0, 100)}`);

test('no raw UPDATE or DELETE of memory_entries outside store.cjs except the two listed', () => {
  const found = [];
  for (const f of fs.readdirSync(CORE).filter((x) => x.endsWith('.cjs') && x !== 'store.cjs')) found.push(...unlisted(f, fs.readFileSync(path.join(CORE, f), 'utf8')));
  assert.deepStrictEqual(found, [], `a raw write of memory_entries outside the store bypasses the held-note guard:\n${found.join('\n')}`);
});

test('mutation controls: a multiline or a lowercase unlisted write is found; the listed ones are not', () => {
  assert.strictEqual(unlisted('x.cjs', "E.store.p('UPDATE memory_entries SET status = ? WHERE id = ?')").length, 1);
  assert.strictEqual(unlisted('x.cjs', 'E.store.p(`UPDATE memory_entries\n    SET status = ?\n    WHERE id = ?`)').length, 1, 'multiline');
  assert.strictEqual(unlisted('x.cjs', "E.store.p('update memory_entries set status = ?')").length, 1, 'lowercase');
  assert.strictEqual(unlisted('x.cjs', 'db.prepare("DELETE\n FROM  memory_entries WHERE id = ?")').length, 1, 'multiline delete');
  assert.strictEqual(unlisted('x.cjs', "p('delete from memory_entries where id = ?')").length, 1, 'lowercase delete');
  assert.strictEqual(unlisted('methods-memory-archive.cjs', "E.store.p('DELETE FROM memory_entries WHERE id = ?').run(r.id)").length, 0);
  assert.strictEqual(unlisted('methods-memory-archive.cjs', "E.store.p('DELETE\n FROM memory_entries WHERE id = ?')").length, 0, 'the listed delete, reformatted');
  assert.strictEqual(unlisted('methods-memory-archive.cjs', "p('DELETE FROM memory_entries WHERE namespace = ?')").length, 1, 'a different delete in the same file');
});

test('every store method that writes a visibility or status field calls the guard', () => {
  const src = fs.readFileSync(path.join(CORE, 'store.cjs'), 'utf8');
  for (const [name, op] of [['setStatusIn', 'status'], ['moveRow', 'move'], ['setSupersedes', 'supersede'], ['delete', 'delete'], ['patchBody', 'body'], ['storeIn', 'supersede']]) {
    const at = src.indexOf(`  ${name}(`);
    assert.ok(at >= 0, name);
    const rest = src.slice(at);
    const next = rest.slice(1).search(/\n  [a-zA-Z_]+\(.*\) \{/);
    assert.ok(new RegExp(`this\\.guard\\('${op}'`).test(rest.slice(0, next < 0 ? rest.length : next + 1)), `${name} calls this.guard('${op}', ...)`);
  }
  assert.ok(/live = "ttl_at IS NOT NULL AND ttl_at < \? AND NOT \(type = 'note'/.test(src), 'the sweep leaves a held note alone');
});
