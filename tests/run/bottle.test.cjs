'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildBottle, writeAtomic, KEEP_LAST } = require('../../src/run/bottle.cjs');
const { lines } = require('../helpers/synthetic-stream.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'claude-stream.jsonl');
const L = (o) => `${JSON.stringify(o)}\n`;
const user = (t) => L({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });
const asst = (t) => L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const use = (id, name, input) => L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, content, is_error = false) => L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });

const identity = (text) => ({ text, redactions: [] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bottle-'));
function write(dir, content) {
  const f = path.join(dir, 'stream.jsonl').replace(/\\/g, '/');
  fs.writeFileSync(f, content);
  return f;
}

// What the run manager would have recorded for the two turns of the recorded stream (workers/<id>/sent.jsonl).
const SENT = [
  { seq: 1, turn: 1, kind: 'task', text: 'Read input.md and tell me its first five words.' },
  { seq: 2, turn: 2, kind: 'message', text: 'Now say done.' },
];

test('real recorded stream with its sent record: the user messages come from the record, in turn order', () => {
  const b = buildBottle({ streamPath: FIXTURE, sent: SENT, redact: identity });
  assert.equal(b.fallback, null);
  assert.equal(b.user_messages, 'recorded');
  const at = (s) => b.text.indexOf(s);
  assert.ok(at('user: Read input.md') > 0);
  assert.ok(at('user: Read input.md') < at('[tool Read:'));
  assert.ok(at('[tool Read:') < at('assistant: The first five words'));
  assert.ok(at('assistant: The first five words') < at('user: Now say done.'));
  assert.ok(at('user: Now say done.') < at('assistant: done'));
  assert.ok(!b.text.includes('were not recorded'));
  assert.equal(b.messages, 4);
});

test('the same record read from sentPath (jsonl, a partial last line ignored) gives the same bottle', () => {
  const d = tmp();
  const f = path.join(d, 'sent.jsonl').replace(/\\/g, '/');
  fs.writeFileSync(f, SENT.map((r) => JSON.stringify(r)).join('\n') + '\n{"seq":3,"turn":2,"kind":"message","text":"half wri');
  const a = buildBottle({ streamPath: FIXTURE, sent: SENT, redact: identity });
  const b = buildBottle({ streamPath: FIXTURE, sentPath: f, redact: identity });
  assert.deepEqual(a, b);
  assert.equal(buildBottle({ streamPath: FIXTURE, sentPath: path.join(d, 'absent.jsonl'), redact: identity }).user_messages, 'unrecorded');
});

test('no sent record on a real stream: the header says the messages were not recorded, and the result says so', () => {
  const b = buildBottle({ streamPath: FIXTURE, redact: identity });
  assert.equal(b.fallback, null);
  assert.equal(b.user_messages, 'unrecorded');
  assert.match(b.text.split('\n').slice(0, 2).join('\n'), /messages sent to this worker were not recorded/);
  assert.ok(!/^user: /m.test(b.text));
});

test('stream user-text lines that repeat a sent message are not shown twice; ones that differ are kept', () => {
  const d = tmp();
  const f = write(d, user('do the task') + asst('on it') + user('a note only the stream has') + asst('ok'));
  const b = buildBottle({ streamPath: f, sent: [{ seq: 1, turn: 1, kind: 'task', text: 'do the task' }], redact: identity });
  assert.equal(b.text.split('user: do the task').length, 2);
  assert.ok(b.text.includes('user: a note only the stream has'));
  assert.equal(b.user_messages, 'recorded');
  assert.equal(buildBottle({ streamPath: f, redact: identity }).user_messages, 'stream');
});

test('the sent task is pinned through a drop, wake and resume messages are labelled generated, an unanswered message still appears', () => {
  const d = tmp();
  let s = '';
  for (let i = 1; i <= 40; i += 1) s += asst(`message ${String(i).padStart(2, '0')} ` + 'x'.repeat(200));
  const sent = [
    { seq: 1, turn: 1, kind: 'task', text: 'SPEC pinned' },
    { seq: 2, turn: 1, kind: 'wake', text: 'a wake' },
    { seq: 3, turn: 9, kind: 'message', text: 'unanswered note' },
  ];
  const b = buildBottle({ streamPath: write(d, s), sent, redact: identity, maxBytes: 6000 });
  assert.equal(b.fallback, null);
  assert.ok(b.dropped > 0);
  assert.ok(b.text.includes('user: SPEC pinned'));
  assert.ok(!b.text.includes('a wake')); // dropped as the oldest unpinned message
  assert.ok(b.text.includes('user: unanswered note'));
  const roomy = buildBottle({ streamPath: write(d, s), sent, redact: identity });
  assert.ok(roomy.text.includes('user (generated, wake): a wake'));
  assert.ok(roomy.text.indexOf('SPEC pinned') < roomy.text.indexOf('a wake'));
  assert.ok(roomy.text.indexOf('a wake') < roomy.text.indexOf('message 01'));
});

test('real recorded stream without a sent record: text verbatim, the Read call replaced by one line', () => {
  const b = buildBottle({ streamPath: FIXTURE, redact: identity });
  assert.equal(b.fallback, null);
  assert.match(b.text, /assistant: The first five words are: "The belay harness is the"/);
  assert.match(b.text, /assistant: done/);
  assert.equal(b.tool_calls_replaced, 1);
  assert.match(b.text, /\[tool Read: .*; 2 lines\]/);
  assert.ok(!b.text.includes('"type":"tool_use"'));
  assert.equal(b.bytes, Buffer.byteLength(b.text));
});

test('a partial last line is ignored', () => {
  const d = tmp();
  const f = write(d, user('do the task') + asst('first answer') + '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"half wri');
  const b = buildBottle({ streamPath: f, redact: identity });
  assert.equal(b.fallback, null);
  assert.ok(b.text.includes('first answer'));
  assert.ok(!b.text.includes('half wri'));
  assert.equal(b.messages, 2);
});

test('tool calls become one line each: exit code from the result, from the observations, and a stand-in title', () => {
  const d = tmp();
  const f = write(d, user('spec') +
    use('t1', 'Bash', { command: 'npm test' }) + res('t1', 'Exit code 1\n1 failing\nmore', true) +
    use('t2', 'Bash', { command: 'git status' }) + res('t2', 'clean') +
    use('t3', 'Bash', { command: 'node build.cjs' }) + res('t3', 'ok') +
    use('t4', 'Glob', { pattern: '*.cjs' }) + res('t4', 'a\nb\nc') +
    asst('finished'));
  const obs = [{ title: 'turn 1: ran 3 commands', body: { turn: 1, commands: [{ tool_use_id: 't3', command: 'node build.cjs', exit_code: 3, exit_code_source: 'reported' }] } }];
  const b = buildBottle({ streamPath: f, observations: obs, redact: identity });
  assert.match(b.text, /\[tool Bash: npm test -> exit 1 \(reported\); 3 lines\]/);
  assert.match(b.text, /\[tool Bash: git status -> exit 0 \(no-error\); 1 lines\]/);
  assert.match(b.text, /\[tool Bash: node build\.cjs -> exit 3 \(reported\); 1 lines\]/);
  assert.match(b.text, /\[tool Glob: \*\.cjs; 3 lines; turn summary \(generated\): turn 1: ran 3 commands\]/);
  assert.equal(b.tool_calls_replaced, 4);
});

test('redact is applied to messages and tool lines', () => {
  const d = tmp();
  const secret = 'sk' + '-ant-' + 'a'.repeat(40);
  const f = write(d, user(`use key ${secret}`) + use('t1', 'Bash', { command: `curl -H ${secret}` }) + res('t1', 'ok') + asst(`saw ${secret}`));
  const seen = [];
  const redact = (t) => { seen.push(t); return { text: t.split(secret).join('[REDACTED]'), redactions: t.includes(secret) ? ['key'] : [] }; };
  const b = buildBottle({ streamPath: f, redact });
  assert.ok(!b.text.includes(secret));
  assert.equal((b.text.match(/\[REDACTED\]/g) || []).length, 3);
  assert.equal(b.redactions, 3);
  assert.equal(seen.length, 3);
});

test('no redactor available: refused, never rendered unredacted', () => {
  const b = buildBottle({ streamPath: FIXTURE, redact: undefined });
  // The core redactor is another module of the same change set; when it is present the bottle builds.
  let present = true;
  try { require('../../src/core/redact.cjs'); } catch { present = false; }
  if (present) assert.equal(b.fallback, null);
  else { assert.equal(b.fallback, 'E_REDACT_ABSENT'); assert.equal(b.text, ''); }
});

test('over budget drops the oldest first and keeps the spec, the last 20 messages and the last assistant message', () => {
  const d = tmp();
  let s = user('SPEC the task spec');
  for (let i = 1; i <= 60; i += 1) s += asst(`message ${String(i).padStart(2, '0')} ` + 'x'.repeat(200));
  const f = write(d, s);
  const b = buildBottle({ streamPath: f, redact: identity, maxBytes: 6000 });
  assert.equal(b.fallback, null);
  assert.ok(b.bytes <= 6000);
  assert.ok(b.dropped > 0);
  assert.ok(b.text.includes('SPEC the task spec'));
  for (let i = 60 - KEEP_LAST + 1; i <= 60; i += 1) assert.ok(b.text.includes(`message ${String(i).padStart(2, '0')} `), `message ${i}`);
  const present = [...b.text.matchAll(/message (\d\d) /g)].map((m) => Number(m[1]));
  assert.deepEqual(present, [...present].sort((a, c) => a - c));
  assert.ok(!present.includes(1));
  assert.match(b.text, /earlier items omitted/);
});

test('oldest are dropped before newer: the dropped set is a prefix of the droppable messages', () => {
  const d = tmp();
  let s = user('SPEC');
  for (let i = 1; i <= 50; i += 1) s += asst(`message ${String(i).padStart(2, '0')} ` + 'y'.repeat(100));
  const b = buildBottle({ streamPath: write(d, s), redact: identity, maxBytes: 4500 });
  const present = [...b.text.matchAll(/message (\d\d) /g)].map((m) => Number(m[1]));
  const first = present[0];
  assert.deepEqual(present, present.map((_, i) => first + i));
  assert.equal(present[present.length - 1], 50);
});

test('nothing droppable and still over budget falls back', () => {
  const d = tmp();
  const f = write(d, user('SPEC') + asst('z'.repeat(5000)));
  const b = buildBottle({ streamPath: f, redact: identity, maxBytes: 1000 });
  assert.equal(b.fallback, 'E_OVER_BUDGET');
  assert.equal(b.text, '');
  assert.equal(b.over_budget, true);
});

test('a missing stream gives fallback, an empty one too', () => {
  const d = tmp();
  const missing = buildBottle({ streamPath: path.join(d, 'nope.jsonl'), redact: identity });
  assert.equal(missing.fallback, 'E_STREAM_UNREADABLE');
  assert.equal(missing.bytes, 0);
  const empty = buildBottle({ streamPath: write(d, ''), redact: identity });
  assert.equal(empty.fallback, 'E_EMPTY');
});

test('synthetic stream: a pure function of its bytes, no clock, no timestamp pattern', () => {
  const d = tmp();
  const f = write(d, lines(60).join(''));
  const real = Date.now;
  let a, c;
  try {
    Date.now = () => 1000;
    a = buildBottle({ streamPath: f, redact: identity });
    Date.now = () => 9999999999999;
    c = buildBottle({ streamPath: f, redact: identity });
  } finally { Date.now = real; }
  assert.deepEqual(a, c);
  assert.equal(a.fallback, null);
  assert.ok(a.tool_calls_replaced > 0);
  assert.ok(!/\b\d{4}-\d\d-\d\dT\d\d:/.test(a.text));
  assert.ok(!/\b\d{13}\b/.test(a.text));
  assert.ok(!/\bago\b/.test(a.text));
});

test('maxBytes is clamped to the ceiling', () => {
  const d = tmp();
  const f = write(d, user('SPEC') + asst('a'));
  const b = buildBottle({ streamPath: f, redact: identity, maxBytes: 10 ** 9 });
  assert.equal(b.fallback, null);
});

test('writeAtomic writes the whole file and leaves no temp file; a failure leaves none either', () => {
  const d = tmp();
  const target = path.join(d, 'resume.md');
  fs.writeFileSync(target, 'old');
  const r = writeAtomic(target, 'new text');
  assert.equal(r.bytes, 8);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new text');
  assert.deepEqual(fs.readdirSync(d), ['resume.md']);
  assert.throws(() => writeAtomic(path.join(d, 'no-such-dir', 'resume.md'), 'x'));
  assert.deepEqual(fs.readdirSync(d), ['resume.md']);
});

test('the same command run twice keeps its own exit code: matched by tool_use_id, and the stream own code wins', () => {
  const d = tmp();
  const f = write(d, user('spec') +
    use('t1', 'Bash', { command: 'npm test' }) + res('t1', 'Exit code 1\n1 failing', true) +
    use('t2', 'Bash', { command: 'npm test' }) + res('t2', 'all passing') +
    use('t3', 'Bash', { command: 'npm test' }) + res('t3', 'Exit code -1\ntimeout', true) +
    use('t4', 'Bash', { command: 'npm test' }) + res('t4', 'ok') +
    asst('finished'));
  // The capture says t4 exited 5; t1's entry disagrees with the stream (exit 9) and loses to it.
  const obs = [{ title: 'turn 1', body: { turn: 1, commands: [
    { tool_use_id: 't1', command: 'npm test', exit_code: 9, exit_code_source: 'reported' },
    { tool_use_id: 't4', command: 'npm test', exit_code: 5, exit_code_source: 'reported' }] } }];
  const b = buildBottle({ streamPath: f, observations: obs, redact: identity });
  const toolLines = b.text.split('\n').filter((l) => l.startsWith('[tool Bash'));
  assert.equal(toolLines.length, 4);
  assert.match(toolLines[0], /exit 1 \(reported\)/);
  assert.match(toolLines[1], /exit 0 \(no-error\)/);
  assert.match(toolLines[2], /exit -1 \(reported\)/);
  assert.match(toolLines[3], /exit 5 \(reported\)/);
});

test('a command over 300 bytes still gets its captured exit code (no longer matched by text)', () => {
  const d = tmp();
  const long = 'echo ' + 'x'.repeat(400);
  const f = write(d, user('spec') + use('t1', 'Bash', { command: long }) + res('t1', 'out') + asst('done'));
  const obs = [{ title: 'turn 1', body: { turn: 1, commands: [{ tool_use_id: 't1', command: long.slice(0, 300), exit_code: 7, exit_code_source: 'reported' }] } }];
  assert.match(buildBottle({ streamPath: f, observations: obs, redact: identity }).text, /exit 7 \(reported\)/);
});

test('the bottle never exceeds maxBytes, including its trailing newline, at every size around the boundary', () => {
  const d = tmp();
  const f = write(d, user('SPEC') + asst('a'.repeat(120)) + asst('b'.repeat(120)) + asst('c'.repeat(120)));
  const full = buildBottle({ streamPath: f, redact: identity });
  for (let max = full.bytes - 3; max <= full.bytes + 1; max += 1) {
    const b = buildBottle({ streamPath: f, redact: identity, maxBytes: max });
    if (b.fallback) assert.equal(b.fallback, 'E_OVER_BUDGET');
    else assert.ok(b.bytes <= max, `max ${max} gave ${b.bytes}`);
  }
  // The old builder produced max + 1 here.
  assert.ok(buildBottle({ streamPath: f, redact: identity, maxBytes: full.bytes - 1 }).bytes <= full.bytes - 1 || buildBottle({ streamPath: f, redact: identity, maxBytes: full.bytes - 1 }).fallback);
});

test('a redactor with another signature (a string back) is a failed redaction, never a header-only bottle', () => {
  const d = tmp();
  const f = write(d, user('spec') + asst('text'));
  const b = buildBottle({ streamPath: f, redact: (t) => t });
  assert.equal(b.fallback, 'E_REDACT');
  assert.equal(b.text, '');
  assert.equal(buildBottle({ streamPath: f, redact: () => ({ text: null }) }).fallback, 'E_REDACT');
});

test('the omitted count in the header equals the dropped count', () => {
  const d = tmp();
  let s = user('SPEC');
  for (let i = 1; i <= 120; i += 1) s += asst(`message ${i} ` + 'z'.repeat(50));
  const f = write(d, s);
  let seen = 0;
  for (const max of [5000, 5100, 5300, 7000, 7777]) {
    const b = buildBottle({ streamPath: f, redact: identity, maxBytes: max });
    if (b.fallback) continue;
    seen += 1;
    const m = /\[(\d+) earlier items omitted/.exec(b.text);
    assert.equal(m ? Number(m[1]) : 0, b.dropped, `max ${max}`);
    assert.ok(b.bytes <= max);
  }
  assert.ok(seen >= 3);
});
