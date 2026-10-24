'use strict';
// Parsers against stream lines captured from the real binaries, not against invented ones.
// Fixtures were written by tests/run/measure/capture-fixtures.cjs:
//   claude-stream.jsonl  Claude Code 2.1.258, -p --input-format stream-json, two user messages
//   codex-stream.jsonl   Codex CLI 0.153.4, exec --json, one turn with a command_execution

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createParser, contextTokensOf } = require('../../src/run/parsers.cjs');

const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8').trim().split('\n');

function runAll(substrate, lines) {
  const p = createParser(substrate);
  const events = [];
  for (const l of lines) for (const e of p.pushLine(l)) events.push(e);
  return { p, events };
}
const kinds = (events) => events.map((e) => e.kind);

test('the Claude Code fixture yields the whole vocabulary and nothing outside it', () => {
  const { events } = runAll('claude-code', fixture('claude-stream.jsonl'));
  const allowed = new Set(['ready', 'tool_use', 'tool_result', 'assistant_text', 'turn_end', 'turn_failed', 'raw']);
  for (const k of kinds(events)) assert.ok(allowed.has(k), 'unexpected event kind ' + k);
  assert.ok(events.some((e) => e.kind === 'ready'));
  assert.ok(events.some((e) => e.kind === 'tool_use' && e.tool === 'Read'));
  assert.ok(events.some((e) => e.kind === 'tool_result' && e.tool === 'Read' && e.bytes > 0));
  assert.ok(events.some((e) => e.kind === 'assistant_text' && e.text.length > 0));
  assert.equal(events.filter((e) => e.kind === 'turn_end').length, 2);
});

test('a second system/init for the same session id is a repeat, not a restart (ADR 0008 §5)', () => {
  const { events } = runAll('claude-code', fixture('claude-stream.jsonl'));
  const readies = events.filter((e) => e.kind === 'ready');
  assert.equal(readies.length, 2, 'the real binary emits one init per user message');
  assert.equal(readies[0].repeat, false);
  assert.equal(readies[1].repeat, true, 'same session id, so not a restart');
  assert.equal(readies[0].session_id, readies[1].session_id);
});

test('turns the harness asked for are not externally triggered; an unsolicited one is', () => {
  const lines = fixture('claude-stream.jsonl');
  const p = createParser('claude-code');
  p.noteStdinWrite();
  p.noteStdinWrite(); // the two messages the capture script wrote
  const events = [];
  for (const l of lines) for (const e of p.pushLine(l)) events.push(e);
  const ends = events.filter((e) => e.kind === 'turn_end');
  assert.deepEqual(ends.map((e) => e.externally_triggered), [false, false]);

  // A third result with no stdin write behind it is what an inbound cross-session message looks
  // like: a whole turn the parent never asked for.
  const extra = p.pushLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.03, usage: { input_tokens: 1, output_tokens: 1 } }));
  assert.equal(extra[0].externally_triggered, true);
});

test('per-call usage comes from assistant events, and result.usage sums one turn only', () => {
  const lines = fixture('claude-stream.jsonl');
  const { events } = runAll('claude-code', lines);
  const asst = events.filter((e) => e.kind === 'assistant_text');
  assert.ok(asst.length >= 1);
  assert.ok(asst.every((e) => e.context_tokens > 0), 'every assistant text carries a per-call context size');

  // The receipt for the accounting rule in manager.onTurnEnd: turn 2's result usage is smaller
  // than turn 1's, so result.usage is per turn; total_cost_usd rises, so cost is cumulative.
  const raws = lines.map((l) => JSON.parse(l)).filter((j) => j.type === 'result');
  assert.equal(raws.length, 2);
  assert.ok(raws[1].usage.cache_read_input_tokens < raws[0].usage.cache_read_input_tokens);
  assert.ok(raws[1].total_cost_usd > raws[0].total_cost_usd);

  // And result.usage equals the sum of that turn's assistant iterations, which is exactly why it
  // cannot be used for the per-call context (ADR 0007 §3).
  const turn1Asst = lines.map((l) => JSON.parse(l)).filter((j) => j.type === 'assistant');
  const distinct = new Map();
  for (const a of turn1Asst) if (a.message && a.message.usage) distinct.set(a.request_id, a.message.usage);
  const sumRead = [...distinct.values()].slice(0, 2).reduce((s, u) => s + u.cache_read_input_tokens, 0);
  assert.equal(sumRead, raws[0].usage.cache_read_input_tokens);
});

