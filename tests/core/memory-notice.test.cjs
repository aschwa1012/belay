'use strict';
// The no-project notice: the helper's condition, that it is pure (nothing is loaded that a read path must not load), and the
// words it carries (the exact line to add and the name rule).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const N = require('../../src/core/memory-notice.cjs');

test('the notice holds when notes are on by default and no project is set', () => {
  for (const block of [undefined, null, {}, { project: null }, { project: '' }, { notes_match_n: 2 }, 'x', []]) {
    const n = N.noticeFor(block);
    assert.ok(n, JSON.stringify(block));
    assert.strictEqual(n.title, 'Memory is off for this project');
    assert.ok(n.fix.includes('"memory": { "project": "<name>" }'));
    assert.ok(n.fix.includes('belay settings memory.project <name>'));
    assert.ok(n.fix.includes(N.NAME_RULE));
  }
});

test('the notice does not hold once a project is set, or when notes are explicitly off', () => {
  assert.strictEqual(N.noticeFor({ project: 'acme' }), null);
  assert.strictEqual(N.noticeFor({ project: 'acme', notes: true }), null);
  assert.strictEqual(N.noticeFor({ notes: false }), null);
  assert.strictEqual(N.noticeFor({ notes: false, project: null }), null);
});

test('from a discovered config: no file, an empty file and a file with a project', () => {
  assert.ok(N.noticeForConfig({ found: false }));
  assert.ok(N.noticeForConfig({ found: true, config: {} }));
  assert.ok(N.noticeForConfig({ found: true, config: { memory: { rules: true } } }));
  assert.strictEqual(N.noticeForConfig({ found: true, config: { memory: { project: 'acme' } } }), null);
});

test('the project name rule in the notice is the rule the levers enforce', () => {
  const ML = require('../../src/core/memory-levers.cjs');
  const re = new RegExp(N.NAME_RULE);
  assert.ok(re.test('acme') && re.test('a.b_c-1') && !re.test('Acme') && !re.test('-a'));
  assert.strictEqual(ML.parseMemoryBlock({ project: 'acme' }).error, undefined);
  assert.ok(ML.parseMemoryBlock({ project: 'Acme' }).error);
});

test('the helper requires nothing, so no read path that loads it reaches the embedder', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'memory-notice.cjs'), 'utf8');
  assert.deepStrictEqual(src.match(/require\(/g), null);
});

test('the read commands that show the notice load no embedder module', () => {
  require('../../src/cli/cmd-settings.cjs');
  require('../../src/cli/cmd-doctor.cjs');
  require('../../src/cli/cmd-status.cjs');
  require('../../src/cli/run-levers.cjs');
  const hit = Object.keys(require.cache).filter((k) => /[\/]src[\/]core[\/]embedder\.cjs$/i.test(k) || /transformers/i.test(k));
  assert.deepStrictEqual(hit, []);
});
