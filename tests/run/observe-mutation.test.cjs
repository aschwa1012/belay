'use strict';
// observe-mutation.test.cjs — claims of observe.cjs that a mutation run showed no other test pins down: the
// narrative and title bounds to the byte, the code-point-safe cut, the singular command count, the path field
// that is not a string, and the error line only when there are errors.

const test = require('node:test');
const assert = require('node:assert');
const { buildObservation, NARRATIVE_MAX, TITLE_MAX } = require('../../src/run/observe.cjs');

const use = (tool, args, id, extra) => ({ kind: 'tool_use', tool, args, tool_use_id: id, at: '2026-01-01T00:00:00Z', ...extra });
const res = (tool, id, extra) => ({ kind: 'tool_result', tool, tool_use_id: id, bytes: 10, is_error: false, at: '2026-01-01T00:00:01Z', ...extra });
const bash = (id, command, exit_code) => [use('Bash', { command }, id, { command }), res('Bash', id, { exit_code, exit_code_source: 'reported', is_error: exit_code !== 0 })];
const build = (events, extra) => buildObservation({ turn: 3, worker_id: 'w1', task_id: 't1', substrate: 'claude', events, final_text: 'done', ...extra });
const bytes = (s) => Buffer.byteLength(s, 'utf8');

test('the bounds are 1200 bytes for the narrative and 160 for the title', () => {
  assert.strictEqual(NARRATIVE_MAX, 1200);
  assert.strictEqual(TITLE_MAX, 160);
});

test('a narrative of exactly 1200 bytes is kept whole and one more byte is cut', () => {
  assert.strictEqual(build([], { final_text: 'n'.repeat(1200) }).body.narrative, 'n'.repeat(1200));
  assert.strictEqual(build([], { final_text: 'n'.repeat(1201) }).body.narrative, 'n'.repeat(1200));
  assert.strictEqual(build([], { final_text: 'n'.repeat(1199) }).body.narrative, 'n'.repeat(1199));
});

test('a narrative of two-byte characters is cut to the byte bound and keeps what fits', () => {
  const n = build([], { final_text: 'é'.repeat(1000) }).body.narrative;
  assert.strictEqual(bytes(n), 1200);
  assert.strictEqual([...n].length, 600);
  const odd = build([], { final_text: `a${'é'.repeat(1000)}` }).body.narrative;
  assert.ok(bytes(odd) <= 1200 && bytes(odd) >= 1198, `${bytes(odd)} bytes`);
  assert.ok(!odd.includes('�'));
});

test('a cut inside a surrogate pair drops the lone half and nothing before it', () => {
  const n = build([], { final_text: `${'a'.repeat(1197)}\u{1F600}\u{1F600}` }).body.narrative;
  assert.strictEqual(n, 'a'.repeat(1197));
  const exact = build([], { final_text: `${'a'.repeat(1196)}\u{1F600}\u{1F600}` }).body.narrative;
  assert.strictEqual(exact, `${'a'.repeat(1196)}\u{1F600}`);
});

test('a title of exactly 160 bytes is kept whole and a longer one is cut to 160', () => {
  const prefix = 'turn 3: modified ';
  const edit = (name) => [use('Edit', { file_path: `d/${name}` }, 'e1'), res('Edit', 'e1', { files: [`d/${name}`] })];
  const exact = build(edit('f'.repeat(160 - prefix.length)));
  assert.strictEqual(exact.title, `${prefix}${'f'.repeat(160 - prefix.length)}`);
  assert.strictEqual(bytes(exact.title), 160);
  const over = build(edit('f'.repeat(160 - prefix.length + 1)));
  assert.strictEqual(bytes(over.title), 160);
  assert.strictEqual(over.title, `${prefix}${'f'.repeat(160 - prefix.length)}`);
});

test('one command is singular, two are plural, and failures are counted in the title', () => {
  assert.strictEqual(build(bash('b1', 'npm test', 0)).title, 'turn 3: ran 1 command');
  assert.strictEqual(build([...bash('b1', 'a', 0), ...bash('b2', 'b', 0)]).title, 'turn 3: ran 2 commands');
  assert.strictEqual(build([...bash('b1', 'a', 1), ...bash('b2', 'b', 0), ...bash('b3', 'c', 2)]).title, 'turn 3: ran 3 commands (2 failed)');
});

test('a path argument that is not a string is ignored and the next path field is used', () => {
  const o = build([use('Edit', { file_path: 5, path: 'p.cjs' }, 'e1'), res('Edit', 'e1')]);
  assert.deepStrictEqual(o.body.files_modified, ['p.cjs']);
  const none = build([use('Edit', { file_path: 5 }, 'e2'), res('Edit', 'e2')]);
  assert.deepStrictEqual(none.body.files_modified, []);
  const empty = build([use('Edit', { file_path: '', notebook_path: 'n.ipynb' }, 'e3'), res('Edit', 'e3')]);
  assert.deepStrictEqual(empty.body.files_modified, ['n.ipynb']);
});

test('the tool errors line appears only when a result failed', () => {
  const ok = build(bash('b1', 'x', 0));
  assert.ok(!/tool errors/.test(ok.text), ok.text);
  assert.strictEqual(ok.body.errors, 0);
  const failing = build([...bash('b1', 'x', 1), res('Read', 'r9', { is_error: true })]);
  assert.match(failing.text, /^tool errors: 2$/m);
  assert.strictEqual(failing.body.errors, 2);
});

test('a worker-stated narrative is a labelled line and an empty one adds none', () => {
  assert.match(build([], { final_text: 'I fixed it' }).text, /^worker-stated: I fixed it$/m);
  assert.ok(!/worker-stated/.test(build([], { final_text: '' }).text));
  assert.ok(!/worker-stated/.test(build([], { final_text: undefined }).text));
});
