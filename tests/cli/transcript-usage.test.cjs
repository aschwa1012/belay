'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readUsage, sessionFileOf, PRICES } = require('../../src/cli/transcript-usage.cjs');
const { fillFromTranscript } = require('../../src/cli/cmd-agents.cjs');

const FIX = path.join(__dirname, '..', 'fixtures', 'transcript-usage', 'session.jsonl');
const RATES = { 'test-model-a': { input: 10, output: 100, cache_read: 1, cache_write_5m: 20, cache_write_1h: 40 } }; // a test rate, not a real one
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tu-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const asst = (id, model, u, extra = {}) => `${JSON.stringify({ type: 'assistant', ...extra, message: { model, id, usage: { input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3] } } })}\n`;

// One message with the split cache writes; the same tokens priced per model, summed by hand below.
const one = (model, u, split = true) => {
  const usage = { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] + u[4] };
  if (split) usage.cache_creation = { ephemeral_5m_input_tokens: u[3], ephemeral_1h_input_tokens: u[4] };
  return `${JSON.stringify({ type: 'assistant', message: { model, id: `m-${model}`, usage } })}
`;
};
const usdOf = (t, model, u, split) => {
  const f = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(f, one(model, u, split));
  return readUsage(f);
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const TOK = [1000, 2000, 10000, 3000, 5000]; // input, output, cache_read, cache_5m, cache_1h

test('shipped rates: opus 5.5, hand-computed', (t) => { // 4000 + 40000 + 2000 + 15000 + 40000 = 101000 / 1e6
  const u = usdOf(t, 'claude-opus-5-5', TOK);
  near(u.cost_usd, 0.101);
  assert.strictEqual(u.cache_write_assumed_5m, 0);
});
test('shipped rates: sonnet 5.5, hand-computed', (t) => { near(usdOf(t, 'claude-sonnet-5-5', TOK).cost_usd, 0.0515); }); // 2000 + 20000 + 2000 + 7500 + 20000
test('shipped rates: fable 5.1, hand-computed', (t) => { near(usdOf(t, 'claude-fable-5-1', TOK).cost_usd, 0.25); }); // 10000 + 100000 + 2500 + 37500 + 100000
test('shipped rates: haiku 5.5 small prompt (19000 tokens)', (t) => { near(usdOf(t, 'claude-haiku-5-5', TOK).cost_usd, 0.002575); }); // 100 + 1000 + 100 + 375 + 1000
test('shipped rates: haiku 5.5 large prompt (159000 tokens), the higher tier', (t) => { // 500 + 5000 + 7500 + 1875 + 5000
  near(usdOf(t, 'claude-haiku-5-5', [1000, 2000, 150000, 3000, 5000]).cost_usd, 0.019875);
});
test('haiku tier boundary: 100000 prompt tokens is the low tier, 100001 the high', (t) => {
  near(usdOf(t, 'claude-haiku-5-5', [100000, 0, 0, 0, 0]).cost_usd, 0.01);
  near(usdOf(t, 'claude-haiku-5-5', [100001, 0, 0, 0, 0]).cost_usd, 0.0500005);
});
test('no 5m/1h split: all cache writes at the 5m rate, and the result says so', (t) => { // 8000 * 5 / 1e6
  const u = usdOf(t, 'claude-opus-5-5', [0, 0, 0, 3000, 5000], false);
  near(u.cost_usd, 0.04);
  assert.strictEqual(u.cache_write_assumed_5m, 1);
});
test('alias names and unlisted ids stay unpriced', (t) => {
  for (const m of ['opus', 'sonnet', 'claude-opus-5-5-x']) assert.strictEqual(usdOf(t, m, TOK).cost_usd, null, m);
});
test('a replaced id is re-priced, not added twice (haiku across the tier line)', (t) => {
  const f = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(f, one('claude-haiku-5-5', [1000, 1, 0, 0, 0]) + one('claude-haiku-5-5', [1000, 2000, 150000, 0, 0]));
  near(readUsage(f).cost_usd, (1000 * 0.5 + 2000 * 2.5 + 150000 * 0.05) / 1e6);
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

test('agents row: a priced model gets an estimated cost marked as transcript API rates', (t) => {
  const d = tmp(t);
  const f = path.join(d, 's.jsonl');
  fs.writeFileSync(f, one('claude-opus-5-5', TOK));
  fs.writeFileSync(`${d}/run-start.json`, JSON.stringify({ run_id: 'r1', epoch: 1, session_file: f }));
  const row = { id: 'orchestrator', model: null, context_tokens: null, cost_usd: null };
  fillFromTranscript(row, d, { id: 'r1', epoch: 1 }, new Map());
  near(row.cost_usd, 0.101);
  assert.strictEqual(row.cost_basis, 'transcript, API rates');
  assert.match(row.cost_source, /estimate/);
});