test('thinking blocks and system/thinking_tokens do not become assistant text', () => {
  const { events } = runAll('claude-code', fixture('claude-stream.jsonl'));
  for (const e of events.filter((x) => x.kind === 'assistant_text')) {
    assert.ok(!/^\{/.test(e.text), 'assistant text is text, not a serialised block');
  }
  assert.ok(events.some((e) => e.kind === 'raw' && /thinking_tokens/.test(e.raw_type || '')));
});

test('the Codex fixture maps thread.started, command_execution and turn.completed', () => {
  const { events } = runAll('codex', fixture('codex-stream.jsonl'));
  const ready = events.find((e) => e.kind === 'ready');
  assert.ok(ready && /^[0-9a-f-]{36}$/.test(ready.session_id));
  assert.equal(ready.repeat, false);
  assert.ok(events.some((e) => e.kind === 'tool_use' && e.tool === 'command_execution'));
  assert.ok(events.some((e) => e.kind === 'tool_result' && e.bytes > 0));
  const texts = events.filter((e) => e.kind === 'assistant_text');
  assert.ok(texts.length >= 1);
  const end = events.find((e) => e.kind === 'turn_end');
  assert.ok(end, 'turn.completed becomes turn_end');
  assert.equal(end.usage.output_tokens, 67);
  assert.equal(end.text, texts[texts.length - 1].text, 'the last agent_message is the turn text');
});

test('Codex context tokens do not double-count its cached subset', () => {
  assert.equal(contextTokensOf({ input_tokens: 32511, cached_input_tokens: 28288, output_tokens: 67 }), 32511);
  assert.equal(contextTokensOf({ input_tokens: 10, cache_read_input_tokens: 29740, cache_creation_input_tokens: 133 }), 29883);
  assert.equal(contextTokensOf(null), null);
});

test('turn.failed becomes turn_failed and a non-JSON line becomes raw', () => {
  const p = createParser('codex');
  const [f] = p.pushLine(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }));
  assert.equal(f.kind, 'turn_failed');
  assert.equal(f.error.message, 'boom');
  const [r] = p.pushLine('not json at all');
  assert.equal(r.kind, 'raw');
  assert.equal(r.line, 'not json at all');
});

test('pushChunk splits on newlines across chunk boundaries and returns the raw lines', () => {
  const p = createParser('claude-code');
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' });
  const a = p.pushChunk(Buffer.from(line.slice(0, 10)));
  assert.deepEqual(a.lines, []);
  const b = p.pushChunk(Buffer.from(line.slice(10) + '\n'));
  assert.deepEqual(b.lines, [line]);
  assert.equal(b.events[0].kind, 'ready');
});

test('a multi-byte character split across two chunks is decoded, not corrupted', () => {
  const p = createParser('claude-code');
  const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'belay — held', usage: {} }) + '\n';
  const buf = Buffer.from(line, 'utf8');
  // Cut inside the three bytes of the em dash: decoding either half on its own yields U+FFFD.
  const cut = buf.indexOf(Buffer.from('—', 'utf8')) + 1;
  const a = p.pushChunk(buf.subarray(0, cut));
  assert.deepEqual(a.lines, [], 'no complete line yet');
  const b = p.pushChunk(buf.subarray(cut));
  assert.equal(b.lines.length, 1);
  assert.ok(!b.lines[0].includes('�'), 'the line reached stream.jsonl intact: ' + b.lines[0]);
  assert.equal(b.events[0].kind, 'turn_end', 'a corrupted result line would have been raw, losing the turn');
  assert.equal(b.events[0].text, 'belay — held');
});

