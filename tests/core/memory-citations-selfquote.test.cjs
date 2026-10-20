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

test('a quote the note does not hold is checked as before', () => {
  const f = stream('plain', [use('a', 'Bash'), result('a', 'build ok')]);
  assert.strictEqual(streamCite(f, 'build ok', own, TITLE).found, true);
  assert.strictEqual(streamCite(f, 'build failed', own, TITLE).found, false);
});
