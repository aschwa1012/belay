'use strict';
// cost-estimate.test.cjs — a worker whose life ends with no `result` event is not recorded as if it cost nothing: a stopped or dead
// row carries what the assistant messages no result line reported cost, in its OWN columns (cost_estimate, cost_source), labelled
// (ADR 0068, proposed). cost_usd and the token columns stay what Claude Code reported. Real core; the stream is a file the test
// writes under the worker directory. The first rows are written by the call the adapter uses (worker.write); the run.end and
// run.attach cases are closes that no adapter wrote.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { estimateLines, estimateStream } = core('cost-estimate.cjs');

let dir, c;
before(async () => {
  dir = sandbox();
  c = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-cost' }), embed: false });
  await c.run.attach({ adapter_pid: process.pid });
});
after(async () => { await c.shutdownOwner(); await c.close(); cleanup(dir); });

// Sonnet 5.5 at 2 / 10 / 0.20 per million: 1,000,000 in, 100,000 out and 1,000,000 cache read cost 2 + 1 + 0.2.
const msg = (id, u = {}) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content: [], usage: { input_tokens: 1000000, output_tokens: 100000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 0, ...u } } });
const result = (total) => JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: total, usage: {} });
const init = (session) => JSON.stringify({ type: 'system', subtype: 'init', session_id: session });
const MSG_USD = 3.2;