test('flush emits the partial last line a killed worker left behind', () => {
  const p = createParser('claude-code');
  const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: {} });
  // No trailing newline: the worker was killed mid-write, which is exactly when the last line
  // matters most. Nothing comes out until the stream ends, and then it comes out whole.
  assert.deepEqual(p.pushChunk(Buffer.from(line, 'utf8')), { lines: [], events: [] });
  const f = p.flush();
  assert.deepEqual(f.lines, [line]);
  assert.equal(f.events[0].kind, 'turn_end');
  // Flushing twice yields nothing: the buffer is emptied, not re-read.
  assert.deepEqual(p.flush(), { lines: [], events: [] });
  // A stream that ended cleanly flushes nothing at all.
  const q = createParser('codex');
  q.pushChunk(Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\n', 'utf8'));
  assert.deepEqual(q.flush(), { lines: [], events: [] });
});

test('a 5-minute cache write is flagged, because it means the TTL clause was not honoured', () => {
  const p = createParser('claude-code');
  const evs = p.pushLine(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } } },
  }));
  assert.equal(evs[0].five_minute_cache_write, true);
});

// ------------------------------------------------ 5b-2: correlation by system/init order

const initLine = () => JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' });
const resultLine = (text) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, usage: {} });

test('parser: a write then an init then a result is the write\'s answer, and the event names the write', () => {
  const p = createParser('claude-code');
  const idx = p.noteStdinWrite();
  const [ready] = p.pushLine(initLine());
  assert.equal(ready.answers_write, idx, 'the ready event names which write this init answers');
  const [end] = p.pushLine(resultLine('a'));
  assert.equal(end.answers_write, idx);
  assert.equal(end.correlation, 'init-order');
  assert.equal(end.externally_triggered, false);
});

test('parser: an init that precedes a write cannot answer it, so its result is externally triggered while the write stays unanswered', () => {
  const p = createParser('claude-code');
  const [ready] = p.pushLine(initLine()); // no write yet: this init cannot answer anything
  assert.equal(ready.answers_write, null);
  const idx = p.noteStdinWrite(); // the write happens after the init
  const [end] = p.pushLine(resultLine('a'));
  assert.equal(end.answers_write, null);
  assert.equal(end.externally_triggered, true);
  assert.equal(p.unansweredWrites.length, 1, 'the write made after the init cannot be matched by it');
  assert.equal(p.unansweredWrites[0].index, idx);
});

test('parser: two writes and two turns correlate in order', () => {
  const p = createParser('claude-code');
  const i1 = p.noteStdinWrite();
  const i2 = p.noteStdinWrite();
  p.pushLine(initLine());
  const [e1] = p.pushLine(resultLine('a'));
  assert.equal(e1.answers_write, i1);
  assert.equal(e1.externally_triggered, false);
  p.pushLine(initLine());
  const [e2] = p.pushLine(resultLine('b'));
  assert.equal(e2.answers_write, i2);
  assert.equal(e2.externally_triggered, false);
});

test("parser: a result with no init since the last result falls back to the count rule and says so", () => {
  const p = createParser('claude-code');
  p.pushLine(initLine()); // answers nothing (no write yet); the result below shifts it off openTurns
  p.pushLine(resultLine('a'));
  const w = p.noteStdinWrite(); // written after that result, with no init since
  const [e] = p.pushLine(resultLine('b')); // no init since the last result: falls back to the count rule
  assert.equal(e.correlation, 'count');
  assert.equal(e.answers_write, w);
  assert.equal(e.externally_triggered, false);
});

// ------------------------------------------------ 5b-3: opened turns are a queue, not a single slot

