'use strict';
// observe.test.cjs — the mechanical observation builder (ADR 0041 §3): type table, title bound, empty facts,
// no clock, and the body shape. Events use the captured shape of ADR 0041 §2.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildObservation, NARRATIVE_MAX, TITLE_MAX } = require('../../src/run/observe.cjs');
const { createParser } = require('../../src/run/parsers.cjs');

const ident = (t) => ({ text: t, redactions: [] });
function parsed(substrate, file, opts) {
  const p = createParser(substrate, opts);
  const events = [];
  for (const l of fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8').trim().split('\n')) for (const e of p.pushLine(l)) events.push(e);
  return events;
}

const use = (tool, args, id, extra) => ({ kind: 'tool_use', tool, args, tool_use_id: id, at: '2026-01-01T00:00:00Z', ...extra });
const res = (tool, id, extra) => ({ kind: 'tool_result', tool, tool_use_id: id, bytes: 10, is_error: false, at: '2026-01-01T00:00:01Z', ...extra });
const bash = (id, command, exit_code, source = 'reported') => [
  use('Bash', { command }, id, { command }),
  res('Bash', id, { exit_code, exit_code_source: source, is_error: exit_code !== 0 }),
];
const build = (events, extra) => buildObservation({ turn: 3, worker_id: 'w1', task_id: 't1', substrate: 'claude', events, final_text: 'done', ...extra });

test('type table: change, discovery, failure, turn', () => {
  const edit = [use('Edit', { file_path: 'src/a.cjs' }, 'e1'), res('Edit', 'e1', { files: ['src/a.cjs'] })];
  const read = [use('Read', { file_path: 'src/b.cjs' }, 'r1'), res('Read', 'r1', { files: ['src/b.cjs'] })];
  assert.strictEqual(build(edit).type, 'change');
  assert.strictEqual(build(edit).body.kind, 'change', 'the class is kept as body.kind');
  assert.strictEqual(build(read).type, 'discovery');
  assert.strictEqual(build(bash('b1', 'npm test', 1)).type, 'failure');
  assert.strictEqual(build(bash('b1', 'npm test', 0)).type, 'turn');
  assert.strictEqual(build([]).type, 'turn');
  // Only the last command decides failure; an earlier failure that was followed by a pass is a turn.
  assert.strictEqual(build([...bash('b1', 'npm test', 1), ...bash('b2', 'npm test', 0)]).type, 'turn');
  // Modified files win over a failing command and over reads.
  assert.strictEqual(build([...read, ...edit, ...bash('b1', 'x', 2)]).type, 'change');
  // A null exit code is unknown, never a failure.
  assert.strictEqual(build(bash('b1', 'x', null, null)).type, 'turn');
});

test('codex patch items count as modifications', () => {
  const o = build([use('file_change', {}, 'p1'), res('file_change', 'p1', { files: ['lib/x.js'] })]);
  assert.strictEqual(o.type, 'change');
  assert.deepStrictEqual(o.body.files_modified, ['lib/x.js']);
});

test('title is mechanical and at most 160 bytes', () => {
  const o = build([
    use('Edit', { file_path: 'src/a.cjs' }, 'e1'), res('Edit', 'e1', { files: ['src/a.cjs'] }),
    use('Write', { file_path: 'C:\\x\\b.cjs' }, 'e2'), res('Write', 'e2', { files: ['C:\\x\\b.cjs'] }),
    ...bash('b1', 'npm test', 1), ...bash('b2', 'ls', 0), ...bash('b3', 'ls', 0),
  ]);
  assert.strictEqual(o.title, 'turn 3: modified a.cjs, b.cjs; ran 3 commands (1 failed)');
  assert.strictEqual(build([]).title, 'turn 3: no tool activity');
  const long = Array.from({ length: 6 }, (_, i) => use('Edit', { file_path: `d/${'n'.repeat(60)}${i}.cjs` }, `e${i}`));
  const t = build(long).title;
  assert.ok(Buffer.byteLength(t) <= TITLE_MAX, `title ${Buffer.byteLength(t)} bytes`);
  assert.match(build(long.slice(0, 5).map((e) => ({ ...e, args: { file_path: `s/${e.tool_use_id}.cjs` } }))).title, /\+2 more/);
  const wide = build([use('Edit', { file_path: 'x/' + '\u00e9'.repeat(200) + '.cjs' }, 'e1')]).title;
  assert.ok(Buffer.byteLength(wide) <= TITLE_MAX);
  assert.ok(!/\ufffd/.test(wide));
});

test('body shape: facts stay empty, narrative is labelled and bounded, commands carry their exit codes', () => {
  const o = build([
    use('Read', { file_path: 'a.cjs' }, 'r1'), res('Read', 'r1', { files: ['a.cjs'] }),
    use('Read', { file_path: 'a.cjs' }, 'r2'),
    ...bash('b1', 'npm test', 0, 'no-error'),
  ], { final_text: 'x'.repeat(NARRATIVE_MAX + 500) });
  assert.strictEqual(o.body.v, 1);
  assert.strictEqual(o.body.turn, 3);
  assert.deepStrictEqual(o.body.facts, []);
  assert.strictEqual(o.body.narrative_source, 'worker-stated');
  assert.strictEqual(Buffer.byteLength(o.body.narrative), NARRATIVE_MAX);
  assert.deepStrictEqual(o.body.files_read, ['a.cjs']);
  assert.deepStrictEqual(o.body.files_modified, []);
  assert.deepStrictEqual(o.body.commands, [{ tool_use_id: 'b1', command: 'npm test', exit_code: 0, exit_code_source: 'no-error' }]);
  assert.deepStrictEqual(o.body.tool_counts, { Read: 2, Bash: 1 });
  assert.strictEqual(o.body.errors, 0);
  assert.match(o.text, /worker-stated: x+/);
  assert.match(o.text, /command: npm test -> exit 0 \(no-error\)/);
});

test('errors count failed tool results; a file modified is not also listed as read', () => {
  const o = build([
    use('Read', { file_path: 'a.cjs' }, 'r1'), res('Read', 'r1', { files: ['a.cjs'] }),
    use('Edit', { file_path: 'a.cjs' }, 'e1'), res('Edit', 'e1', { files: ['a.cjs'], is_error: true }),
  ]);
  assert.strictEqual(o.body.errors, 1);
  assert.deepStrictEqual(o.body.files_read, []);
  assert.deepStrictEqual(o.body.files_modified, ['a.cjs']);
});

test('narrative cut never splits a code point', () => {
  const o = build([], { final_text: '\u{1F600}'.repeat(400) });
  assert.ok(Buffer.byteLength(o.body.narrative) <= NARRATIVE_MAX);
  assert.ok(!/\ufffd/.test(o.body.narrative));
  assert.strictEqual(Buffer.from(o.body.narrative).toString('utf8'), o.body.narrative);
});

test('no clock: the same input under two Date.now values is identical', () => {
  const events = [...bash('b1', 'npm test', 1), use('Read', { file_path: 'a.cjs' }, 'r1')];
  const realNow = Date.now;
  try {
    Date.now = () => 1000;
    const a = build(events);
    Date.now = () => 9e12;
    const b = build(events);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  } finally { Date.now = realNow; }
});

test('worker, task and substrate tag the caller, not the body; the input is not mutated', () => {
  const events = bash('b1', 'x', 0);
  const snap = JSON.stringify(events);
  const a = build(events, { worker_id: 'w1', task_id: 't1', substrate: 'claude' });
  const b = build(events, { worker_id: 'w9', task_id: 't9', substrate: 'codex' });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(JSON.stringify(events), snap);
});

test('missing or hostile input degrades to an empty turn observation', () => {
  for (const input of [undefined, {}, { events: null }, { events: [null, 7, 'x', {}] }]) {
    const o = buildObservation(input);
    assert.strictEqual(o.type, 'turn');
    assert.deepStrictEqual(o.body.facts, []);
    assert.strictEqual(o.body.narrative, '');
  }
  assert.strictEqual(buildObservation({}).title, 'turn ?: no tool activity');
});

test('real parser output (capture on, recorded Claude stream) yields files, commands and tool counts', () => {
  const o = buildObservation({ turn: 1, events: parsed('claude-code', 'capture-claude.jsonl', { capture: true, redact: ident }), final_text: 'ok' });
  assert.strictEqual(o.type, 'change');
  assert.ok(o.body.files_modified.includes('C:/work/a.txt'));
  assert.deepStrictEqual(o.body.files_read, ['C:/work/b.txt']);
  assert.ok(o.body.tool_counts.Bash >= 2 && o.body.tool_counts.Edit >= 1);
  const codes = o.body.commands.map((c) => c.exit_code);
  assert.deepStrictEqual(codes.slice(0, 2), [0, 127]);
  assert.match(o.body.commands[0].tool_use_id, /^toolu_/);
  assert.strictEqual(o.body.errors, 2);
});

test('real parser output (capture on, Codex stream) yields commands, exit codes and patch files', () => {
  const o = buildObservation({ turn: 1, events: parsed('codex', 'capture-codex.jsonl', { capture: true, redact: ident }), final_text: '' });
  assert.deepStrictEqual(o.body.files_modified, ['src/a.js', 'src/b.js']);
  assert.deepStrictEqual(o.body.commands.map((c) => c.exit_code), [0, 2]);
  assert.strictEqual(o.body.errors, 1);
});

test('Codex file_change items from the parser make a change observation', () => {
  const o = buildObservation({ turn: 1, events: parsed('codex', 'capture-codex-filechange.jsonl', { capture: true, redact: ident }), final_text: '' });
  assert.strictEqual(o.type, 'change');
  assert.deepStrictEqual(o.body.files_modified, ['src/new.js', 'src/old.js']); // src/bad.js failed
  assert.strictEqual(o.body.errors, 1);
});

test('the same command run twice is two entries keyed by tool_use_id, each with its own exit code', () => {
  const o = build([...bash('b1', 'npm test', 1), ...bash('b2', 'npm test', 0)]);
  assert.deepStrictEqual(o.body.commands.map((c) => [c.tool_use_id, c.exit_code]), [['b1', 1], ['b2', 0]]);
});

test('a withheld command (capture without a redactor) never falls back to the raw args', () => {
  const secret = 'sk' + '-ant-' + 'a'.repeat(40);
  const events = parsed('claude-code', 'capture-claude.jsonl', { capture: true, redact: () => ({ text: null }) });
  const raw = events.find((e) => e.kind === 'tool_use' && e.tool === 'Bash');
  assert.strictEqual(raw.command, null);
  const o = buildObservation({ turn: 1, events, final_text: '' });
  assert.strictEqual(o.body.commands[0].command, null);
  assert.match(o.text, /command: \(command withheld: redaction unavailable\) -> exit/);
  assert.ok(!JSON.stringify(o).includes('auto-probe-ok'));
  const hand = build([use('Bash', { command: 'curl ' + secret }, 'b1', { command: null }), res('Bash', 'b1', { exit_code: 0, exit_code_source: 'reported' })]);
  assert.ok(!JSON.stringify(hand).includes(secret));
});

test('paths under the worktree are stored relative, in forward slashes; others stay absolute', () => {
  const root = 'C:/Work/Temp/wt';
  const edit = (p, id) => [use('Edit', { file_path: p }, id), res('Edit', id, { files: [p] })];
  const b = build([
    ...edit('C:\\Work\\Temp\\wt\\bin\\dispatch.cjs', 'e1'),
    ...edit('c:/work/temp/wt/src/a.cjs', 'e2'),
    ...edit('C:\\Work\\Temp\\other\\x.cjs', 'e3'),
    ...edit('C:/Work/Temp/wt2/y.cjs', 'e4'),
  ], { worktree: root });
  assert.deepStrictEqual(b.body.files_modified, ['bin/dispatch.cjs', 'src/a.cjs', 'C:/Work/Temp/other/x.cjs', 'C:/Work/Temp/wt2/y.cjs']);
  assert.ok(!b.text.includes('\\'), 'the text carries no backslash path');
  // The same turn under a root that is spelled with backslashes gives the same body.
  assert.deepStrictEqual(build([...edit('C:/Work/Temp/wt/bin/dispatch.cjs', 'e1')], { worktree: 'C:\\Work\\Temp\\wt\\' }).body.files_modified, ['bin/dispatch.cjs']);
});

test('a Codex patch path under the worktree is stored relative', () => {
  const p = '/work/wt/src/b.cjs';
  const events = [use('file_change', {}, 'c1'), res('file_change', 'c1', { files: [p, '/elsewhere/z.cjs'] })];
  assert.deepStrictEqual(build(events, { worktree: '/work/wt' }).body.files_modified, ['src/b.cjs', '/elsewhere/z.cjs']);
});
