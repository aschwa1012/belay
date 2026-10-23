'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readUsage, sessionFileOf, PRICES } = require('../../src/cli/transcript-usage.cjs');
const { fillFromTranscript } = require('../../src/cli/cmd-agents.cjs');

const FIX = path.join(__dirname, '..', 'fixtures', 'transcript-usage', 'session.jsonl');
const RATES = { 'test-model-a': { input: 10, output: 100, cache_read: 1, cache_write: 20 } }; // a test rate, not a real one
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tu-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const asst = (id, model, u, extra = {}) => `${JSON.stringify({ type: 'assistant', ...extra, message: { model, id, usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] } } })}\n`;

test('belay holds no invented price: the shipped table is empty', () => {
  assert.deepStrictEqual(Object.keys(PRICES), []);
});

test('dedup by message.id (last line wins), sidechain and synthetic skipped for context', () => {
  const u = readUsage(FIX, null, RATES);
  assert.strictEqual(u.messages, 3); // msg_1 once, msg_side, msg_2; synthetic never counted
  assert.deepStrictEqual(u.tokens, { input: 12, output: 103, cache_read: 1000, cache_creation: 1200 });
  assert.strictEqual(u.context_tokens, 1203); // msg_2: 3 + 200 + 1000, not the sidechain's
  assert.strictEqual(u.model_seen, 'test-model-a');
  assert.strictEqual(u.cost_usd, (12 * 10 + 103 * 100 + 1000 * 1 + 1200 * 20) / 1e6);
});

test('unknown model: tokens and context, no dollars', () => {
  const u = readUsage(FIX);
  assert.strictEqual(u.cost_usd, null);
  assert.deepStrictEqual(u.unpriced_models, ['test-model-a']);
  assert.strictEqual(u.context_tokens, 1203);
});

test('a partial last line is left alone and counted once it completes', (t) => {
  const f = path.join(tmp(t), 's.jsonl');
  const whole = asst('m1', 'test-model-a', [1, 2, 3, 4]);
  const second = asst('m2', 'test-model-a', [10, 20, 30, 40]);
  fs.writeFileSync(f, whole + second.slice(0, 40));
  const cache = new Map();
  const u1 = readUsage(f, cache);
  assert.strictEqual(u1.messages, 1);
  assert.strictEqual(u1.context_tokens, 6);
  fs.writeFileSync(f, whole + second);
  const u2 = readUsage(f, cache);
  assert.strictEqual(u2.messages, 2);
  assert.strictEqual(u2.context_tokens, 60);
});

test('a missing file reads as nothing, throws nothing and creates nothing', (t) => {
  const d = tmp(t);
  const u = readUsage(path.join(d, 'nope.jsonl'), new Map());
  assert.strictEqual(u.exists, false);
  assert.strictEqual(u.context_tokens, null);
  assert.strictEqual(u.cost_usd, null);
  assert.deepStrictEqual(fs.readdirSync(d), []);
});

test('offset cache: a growing file is read from the offset, an id seen again is not double counted', (t) => {
  const f = path.join(tmp(t), 's.jsonl');
  const cache = new Map();
  fs.writeFileSync(f, asst('m1', 'test-model-a', [1, 0, 0, 5]));
  const a = readUsage(f, cache);
  assert.strictEqual(a.bytes_read, fs.statSync(f).size);
  const size1 = fs.statSync(f).size;
  fs.appendFileSync(f, asst('m1', 'test-model-a', [1, 0, 0, 9]) + asst('m2', 'test-model-a', [2, 0, 0, 1]));
  const b = readUsage(f, cache);
  assert.strictEqual(b.bytes_read, fs.statSync(f).size - size1, 'only the new bytes are read');
  assert.strictEqual(b.messages, 2);
  assert.deepStrictEqual(b.tokens, { input: 3, output: 10, cache_read: 0, cache_creation: 0 });
  assert.strictEqual(readUsage(f, cache).bytes_read, 0);
  fs.writeFileSync(f, asst('m9', 'test-model-a', [4, 0, 0, 4])); // truncated and rewritten: start over
  const c = readUsage(f, cache);
  assert.strictEqual(c.messages, 1);
  assert.strictEqual(c.tokens.input, 4);
});

test('sessionFileOf: the launch marker names the file; another run or epoch does not', (t) => {
  const d = tmp(t);
  const run = { id: 'r1', epoch: 2 };
  fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: 'r1', epoch: 2, session_id: 's', session_file: FIX }));
  assert.strictEqual(sessionFileOf(d, run), FIX);
  assert.strictEqual(sessionFileOf(d, { id: 'r1', epoch: 3 }), null);
  fs.rmSync(`${d}/run-start.json`);
  fs.writeFileSync(`${d}/run.json`, JSON.stringify({ run_id: 'r1', orchestrator: { interactive: { session_file: FIX } } }));
  assert.strictEqual(sessionFileOf(d, run), FIX);
});

test('agents row: tokens from the transcript, "no rate" note for an unknown model, row untouched when no transcript', (t) => {
  const d = tmp(t);
  fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: 'r1', epoch: 1, session_file: FIX }));
  const row = { id: 'orchestrator', model: null, context_tokens: null, cost_usd: null };
  fillFromTranscript(row, d, { id: 'r1', epoch: 1 }, new Map());
  assert.strictEqual(row.context_tokens, 1203);
  assert.strictEqual(row.cost_usd, null);
  assert.match(row.cost_note, /no rate for test-model-a/);
  assert.strictEqual(row.transcript_usage.messages, 3);
  const bare = { context_tokens: null, cost_usd: null };
  fillFromTranscript(bare, tmp(t), { id: 'r1', epoch: 1 }, new Map());
  assert.deepStrictEqual(bare, { context_tokens: null, cost_usd: null });
  const streamed = { context_tokens: 99, cost_usd: 1.5 }; // the stream already gave usage: the transcript is not consulted
  fillFromTranscript(streamed, d, { id: 'r1', epoch: 1 }, new Map());
  assert.deepStrictEqual(streamed, { context_tokens: 99, cost_usd: 1.5 });
});
