'use strict';
// in-flight-cost.test.cjs — the estimate of a turn that has not ended (ADR 0066 amendment, proposed): it grows as the turn's
// assistant messages arrive, is labelled and kept apart from the reported cost, is replaced by the reported figure when the turn's
// `result` line arrives, and is read by every reader from the figures the run process published, never from a stream.
// Real core and real stream files; fake lines.

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

let dir, c, op;
before(async () => {
  dir = sandbox();
  c = await openCore({ dataDir: dir, caller: callerFor('orchestrator', { run_id: 'run-live' }), embed: false });
  await c.run.attach({ adapter_pid: process.pid, budget_usd: 10 });
  op = await openCore({ dataDir: dir, caller: callerFor('operator', { run_id: 'run-live' }), embed: false });
});
after(async () => { await op.close(); await c.shutdownOwner(); await c.close(); cleanup(dir); });

const streamOf = (id) => path.join(dir, 'workers', id, 'stream.jsonl');
const put = (id, lines) => { fs.mkdirSync(path.dirname(streamOf(id)), { recursive: true }); fs.writeFileSync(streamOf(id), lines.join('\n') + '\n'); };
const add = (id, lines) => fs.appendFileSync(streamOf(id), lines.join('\n') + '\n');
const live = (id, extra = {}) => ({ id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now(), cost_usd: 0, turns: 0, ...extra });
const publish = (rec) => op.run.setBudget({ budget: rec });

test('the accumulator is a running sum: it grows with the turn, counts a repeated message once, and a result or an init empties it', () => {
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
  a.feed(init); // a new turn or life: what came before without a result is ADR 0068's, not in flight
  assert.strictEqual(a.snapshot(), null);
});

test('an unpriced model gives no figure rather than a low one', () => {
  const a = IF.createAccumulator();
  a.feed(msg('m1').replace('claude-sonnet-5-5', 'some-new-model'));
  const s = a.snapshot();
  assert.deepStrictEqual([s.usd, s.unpriced_models], [null, ['some-new-model']]);
});

test('the tracker reads a stream from where it stopped: each call reads new bytes only, a half-written line waits, and a result empties it', () => {
  put('t1', [init, msg('a1')]);
  const t = IF.createTracker({ dataDir: dir });
  const rows = [live('t1')];
  t.update(rows);
  near(t.figures().usd, 1);
  fs.appendFileSync(streamOf('t1'), msg('a2').slice(0, 40)); // a line cut mid-write
  t.update(rows);
  near(t.figures().usd, 1);
  fs.appendFileSync(streamOf('t1'), msg('a2').slice(40) + '\n');
  t.update(rows);
  near(t.figures().usd, 2);
  add('t1', [result(2)]);
  t.update(rows);
  assert.deepStrictEqual(t.figures(), { usd: 0, by_worker: {}, partial: [], unpriced: [] });
  t.update([]); // no longer live: forgotten
  put('t1', [init, msg('b1')]); // a shorter file under the same name: read afresh
  t.update(rows);
  near(t.figures().usd, 1);
});

test('the tracker is bounded per call: a long stream is read in steps and says partial until it has caught up', () => {
  const pad = (i) => msg(`c${i}`).replace('"content":[]', `"content":["${'x'.repeat(20000)}"]`); // 40 lines of about 20 KB
  put('t2', [init, ...Array.from({ length: 40 }, (_, i) => pad(i))]);
  const t = IF.createTracker({ dataDir: dir, chunk: 128 * 1024, steps: 2 });
  const rows = [live('t2')];
  t.update(rows);
  let f = t.figures();
  assert.deepStrictEqual(f.partial, ['t2']);
  assert.ok(f.usd > 0 && f.usd < 40);
  for (let i = 0; i < 6; i++) t.update(rows);
  f = t.figures();
  assert.deepStrictEqual(f.partial, []);
  near(f.usd, 40);
});