test('parser: two inits before the first result answer two writes in order, and neither match is lost', () => {
  const p = createParser('claude-code');
  const i1 = p.noteStdinWrite();
  const i2 = p.noteStdinWrite();
  p.pushLine(initLine());
  p.pushLine(initLine());
  const [e1] = p.pushLine(resultLine('a'));
  assert.equal(e1.answers_write, i1, "the first result must answer the first write, not the second");
  assert.equal(e1.correlation, 'init-order');
  assert.equal(e1.externally_triggered, false);
  assert.equal(e1.open_turns_after, 1, 'one open init still queued behind this one');
  const [e2] = p.pushLine(resultLine('b'));
  assert.equal(e2.answers_write, i2, "the second result must still answer the second write, not be lost");
  assert.equal(e2.correlation, 'init-order');
  assert.equal(e2.externally_triggered, false);
  assert.equal(e2.open_turns_after, 0);
});

test("parser: an unsolicited init that opens before the harness's answer arrives does not steal the write", () => {
  const p = createParser('claude-code');
  const idx = p.noteStdinWrite();
  p.pushLine(initLine()); // init A: claims the one write on offer
  p.pushLine(initLine()); // init B: unsolicited — no write left for it to claim
  const [a] = p.pushLine(resultLine('a'));
  assert.equal(a.answers_write, idx, "A answers the write it claimed");
  assert.equal(a.externally_triggered, false);
  const [b] = p.pushLine(resultLine('b'));
  assert.equal(b.answers_write, null, "B claimed nothing and must not inherit A's write");
  assert.equal(b.externally_triggered, true);
});

// ------------------------------------------------ 6f: ADR 0023 decision 8, amendment 3 decision 7

test('parser: a cancelled command_lifecycle for a known write emits write_done with state cancelled, and a turn_end carries the result subtype', () => {
  const p = createParser('claude-code');
  const idx = p.noteStdinWrite('uuid-cancel-1');
  const [ev] = p.pushLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: 'uuid-cancel-1', state: 'cancelled' }));
  assert.equal(ev.kind, 'write_done', 'a cancelled lifecycle must emit write_done exactly as completed does');
  assert.equal(ev.answers_write, idx);
  assert.equal(ev.command_uuid, 'uuid-cancel-1');
  assert.equal(ev.state, 'cancelled');

  // The interrupted turn's own result: the substrate's own word, not inferred from is_error.
  const [end] = p.pushLine(JSON.stringify({
    type: 'result', subtype: 'error_during_execution', is_error: true, result: '', usage: {},
  }));
  assert.equal(end.kind, 'turn_end');
  assert.equal(end.subtype, 'error_during_execution');

  // A completed lifecycle keeps its own state, unaffected by decision 8's cancelled branch.
  const p2 = createParser('claude-code');
  const idx2 = p2.noteStdinWrite('uuid-complete-1');
  const [ev2] = p2.pushLine(JSON.stringify({ type: 'command_lifecycle', command_uuid: 'uuid-complete-1', state: 'completed' }));
  assert.equal(ev2.kind, 'write_done');
  assert.equal(ev2.answers_write, idx2);
  assert.equal(ev2.state, 'completed');
});

test('ADR 0058 (B7): a Codex command_execution tool_use carries its command, so two commands hash apart in the digest', () => {
  const { createParser } = require('../../src/run/parsers.cjs');
  const W = require('../../src/run/worker.cjs');
  const p = createParser('codex');
  const line = (id, command) => JSON.stringify({ type: 'item.started', item: { id, type: 'command_execution', command, aggregated_output: '', status: 'in_progress' } });
  const uses = [line('i1', 'npm test'), line('i2', 'git status')].flatMap((l) => p.pushLine(l)).filter((e) => e.kind === 'tool_use');
  assert.deepStrictEqual(uses.map((e) => e.args), [{ command: 'npm test' }, { command: 'git status' }]);
  assert.notStrictEqual(W.sha12(uses[0].args), W.sha12(uses[1].args));
});