function stream(id, lines) {
  const d = path.join(dir, 'workers', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'stream.jsonl'), lines.join('\n') + '\n');
}
const live = (id, extra = {}) => ({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now(), ...extra });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const zero = { cost_usd: 0, turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
const die = (id, extra = {}) => c.worker.write({ id, state: 'dead', pid: deadPid(), exit_code: 1, death_established_by: 'exit-event', ...extra });

test('a worker that died mid-turn with no result keeps its reported figures at zero and carries a labelled estimate beside them', async () => {
  stream('k1', [init('s1'), msg('m1'), msg('m1'), msg('m2')]); // m1 streamed twice: counted once
  await c.worker.write(live('k1', zero));
  const row = await die('k1', zero);
  assert.deepStrictEqual([row.cost_usd, row.input_tokens, row.cache_read_tokens, row.turns], [0, 0, 0, 0], 'the reported columns are not touched');
  assert.strictEqual(row.cost_source, 'transcript_estimate');
  near(row.cost_estimate.usd, 2 * MSG_USD);
  assert.deepStrictEqual([row.cost_estimate.source, row.cost_estimate.messages, row.cost_estimate.input_tokens, row.cost_estimate.cache_read_tokens], ['transcript_estimate', 2, 2000000, 2000000]);
  // The exit code filled in later restates the row: the estimate is recomputed, not added again.
  const fill = await c.worker.write({ id: 'k1', state: 'dead', exit_code: 1, death_established_by: 'pid-poll+exit-event', ...zero });
  near(fill.cost_estimate.usd, 2 * MSG_USD);
  assert.strictEqual(fill.cost_usd, 0);
});

test('only the messages after the last result line are estimated; the reported cost stays what Claude Code said', async () => {
  stream('k2', [init('s1'), msg('a1'), result(7.5), msg('a2'), 'not json', msg('a3', { output_tokens: 0 })]);
  await c.worker.write(live('k2', { cost_usd: 7.5, turns: 1 }));
  const row = await c.worker.write({ id: 'k2', state: 'stopped', pid: deadPid(), exit_code: 0, death_established_by: 'exit-event', cost_usd: 7.5, turns: 1 });
  near(row.cost_estimate.usd, MSG_USD + 2.2);
  assert.strictEqual(row.cost_usd, 7.5);
  assert.strictEqual(row.cost_source, 'transcript_estimate');
});

test('a worker whose last line is a result carries no estimate and no label', async () => {
  stream('k3', [init('s1'), msg('b1'), result(4.2)]);
  await c.worker.write(live('k3', { cost_usd: 4.2, turns: 1 }));
  const row = await c.worker.write({ id: 'k3', state: 'stopped', pid: deadPid(), exit_code: 0, death_established_by: 'exit-event', cost_usd: 4.2, turns: 1 });
  assert.deepStrictEqual([row.cost_usd, row.cost_source, row.cost_estimate], [4.2, null, null]);
});

test('a live row carries no estimate: a later life that runs clears the earlier one', async () => {
  stream('k4', [init('s1'), msg('c1')]);
  await c.worker.write(live('k4'));
  const dead = await die('k4', zero);
  near(dead.cost_estimate.usd, MSG_USD);
  const again = await c.worker.write(live('k4', { ...zero, cost_usd: 0.5, turns: 1, input_tokens: 10, output_tokens: 5 }));
  assert.deepStrictEqual([again.cost_usd, again.cost_source, again.cost_estimate, again.input_tokens], [0.5, null, null, 10]);
});

test('a model with no price keeps its tokens and no dollars; a missing stream is left alone', async () => {
  const unknown = JSON.stringify({ type: 'assistant', message: { id: 'u1', model: 'mystery', usage: { input_tokens: 5, output_tokens: 6 } } });
  assert.deepStrictEqual(estimateLines([unknown]), { messages: 1, usd: null, tokens: { input: 5, output: 6, cache_read: 0, cache_creation: 0 }, unpriced_models: ['mystery'] });
  assert.strictEqual(estimateLines(['{"type":"system"}']), null);
  const none = await c.worker.write({ id: 'k6', substrate: 'claude-code', pid: deadPid(), state: 'dead', exit_code: 1, death_established_by: 'exit-event', ...zero });
  assert.deepStrictEqual([none.cost_usd, none.cost_source, none.cost_estimate], [0, null, null]);
});

test('the cost base the adapter writes is stored and survives a restating write', async () => {
  stream('kb', [init('s1'), result(2)]);
  await c.worker.write(live('kb', { cost_usd: 5, cost_base: 3, turns: 1 }));
  const row = await die('kb', { cost_usd: 5, cost_base: 3, turns: 1 });
  assert.deepStrictEqual([row.cost_usd, row.cost_base], [5, 3]);
});

test('run.attach marks a crashed adapter\'s dead-pid row dead with the same estimate', async () => {
  stream('ka', [init('s1'), msg('e1')]);
  await c.worker.write(live('ka', zero));
  await c.worker.write({ id: 'ka', state: 'stopping', pid: deadPid(), ...zero });
  const re = await c.run.attach({ adapter_pid: process.pid });
  assert.ok(re.workers_marked_dead.includes('ka'));
  const row = await c.worker.get({ worker_id: 'ka' });
  assert.strictEqual(row.state, 'dead');
  near(row.cost_estimate.usd, MSG_USD);
  assert.strictEqual(row.cost_usd, 0);
});

test('run.end closes a dead-pid row the adapter never settled, with the same estimate', async () => {
  stream('k5', [init('s1'), msg('d1'), msg('d2')]);
  await c.worker.write(live('k5', zero));
  await c.worker.write({ id: 'k5', state: 'stopping', pid: deadPid(), ...zero });
  const ended = await c.run.end({ exit_reason: 'test' });
  assert.ok(ended.workers_marked_dead.some((m) => m.worker_id === 'k5'));
  const row = await c.worker.get({ worker_id: 'k5' });
  assert.strictEqual(row.state, 'dead');
  near(row.cost_estimate.usd, 2 * MSG_USD);
  assert.strictEqual(row.cost_usd, 0);
});

// The stream-level rules, per life. These call the estimator on a file, as the core does on a terminal write.
const estimate = (id, lines) => { stream(id, lines); return estimateStream(path.join(dir, 'workers', id, 'stream.jsonl')); };

test('lives: a graceful resume (the new life carries the session total) double counts nothing', () => {
  assert.strictEqual(estimate('l1', [init('s1'), msg('x1'), result(5), init('s1'), msg('x2'), result(8)]), null);
  // The resumed life was cut mid-turn: only its own unreported message counts.
  const e = estimate('l1b', [init('s1'), msg('x1'), result(5), init('s1'), msg('x2')]);
  near(e.usd, MSG_USD); assert.strictEqual(e.lives, 1);
});

test('lives: a hard-killed life resumed in the same session counts only what the resumed life\'s total does not reach (unmeasured)', () => {
  // Resumed life's first total 6.4: it reaches the killed life's 3.2, so the tail is covered.
  assert.strictEqual(estimate('l2', [init('s1'), msg('y1'), init('s1'), msg('y2'), result(6.4)]), null);
  // First total 1.0 is below the 3.2 the killed life spent: 2.2 of it is not carried.
  const e = estimate('l2b', [init('s1'), msg('y1'), init('s1'), msg('y2'), result(1.0)]);
  near(e.usd, 2.2); assert.deepStrictEqual([e.lives, e.partial_lives], [1, 1]);
});

test('lives: a fresh session starts at zero, so the killed life before it counts whole', () => {
  const e = estimate('l3', [init('s1'), msg('z1'), init('s2'), msg('z2'), result(1)]);
  near(e.usd, MSG_USD); assert.strictEqual(e.lives, 1);
});

test('lives: several killed lives add up, each once', () => {
  const e = estimate('l4', [init('s1'), msg('p1'), init('s2'), msg('p2'), msg('p2'), init('s3'), msg('p3')]);
  near(e.usd, 3 * MSG_USD); assert.deepStrictEqual([e.messages, e.lives, e.partial_lives], [3, 3, 0]);
});

test('a long stream is read from its end within the cap, and says when it stopped short', () => {
  const lines = [init('s1')];
  for (let i = 0; i < 200; i += 1) lines.push(msg(`big${i}`, { output_tokens: 1 }));
  stream('l5', lines);
  const p = path.join(dir, 'workers', 'l5', 'stream.jsonl');
  const whole = estimateStream(p);
  assert.deepStrictEqual([whole.messages, whole.truncated], [200, false]);
  // Nine 1 MB filler lines put the first message more than two 4 MB chunks from the end.
  const pad = JSON.stringify({ type: 'user', pad: 'x'.repeat(1024 * 1024) });
  stream('l6', [init('s1'), msg('far'), ...Array(9).fill(pad), msg('near')]);
  const q = path.join(dir, 'workers', 'l6', 'stream.jsonl');
  assert.deepStrictEqual([estimateStream(q).messages, estimateStream(q).truncated], [2, false]);
  const cut = estimateStream(q, undefined, 4 * 1024 * 1024); // the cap: one chunk, then stop
  assert.deepStrictEqual([cut.messages, cut.truncated], [1, true]);
});

test('a stream whose last result is followed by more than the scan cap of other lines is marked truncated, not left blank', () => {
  const pad = JSON.stringify({ type: 'user', pad: 'x'.repeat(1024 * 1024) });
  const e = estimate('l7', [init('s1'), msg('old'), result(1), ...Array(17).fill(pad)]);
  assert.deepStrictEqual([e.truncated, e.messages, e.usd, e.lives], [true, 0, null, 0]);
  // A result inside the window means the newest turn's tail is known to be empty: no estimate, no mark.
  assert.strictEqual(estimate('l8', [init('s1'), ...Array(17).fill(pad), msg('old'), result(1)]), null);
});