test('status reads the figures the run process published: a live worker estimate beside its reported cost, and the run block labels it, uncounted by default', async () => {
  put('w1', [init, msg('b1'), msg('b2'), msg('b3')]);
  await c.worker.write(live('w1', { cost_usd: 2, turns: 1 }));
  await publish({ counts_in_flight: false, orchestrator: { counted: true, usd: 0, base: 0, last: 0, in_flight_usd: 1 }, in_flight_workers: { usd: 3, by_worker: { w1: 3 }, partial: [], unpriced: [] } });
  const st = await c.status.get();
  const w = st.workers.find((x) => x.id === 'w1');
  assert.strictEqual(w.cost_usd, 2);
  assert.deepStrictEqual([w.cost_in_flight_usd, w.cost_in_flight_source, w.cost_in_flight_partial], [3, 'in flight (estimate)', false]);
  const b = st.run.budget;
  assert.deepStrictEqual([b.basis, b.in_flight.usd, b.in_flight.orchestrator_usd, b.in_flight.workers_usd, b.in_flight.counted], ['reported', 4, 1, 3, false]);
  near(b.spent_usd, 0); // the ledger holds nothing; the estimate is not in it
  assert.match(RB.textOf(b), /\$4\.00 in flight \(estimate\), not counted/);
});

test('status parses no stream: with the streams removed the published figure is still shown', async () => {
  fs.rmSync(path.join(dir, 'workers', 'w1'), { recursive: true, force: true });
  const w = (await c.status.get()).workers.find((x) => x.id === 'w1');
  assert.strictEqual(w.cost_in_flight_usd, 3);
});

test('the turn ends: the published figure falls to zero and the reported cost carries the turn', async () => {
  await publish({ counts_in_flight: false, orchestrator: { counted: true, usd: 0, base: 0, last: 0, in_flight_usd: 0 }, in_flight_workers: { usd: 0, by_worker: {}, partial: [], unpriced: [] } });
  await c.worker.write(live('w1', { cost_usd: 5, turns: 2 }));
  const st = await c.status.get();
  const w = st.workers.find((x) => x.id === 'w1');
  assert.deepStrictEqual([w.cost_usd, w.cost_in_flight_usd, w.cost_in_flight_source], [5, null, null]);
  assert.strictEqual(st.run.budget.in_flight.usd, 0);
});

test('a partial figure is shown as partial in the worker fields and in the budget text', async () => {
  await publish({ counts_in_flight: false, orchestrator: { counted: true, usd: 0, base: 0, last: 0, in_flight_usd: 0 }, in_flight_workers: { usd: 1, by_worker: { w1: 1 }, partial: ['w1'], unpriced: [] } });
  const st = await c.status.get();
  assert.strictEqual(st.workers.find((x) => x.id === 'w1').cost_in_flight_partial, true);
  assert.match(RB.textOf(st.run.budget), /in flight \(estimate, partial: a stream is not yet read to its end\)/);
});

test('blockOf counts the estimate in spent only when the record says the lever is on, and says so in the text', () => {
  const row = (flag, extra = {}) => ({ budget_usd: 10, ended_at: null, budget: JSON.stringify({ counts_in_flight: flag, orchestrator: { counted: true, usd: 1, in_flight_usd: 2 }, in_flight_workers: { usd: 1, by_worker: {}, partial: [] } }), ...extra });
  const off = RB.blockOf(row(false), { usd: 3, unknown_turns: 0 });
  const on = RB.blockOf(row(true), { usd: 3, unknown_turns: 0 });
  assert.deepStrictEqual([off.spent_usd, off.basis, off.in_flight.usd], [4, 'reported', 3]);
  assert.deepStrictEqual([on.spent_usd, on.basis, on.in_flight.counted], [7, 'reported + in flight (estimate)', true]);
  assert.match(RB.textOf(on), /^\$7\.00 of \$10\.00 reported, \$1\.00 of it the orchestrator's \(under\); \$3\.00 of it in flight \(estimate\), counted$/);
  assert.strictEqual(RB.blockOf(row(true, { ended_at: 5 }), { usd: 3, unknown_turns: 0 }).in_flight.usd, 0, 'an ended run has no turn in flight');
});
