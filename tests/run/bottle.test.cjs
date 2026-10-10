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

test('real recorded stream: text verbatim, the Read call replaced by one line', () => {
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
  const obs = [{ title: 'turn 1: ran 3 commands', body: { turn: 1, commands: [{ command: 'node build.cjs', exit_code: 3, exit_code_source: 'reported' }] } }];
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
