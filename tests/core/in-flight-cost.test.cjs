'use strict';
// in-flight-cost.test.cjs — the estimate of a turn that has not ended (ADR 0066 amendment, proposed): it grows as the turn's
// assistant messages arrive, is labelled and kept apart from the reported cost, is replaced by the reported figure when the turn's
// `result` line arrives, and is counted by the budget only when the run's lever is on. Real core and real stream files; fake lines.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const IF = core('inflight-cost.cjs');
const RB = core('run-budget.cjs');

// Sonnet 5.5: 2 per million in, 10 per million out. One message of 100,000 output tokens costs $1.00.
const msg = (id, out = 100000) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const result = (total) => JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: total, usage: {} });
const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

let dir, c;
before(async () => {
  dir = sandbox();
  c = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-live' }), embed: false });
  await c.run.attach({ adapter_pid: process.pid, budget_usd: 10 });
});
after(async () => { await c.shutdownOwner(); await c.close(); cleanup(dir); });

const streamOf = (id) => path.join(dir, 'workers', id, 'stream.jsonl');
const put = (id, lines) => { fs.mkdirSync(path.dirname(streamOf(id)), { recursive: true }); fs.writeFileSync(streamOf(id), lines.join('\n') + '\n'); };
const add = (id, lines) => fs.appendFileSync(streamOf(id), lines.join('\n') + '\n');
const live = (id, extra = {}) => ({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now(), cost_usd: 0, turns: 0, ...extra });

test('the accumulator grows while the turn runs and is emptied by the turn result line', () => {
  const a = IF.createAccumulator();
  assert.strictEqual(a.snapshot(), null);
  a.feed(init); a.feed(msg('m1'));
  near(a.snapshot().usd, 1);
  a.feed(msg('m1', 200000)); // the same API message streamed again: counted once, at its last count
  near(a.snapshot().usd, 2);
  a.feed(msg('m2'));
  near(a.snapshot().usd, 3);
  a.feed(result(3.1)); // the reported figure takes over
  assert.strictEqual(a.snapshot(), null);
  a.feed(msg('m3'));
  near(a.snapshot().usd, 1);
});

test('a stream file read from its tail gives the turn in flight and nothing once the result is written', () => {
  put('f1', [init, msg('a1'), result(1.0), init, msg('b1')]); // turn one ended; turn two is in flight
  near(IF.tailEstimate(streamOf('f1')).usd, 1);
  add('f1', [msg('b2')]);
  near(IF.tailEstimate(streamOf('f1')).usd, 2);
  add('f1', [result(3.0)]);
  assert.strictEqual(IF.tailEstimate(streamOf('f1')), null);
  assert.strictEqual(IF.tailEstimate(streamOf('absent')), null);
});

test('the tail read is bounded: a turn longer than the cap says it is truncated rather than reading the whole stream', () => {
  const pad = (i) => msg(`c${i}`).replace('"content":[]', `"content":["${'x'.repeat(20000)}"]`); // 40 lines of about 20 KB: 800 KB, past the 256 KB read chunk
  put('f2', [init, ...Array.from({ length: 40 }, (_, i) => pad(i))]);
  const e = IF.tailEstimate(streamOf('f2'), undefined, 256 * 1024);
  assert.strictEqual(e.truncated, true);
  assert.ok(e.messages > 0 && e.messages < 40);
});

test('status shows a live worker in-flight estimate beside its reported cost, and the run block labels it and does not count it by default', async () => {
  put('w1', [init, msg('a1'), result(2.0), init, msg('b1'), msg('b2'), msg('b3')]);
  await c.worker.write(live('w1', { cost_usd: 2, turns: 1 }));
  const st = await c.status.get();
  const w = st.workers.find((x) => x.id === 'w1');
  assert.strictEqual(w.cost_usd, 2);
  near(w.cost_in_flight_usd, 3);
  assert.strictEqual(w.cost_in_flight_source, 'in flight (estimate)');
  const b = st.run.budget;
  assert.strictEqual(b.basis, 'reported');
  near(b.in_flight.usd, 3);
  assert.strictEqual(b.in_flight.counted, false);
  near(b.spent_usd, 0); // the ledger holds nothing yet; the estimate is not in it
  assert.match(RB.textOf(b), /\$3\.00 in flight \(estimate\), not counted/);
});

test('the turn ends: the in-flight figure is gone and the reported cost carries the turn', async () => {
  add('w1', [result(5.0)]);
  await c.worker.write(live('w1', { cost_usd: 5, turns: 2 }));
  const st = await c.status.get();
  const w = st.workers.find((x) => x.id === 'w1');
  assert.deepStrictEqual([w.cost_usd, w.cost_in_flight_usd, w.cost_in_flight_source], [5, null, null]);
  assert.strictEqual(st.run.budget.in_flight.usd, 0);
});

test('usage.spend with in_flight sums the live workers estimate beside the ledger, and never into it; a stopped worker has none', async () => {
  put('w2', [init, msg('x1')]);
  await c.worker.write(live('w2'));
  put('w3', [init, msg('y1')]);
  await c.worker.write(live('w3'));
  await c.worker.write({ id: 'w3', state: 'stopped', pid: 999999, exit_code: 0, death_established_by: 'exit-event', cost_usd: 0, turns: 0 });
  const plain = await c.usage.spend({});
  const s = await c.usage.spend({ in_flight: true });
  assert.strictEqual(plain.in_flight_usd, undefined);
  near(s.in_flight_usd, 1);
  assert.strictEqual(s.in_flight_workers, 1);
  assert.strictEqual(s.usd, plain.usd);
});

test('blockOf counts the estimate in spent only when the record says the lever is on, and says so in the text', () => {
  const row = (rec, extra = {}) => ({ budget_usd: 10, ended_at: null, budget: JSON.stringify({ counts_in_flight: rec, orchestrator: { counted: true, usd: 1, in_flight_usd: 2 } }), ...extra });
  const off = RB.blockOf(row(false), { usd: 3, unknown_turns: 0 }, { usd: 1 });
  const on = RB.blockOf(row(true), { usd: 3, unknown_turns: 0 }, { usd: 1 });
  assert.deepStrictEqual([off.spent_usd, off.basis, off.in_flight.usd], [4, 'reported', 3]);
  assert.deepStrictEqual([on.spent_usd, on.basis, on.in_flight.counted], [7, 'reported + in flight (estimate)', true]);
  assert.match(RB.textOf(on), /^\$7\.00 of \$10\.00 reported, \$1\.00 of it the orchestrator's \(under\); \$3\.00 of it in flight \(estimate\), counted$/);
  assert.strictEqual(RB.blockOf(row(true, { ended_at: 5 }), { usd: 3, unknown_turns: 0 }, { usd: 1 }).in_flight.usd, 0, 'an ended run has no turn in flight');
});
