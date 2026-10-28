'use strict';
// cost-estimate.test.cjs — a worker whose life ends with no `result` event is not recorded at $0: a stopped or dead row carries what
// the assistant messages after its last result line cost, labelled as an estimate (ADR 0062, proposed). Real core; the
// stream is a file the test writes under the worker directory. The first rows are written by the call the adapter uses
// (worker.write), the run.end case by the close that no adapter writes.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor, deadPid } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { estimateLines, tailLines } = core('cost-estimate.cjs');

let dir, c;
before(async () => {
  dir = sandbox();
  c = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-cost' }), embed: false });
  await c.run.attach({ adapter_pid: process.pid });
});
after(async () => { await c.shutdownOwner(); await c.close(); cleanup(dir); });

// Sonnet 5.5 at 2 / 10 / 0.20 per million: 1,000,000 in, 100,000 out and 1,000,000 cache read cost 2 + 1 + 0.2.
const msg = (id, u = {}) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content: [], usage: { input_tokens: 1000000, output_tokens: 100000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 0, ...u } } });
const result = (cost) => JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: cost, usage: {} });
const MSG_USD = 3.2;

function stream(id, lines) {
  const d = path.join(dir, 'workers', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'stream.jsonl'), lines.join('\n') + '\n');
}
const live = (id, extra = {}) => ({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now(), ...extra });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const zero = { cost_usd: 0, turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };

test('a worker that died mid-turn with no result is priced from its stream and labelled', async () => {
  stream('k1', ['{"type":"system","subtype":"init"}', msg('m1'), msg('m1'), msg('m2')]); // m1 streamed twice: counted once
  await c.worker.write(live('k1', zero));
  const row = await c.worker.write({ id: 'k1', state: 'dead', pid: deadPid(), exit_code: 1, death_established_by: 'exit-event', ...zero });
  near(row.cost_usd, 2 * MSG_USD);
  assert.strictEqual(row.cost_source, 'transcript_estimate');
  assert.strictEqual(row.input_tokens, 2000000);
  assert.strictEqual(row.cache_read_tokens, 2000000);
  assert.deepStrictEqual([row.cost_estimate.source, row.cost_estimate.messages], ['transcript_estimate', 2]);
  near(row.cost_estimate.usd, 2 * MSG_USD);
  assert.strictEqual(row.turns, 0, 'a turn that never ended is not a turn');
  // The exit code filled in later restates the row: the estimate is recomputed, not added again.
  const fill = await c.worker.write({ id: 'k1', state: 'dead', exit_code: 1, death_established_by: 'pid-poll+exit-event', ...zero });
  near(fill.cost_usd, 2 * MSG_USD);
  assert.strictEqual(fill.input_tokens, 2000000);
});

test('only the messages after the last result line are estimated, on top of the reported cost', async () => {
  stream('k2', [msg('a1'), result(7.5), msg('a2'), 'not json', msg('a3', { output_tokens: 0 })]);
  await c.worker.write(live('k2', { cost_usd: 7.5, turns: 1 }));
  const row = await c.worker.write({ id: 'k2', state: 'stopped', pid: deadPid(), exit_code: 0, death_established_by: 'exit-event', cost_usd: 7.5, turns: 1 });
  near(row.cost_estimate.usd, MSG_USD + 2.2);
  near(row.cost_usd, 7.5 + MSG_USD + 2.2);
  assert.strictEqual(row.cost_source, 'reported+transcript_estimate');
});

test('a worker whose last line is a result carries no estimate and no label', async () => {
  stream('k3', [msg('b1'), result(4.2)]);
  await c.worker.write(live('k3', { cost_usd: 4.2, turns: 1 }));
  const row = await c.worker.write({ id: 'k3', state: 'stopped', pid: deadPid(), exit_code: 0, death_established_by: 'exit-event', cost_usd: 4.2, turns: 1 });
  assert.deepStrictEqual([row.cost_usd, row.cost_source, row.cost_estimate], [4.2, null, null]);
});

test('a later life that reports supersedes the estimate: a live row is written without it', async () => {
  stream('k4', [msg('c1')]);
  await c.worker.write(live('k4'));
  const dead = await c.worker.write({ id: 'k4', state: 'dead', pid: deadPid(), exit_code: 1, death_established_by: 'exit-event', ...zero });
  near(dead.cost_usd, MSG_USD);
  const again = await c.worker.write(live('k4', { ...zero, cost_usd: 0.5, turns: 1, input_tokens: 10, output_tokens: 5 }));
  assert.deepStrictEqual([again.cost_usd, again.cost_source, again.cost_estimate, again.input_tokens], [0.5, null, null, 10]);
});

test('a model with no price keeps its tokens and no dollars; a missing stream is left alone', async () => {
  const unknown = JSON.stringify({ type: 'assistant', message: { id: 'u1', model: 'mystery', usage: { input_tokens: 5, output_tokens: 6 } } });
  assert.deepStrictEqual(estimateLines([unknown]), { messages: 1, usd: null, tokens: { input: 5, output: 6, cache_read: 0, cache_creation: 0 }, unpriced_models: ['mystery'] });
  assert.strictEqual(estimateLines(['{"type":"system"}']), null);
  assert.deepStrictEqual(tailLines(['x', result(1), 'y'].join('\n')), ['y']);
  const none = await c.worker.write({ id: 'k6', substrate: 'claude-code', pid: deadPid(), state: 'dead', exit_code: 1, death_established_by: 'exit-event', ...zero });
  assert.deepStrictEqual([none.cost_usd, none.cost_source, none.cost_estimate], [0, null, null]);
});

test('run.end closes a dead-pid row the adapter never settled, with the same estimate', async () => {
  stream('k5', [msg('d1'), msg('d2')]);
  await c.worker.write(live('k5', zero));
  await c.worker.write({ id: 'k5', state: 'stopping', pid: deadPid(), ...zero });
  const ended = await c.run.end({ exit_reason: 'test' });
  assert.ok(ended.workers_marked_dead.some((m) => m.worker_id === 'k5'));
  const row = await c.worker.get({ worker_id: 'k5' });
  assert.strictEqual(row.state, 'dead');
  near(row.cost_usd, 2 * MSG_USD);
  assert.strictEqual(row.cost_source, 'transcript_estimate');
});
