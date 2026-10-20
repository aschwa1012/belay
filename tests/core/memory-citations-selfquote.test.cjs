'use strict';
// A stream cite that the note's own words also hold: accepted when a non-belay tool result prints it (and that result is not an
// echo of the note), refused when the only places are the note, a belay call, the hand-back echo or the worker's prose.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { streamCite } = require('../../src/core/memory-citations.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfquote-'));
const use = (id, name, input = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const prose = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const TITLE = 'the loader skips every unlisted fixture silently';
const own = [TITLE, 'evidence: data/a.json lists mb_1021'];

function stream(name, lines) {
  const f = path.join(dir, `${name}.jsonl`).split('\\').join('/');
  fs.writeFileSync(f, `${lines.join('\n')}\n`);
  return f;
}

test('a quote a tool printed is accepted although the note holds it too', () => {
  const f = stream('printed', [use('a', 'Bash'), result('a', 'data/a.json lists mb_1021 and mb_1022')]);
  assert.strictEqual(streamCite(f, 'data/a.json lists mb_1021', own, TITLE).found, true);
});

test('a quote only the note holds is refused, as is one only a belay call, the hand-back echo or the worker\'s prose holds', () => {
  const f = stream('echo', [
    use('b', 'mcp__belay__lease_release', { result: { notes: [{ title: TITLE, saw: 'data/a.json lists mb_1021' }] } }),
    result('b', `saved: ${TITLE}; data/a.json lists mb_1021`),
    prose('data/a.json lists mb_1021, I wrote that down'),
    use('c', 'Bash'), result('c', 'nothing relevant'),
  ]);
  for (const q of ['data/a.json lists mb_1021', TITLE]) {
    const r = streamCite(f, q, own, TITLE);
    assert.strictEqual(r.found, false, q);
    assert.match(r.reason, /own text/);
  }
});

test('a tool result that echoes the note\'s title does not count for a quote the note holds', () => {
  const f = stream('index', [use('d', 'Bash'), result('d', `- note [lesson] ${TITLE}\n- other note`)]);
  assert.strictEqual(streamCite(f, TITLE, own, TITLE).found, false);
  const g = stream('index2', [use('d', 'Bash'), result('d', `- note [lesson] ${TITLE}`), use('e', 'Read'), result('e', `a different listing, and data/a.json lists mb_1021`)]);
  assert.strictEqual(streamCite(g, 'data/a.json lists mb_1021', own, TITLE).found, true);
});

test('echoes of the note by other routes are refused: its saw text, a cut title, an escaped title, a short title', () => {
  const T = 'The pager retries a failed send exactly 3 times before it gives up and logs the receipt to data/pager/receipts.jsonl';
  const SAW = 'pager.cjs: const RETRIES = 3';
  const refusedIn = (name, lines, quote, o, t) => assert.strictEqual(streamCite(stream(name, lines), quote, o, t).found, false, name);
  refusedIn('eb', [use('1', 'Bash'), result('1', `id status title\nn-1 unverified ${T.slice(0, 80)}`)], T.slice(0, 60), [T, SAW], T);
  const T2 = 'The config key is "retry_limit" and its default is 3 in src/config.cjs';
  refusedIn('ec', [use('1', 'Bash'), result('1', JSON.stringify({ title: T2, saw: 'src/config.cjs: retry_limit: 3' }))], 'src/config.cjs: retry_limit: 3', [T2, 'src/config.cjs: retry_limit: 3'], T2);
  refusedIn('ed', [use('1', 'Bash'), result('1', `note: RETRIES=3; ${SAW}`)], SAW, ['RETRIES=3', SAW], 'RETRIES=3');
});

test('a short saw a tool printed, and a short phrase title in a heading or log, are genuine evidence', () => {
  const ok = (name, lines, quote, o, t) => assert.strictEqual(streamCite(stream(name, lines), quote, o, t).found, true, name);
  ok('g', [use('1', 'Bash'), result('1', 'node dispatch.cjs import\nError: row 4: 1 field, 3 expected\nexit 1')], '1 field, 3 expected', ['Importer rejects a row with the wrong field count', 'Error: row 4: 1 field, 3 expected'], 'Importer rejects a row with the wrong field count');
  ok('g2', [use('1', 'Bash'), result('1', 'ok 3 - receipts mismatch when text exceeds 96 chars\n# pass 12')], 'receipts mismatch when text exceeds 96 chars', ['Pager cuts text at 96 characters', 'ok 3 - receipts mismatch when text exceeds 96 chars'], 'Pager cuts text at 96 characters');
  ok('h', [use('1', 'Read'), result('1', '## Ledger format\nDD.MM.YYYY;amount;note')], 'DD.MM.YYYY;amount;note', ['Ledger format', 'DD.MM.YYYY;amount;note'], 'Ledger format');
  ok('h2', [use('1', 'Bash'), result('1', 'warning: npm test hangs when the watcher is on\nnode --test exits 0 without --watch')], 'node --test exits 0 without --watch', ['npm test hangs', 'node --test exits 0 without --watch'], 'npm test hangs');
});

test('genuine evidence that shares words with the note stays accepted', () => {
  const T = 'No file: 004 exists, the list is 001 002 003 only';
  const f = stream('g7', [use('1', 'Bash'), result('1', 'ls out\nno file: 004\n["001","002","003"]')]);
  assert.strictEqual(streamCite(f, 'no file: 004', [T, 'saw no file: 004 in the listing'], T).found, true);
  const g = stream('read', [use('1', 'Read'), result('1', '  12\tconst RETRIES = 3;')]);
  assert.strictEqual(streamCite(g, 'const RETRIES = 3', ['pager.cjs: const RETRIES = 3', 'The pager retries 3 times'], 'The pager retries 3 times').found, true);
});

test('a quote the note does not hold is checked as before', () => {
  const f = stream('plain', [use('a', 'Bash'), result('a', 'build ok')]);
  assert.strictEqual(streamCite(f, 'build ok', own, TITLE).found, true);
  assert.strictEqual(streamCite(f, 'build failed', own, TITLE).found, false);
});
