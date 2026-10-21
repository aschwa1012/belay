'use strict';
// held-guard-coverage.test.cjs — every write of a note's visibility or status goes through a guarded store method. This greps src/core for a raw
// UPDATE or DELETE of memory_entries outside store.cjs: the only ones allowed are the archive purge (archive rows only, operator only) and the
// retitle of a pending note (pending rows are never held). A new raw write fails here until it goes through the store or is listed with its reason.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..', '..', 'src', 'core');
const ALLOWED = [
  { file: 'methods-memory-archive.cjs', re: /DELETE FROM memory_entries WHERE id = \?/, why: 'archive purge: archive/ rows only, operator only, never a held note' },
  { file: 'methods-memory-notes.cjs', re: /UPDATE memory_entries SET title = \?, text = \?, text_hash = \?/, why: 'retitle of a pending note: a pending note is never held' },
];

test('no raw UPDATE or DELETE of memory_entries outside store.cjs except the two listed', () => {
  const found = [];
  for (const f of fs.readdirSync(CORE).filter((x) => x.endsWith('.cjs') && x !== 'store.cjs')) {
    fs.readFileSync(path.join(CORE, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/(UPDATE memory_entries SET|DELETE FROM memory_entries)/.test(line) && !ALLOWED.some((a) => a.file === f && a.re.test(line))) found.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepStrictEqual(found, [], `a raw write of memory_entries outside the store bypasses the held-note guard:\n${found.join('\n')}`);
});

test('every store method that writes a visibility or status field calls the guard', () => {
  const src = fs.readFileSync(path.join(CORE, 'store.cjs'), 'utf8');
  for (const [name, op] of [['setStatusIn', 'status'], ['moveRow', 'move'], ['setSupersedes', 'supersede'], ['delete', 'delete'], ['patchBody', 'body'], ['storeIn', 'supersede']]) {
    const at = src.indexOf(`  ${name}(`);
    assert.ok(at >= 0, name);
    const rest = src.slice(at);
    const end = rest.search(/\n  [a-zA-Z_]+\(.*\) \{/ ) > 0 ? rest.slice(1).search(/\n  [a-zA-Z_]+\(.*\) \{/) : rest.length;
    assert.ok(new RegExp(`this\\.guard\\('${op}'`).test(rest.slice(0, end + 1)), `${name} calls this.guard('${op}', ...)`);
  }
  assert.ok(/live = "ttl_at IS NOT NULL AND ttl_at < \? AND NOT \(type = 'note'/.test(src), 'the sweep leaves a held note alone');
});
