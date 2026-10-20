'use strict';
// bottle-mutation.test.cjs — claims of bottle.cjs that a mutation run showed no other test pins down: the
// default budget to the byte, the exact shape of a failed result, a missing redactor, the pinned last assistant
// message, the order of a sent record that arrives out of order, the clip of a long target and the tolerance
// for a tool result with no content.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildBottle, DEFAULT_MAX, CEILING_MAX, KEEP_LAST } = require('../../src/run/bottle.cjs');

const L = (o) => `${JSON.stringify(o)}\n`;
const user = (t) => L({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } });
const asst = (t) => L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
const use = (id, name, input) => L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const identity = (text) => ({ text, redactions: [] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bottle-mut-'));
function write(dir, content) {
  const f = path.join(dir, 'stream.jsonl').replace(/\\/g, '/');
  fs.writeFileSync(f, content);
  return f;
}

test('the limits are exported: 65536 by default, 262144 at the ceiling, 20 kept', () => {
  assert.equal(DEFAULT_MAX, 65536);
  assert.equal(CEILING_MAX, 262144);
  assert.equal(KEEP_LAST, 20);
});

test('with no maxBytes the bottle is bounded at exactly 65536 bytes and not one more', () => {
  const d = tmp();
  const probe = buildBottle({ streamPath: write(d, asst('x'.repeat(70000))), redact: identity, maxBytes: CEILING_MAX });
  assert.equal(probe.fallback, null);
  const fitting = write(d, asst('x'.repeat(70000 - (probe.bytes - DEFAULT_MAX))));
  const exact = buildBottle({ streamPath: fitting, redact: identity });
  assert.equal(exact.fallback, null);
  assert.equal(exact.bytes, DEFAULT_MAX);
  const over = buildBottle({ streamPath: write(d, asst('x'.repeat(70001 - (probe.bytes - DEFAULT_MAX)))), redact: identity });
  assert.equal(over.fallback, 'E_OVER_BUDGET', 'the one pinned message cannot be dropped, so one byte over is a fallback');
});

test('a failed bottle has exactly the documented shape', () => {
  const d = tmp();
  const empty = buildBottle({ streamPath: write(d, ''), redact: identity });
  assert.deepEqual(empty, { text: '', bytes: 0, messages: 0, tool_calls_replaced: 0, dropped: 0, over_budget: false, user_messages: null, spec_pinned: false, fallback: 'E_EMPTY' });
  const missing = buildBottle({ streamPath: path.join(d, 'nope.jsonl'), redact: identity });
  assert.deepEqual(missing, { text: '', bytes: 0, messages: 0, tool_calls_replaced: 0, dropped: 0, over_budget: false, user_messages: null, spec_pinned: false, fallback: 'E_STREAM_UNREADABLE' });
  const bad = buildBottle({ streamPath: write(d, asst('hello')), redact: () => 'a string' });
  assert.deepEqual(bad, { text: '', bytes: 0, messages: 0, tool_calls_replaced: 0, dropped: 0, over_budget: false, user_messages: null, spec_pinned: false, fallback: 'E_REDACT' });
});

test('over budget with nothing droppable reports the dropped count and over_budget true', () => {
  const d = tmp();
  const b = buildBottle({ streamPath: write(d, user('SPEC') + asst('a'.repeat(400))), redact: identity, maxBytes: 300 });
  assert.equal(b.fallback, 'E_OVER_BUDGET');
  assert.equal(b.over_budget, true);
  assert.equal(b.text, '');
  assert.ok(Number.isInteger(b.dropped) && b.dropped >= 0);
});

test('a missing redactor module is a refusal by name and renders nothing', () => {
  const d = tmp();
  const f = write(d, asst('secret-looking text'));
  const key = require.resolve('../../src/core/redact.cjs');
  const saved = require.cache[key];
  require.cache[key] = { id: key, filename: key, loaded: true, exports: {}, children: [], paths: [] };
  try {
    const b = buildBottle({ streamPath: f });
    assert.equal(b.fallback, 'E_REDACT_ABSENT');
    assert.equal(b.text, '');
    assert.equal(b.bytes, 0);
  } finally { if (saved) require.cache[key] = saved; else delete require.cache[key]; }
});

test('the last assistant message is pinned even when twenty later messages are not the assistant\'s', () => {
  const d = tmp();
  let s = asst('LAST-ASSISTANT-WORD ' + 'a'.repeat(60));
  for (let i = 1; i <= 25; i += 1) s += user(`user number ${i} ${'u'.repeat(60)}`);
  const f = write(d, s);
  const full = buildBottle({ streamPath: f, redact: identity });
  assert.equal(full.dropped, 0);
  const tight = buildBottle({ streamPath: f, redact: identity, maxBytes: full.bytes - 20 });
  assert.equal(tight.fallback, null);
  assert.ok(tight.dropped >= 1);
  assert.ok(tight.text.includes('LAST-ASSISTANT-WORD'), 'the last assistant message survives a drop');
  assert.ok(tight.text.includes('user number 1 '), 'the first user message (the spec) survives too');
  assert.ok(!tight.text.includes('user number 2 '), 'the oldest unpinned message went first');
});

test('a sent record that arrives out of order is read by turn, then by seq', () => {
  const d = tmp();
  const stream = asst('first answer') + L({ type: 'result', subtype: 'success' }) + asst('second answer');
  const sent = [
    { seq: 9, turn: 2, kind: 'message', text: 'M-TURN2-LATE' },
    { seq: 5, turn: 2, kind: 'message', text: 'M-TURN2-EARLY' },
    { seq: 1, turn: 1, kind: 'task', text: 'M-TASK' },
  ];
  const b = buildBottle({ streamPath: write(d, stream), sent, redact: identity });
  const at = (s) => b.text.indexOf(s);
  assert.ok(at('user: M-TASK') > 0);
  assert.ok(at('user: M-TASK') < at('assistant: first answer'));
  assert.ok(at('assistant: first answer') < at('user: M-TURN2-EARLY'));
  assert.ok(at('user: M-TURN2-EARLY') < at('user: M-TURN2-LATE'));
  assert.ok(at('user: M-TURN2-LATE') < at('assistant: second answer'));
});

test('a long tool target is cut after 119 characters and ends in an ellipsis', () => {
  const d = tmp();
  const cmd = `echo ${'z'.repeat(300)}`;
  const b = buildBottle({ streamPath: write(d, asst('go') + use('t1', 'Bash', { command: cmd })), redact: identity });
  const line = b.text.split('\n').find((l) => l.startsWith('[tool Bash:'));
  const m = /^\[tool Bash: (.*?)(?: -> .*)?; /.exec(line);
  // clip keeps the first 119 characters and adds three dots (so the shown target is 122 characters; see the report)
  assert.equal(m[1], `${cmd.slice(0, 119)}...`);
  const short = buildBottle({ streamPath: write(d, asst('go') + use('t2', 'Bash', { command: 'echo hi' })), redact: identity });
  assert.match(short.text, /\[tool Bash: echo hi; no result\]/);
});

test('a tool result with no content, or content that is not text, reads as zero lines', () => {
  const d = tmp();
  const stream = asst('go') + use('t1', 'Read', { file_path: 'a.cjs' })
    + L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } })
    + use('t2', 'Read', { file_path: 'b.cjs' })
    + L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: { odd: true } }] } });
  const b = buildBottle({ streamPath: write(d, stream), redact: identity });
  assert.equal(b.fallback, null);
  assert.match(b.text, /\[tool Read: a\.cjs; 0 lines\]/);
  assert.match(b.text, /\[tool Read: b\.cjs; 0 lines\]/);
});

test('capture data is matched only by a real tool_use_id, and an entry without one or a null entry is ignored', () => {
  const d = tmp();
  const stream = asst('go') + use('t1', 'Edit', { file_path: 'a.cjs' });
  const observations = [{ title: 'turn 1: x', body: { turn: 1, commands: [null, { command: 'x', exit_code: 3, exit_code_source: 'reported' }, { tool_use_id: 7, exit_code: 4 }, { tool_use_id: '', exit_code: 5 }] } }];
  const b = buildBottle({ streamPath: write(d, stream), observations, redact: identity });
  assert.equal(b.fallback, null);
  assert.match(b.text, /\[tool Edit: a\.cjs; no result; turn summary \(generated\): turn 1: x\]/);
  const matched = buildBottle({ streamPath: write(d, stream), observations: [{ title: 't', body: { turn: 1, commands: [{ tool_use_id: 't1', exit_code: 2, exit_code_source: 'derived' }] } }], redact: identity });
  assert.match(matched.text, /\[tool Edit: a\.cjs -> exit 2 \(derived\); no result\]/);
});
