'use strict';
// budget-in-flight.test.cjs — the budget guard and the in-flight estimate (ADR 0066 amendment, proposed). With the lever off the guard
// behaves as it always did: reported cost only. With it on, the headless orchestrator's turn in flight (priced from its stream lines as
// they arrive) and the live workers' in-flight estimate are added to what it compares, the pause says so, and the turn's result line
// hands the figure back to the reported cost. A fake core and fake stream lines; no process, no clock beyond the guard's own tick.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBudgetGuard, wakeTextOf } = require('../../src/run/budget-guard.cjs');
const { applyBudget } = require('../../src/cli/run-budget-levers.cjs');

// Opus 5.5 at 20 per million out: 100,000 output tokens of one message cost $2.00.
const msg = (id, out = 100000) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const result = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1, usage: {} });

const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' });
// A data dir holding the stream of worker w1 with `n` messages of $2.00 in flight (Opus), and the worker row that says it is live.
function withWorker(n) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-inflight-')).split(path.sep).join('/');
  fs.mkdirSync(`${dataDir}/workers/w1`, { recursive: true });
  fs.writeFileSync(`${dataDir}/workers/w1/stream.jsonl`, [init, ...Array.from({ length: n }, (_, i) => msg(`w${i}`))].join('\n') + '\n');
  return { dataDir, rows: [{ id: 'w1', substrate: 'claude-code', state: 'running' }], done: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

function spy({ run = 0 } = {}) {
  const s = { run, calls: [], pauses: [], written: [], pausedBy: null };
  const core = {
    usage: { spend: async (a) => { s.calls.push(a); return { usd: s.run, turns: 1, unknown_turns: 0, first_seq: 1, last_seq: 1, per_worker: {}, per_task: {}, unknown_workers: [] }; } },
    task: { list: async () => ({ tasks: [] }) },
    run: { get: async () => ({ run: { paused_by: s.pausedBy } }), setBudget: async (a) => { if (a.budget) s.written.push(JSON.parse(JSON.stringify(a.budget))); } },
  };
  return { s, core, pauseRun: async (why) => { s.pauses.push(why); s.pausedBy = `operator:1 [${why}]`; return { already: false }; } };
}
const mk = (o, extra = {}) => createBudgetGuard({ core: o.core, runId: 'r1', pauseRun: (w) => o.pauseRun(w), runLimit: 10, tickMs: 0, ...extra });
const settle = async (g) => { await g.settled(); await new Promise((r) => setImmediate(r)); };

test('lever off: the orchestrator turn in flight is recorded for status and never pauses the run', async () => {
  const o = spy({ run: 6.5 });
  const g = mk(o);
  for (const l of [msg('a'), msg('b')]) g.noteOrchestratorLine(l); // $4.00 in flight on top of $6.50 reported
  await settle(g);
  assert.deepStrictEqual(o.s.pauses, []);
  assert.strictEqual(o.s.calls.every((a) => !a.in_flight), true, 'the spend is read without the in-flight estimate');
  assert.strictEqual(g.state().record.orchestrator.in_flight_usd, 4);
  assert.strictEqual(g.state().record.counts_in_flight, false);
  g.tick([]); await settle(g);
  assert.deepStrictEqual(o.s.pauses, []);
});

test('lever on: reported plus the orchestrator in-flight estimate reaches the threshold mid-turn and pauses the run, saying so', async () => {
  const o = spy({ run: 6.5 });
  const g = mk(o, { countInFlight: true });
  g.noteOrchestratorLine(msg('a')); // $2.00: 8.50, under 90 percent of 10
  await settle(g);
  assert.deepStrictEqual(o.s.pauses, []);
  g.noteOrchestratorLine(msg('b')); // $4.00: 10.50
  await settle(g);
  assert.deepStrictEqual(o.s.pauses, ['budget (run, $10.50 of $10.00 reported + in flight (estimate))']);
  const ev = o.s.written.pop().events.find((e) => e.type === 'pause');
  assert.strictEqual(ev.basis, 'reported + in flight (estimate)');
  assert.strictEqual(ev.in_flight_usd, 4);
  assert.match(g.takeWakes()[0].text, /\$10\.50 of \$10\.00 reported \+ in flight \(estimate\)/);
});

test('lever on: a live worker turn in flight counts, read from its stream by the run process, and the turn result hands the orchestrator figure back', async () => {
  const w = withWorker(2); // $4.00 in flight in the worker
  try {
    const o = spy({ run: 5 });
    const g = mk(o, { countInFlight: true, dataDir: w.dataDir });
    g.noteOrchestratorLine(msg('a')); // $2.00 in the orchestrator: 5 + 2 = 7, under 9
    await settle(g);
    assert.deepStrictEqual(o.s.pauses, []);
    g.tick(w.rows); // + $4.00 from the worker stream: 11
    await settle(g);
    assert.strictEqual(o.s.pauses.length, 1);
    assert.match(o.s.pauses[0], /reported \+ in flight \(estimate\)/);
    assert.deepStrictEqual(g.state().record.in_flight_workers.by_worker, { w1: 4 });
    const p = spy({ run: 5 });
    const h = mk(p, { countInFlight: true });
    h.noteOrchestratorLine(msg('a')); await settle(h);
    h.noteOrchestratorLine(result);
    await h.noteOrchestratorCost(2); // the turn ended: the reported cost is now the orchestrator's, the estimate is empty
    assert.strictEqual(h.state().record.orchestrator.in_flight_usd, 0);
    assert.strictEqual(h.state().record.orchestrator.usd, 2);
  } finally { w.done(); }
});

test('lever on: the poll tick checks the budget while the orchestrator is silent and a worker turn runs', async () => {
  const w = withWorker(3); // $6.00
  try {
    const o = spy({ run: 4 });
    const g = mk(o, { countInFlight: true, dataDir: w.dataDir });
    g.tick(w.rows); await settle(g);
    assert.strictEqual(o.s.pauses.length, 1);
    assert.match(o.s.pauses[0], /reported \+ in flight \(estimate\)/);
  } finally { w.done(); }
});

test('lever off: a live worker turn is published for status and never pauses the run', async () => {
  const w = withWorker(3);
  try {
    const o = spy({ run: 9 });
    const g = mk(o, { dataDir: w.dataDir });
    g.tick(w.rows); await settle(g);
    assert.deepStrictEqual(o.s.pauses, []);
    assert.deepStrictEqual(g.state().record.in_flight_workers.by_worker, { w1: 6 });
  } finally { w.done(); }
});

test('an idle run writes no new run row over many ticks, with the lever off or on, and a small change under the step writes none', async () => {
  const w = withWorker(0); // a stream with an init and no message: nothing in flight
  try {
    for (const countInFlight of [false, true]) {
      const o = spy({ run: 1 });
      const g = mk(o, { countInFlight, dataDir: w.dataDir });
      const base = o.s.written.length;
      for (let i = 0; i < 200; i++) g.tick(w.rows);
      await settle(g);
      assert.strictEqual(o.s.written.length, base, `lever ${countInFlight}: ticks of an idle run wrote run rows`);
      for (let i = 0; i < 100; i++) g.noteOrchestratorLine(msg(`s${i}`, 100)); // $0.002 each, $0.20 in all, building up inside one turn
      await settle(g);
      const writes = o.s.written.length - base;
      assert.ok(writes >= 1 && writes <= 6, `${writes} writes for a $0.20 turn in 100 lines`); // a step of $0.05 or 5% of the last figure
    }
  } finally { w.done(); }
});

test('a new run process does not carry the earlier in-flight figure', async () => {
  const o = spy({ run: 1 });
  const g = mk(o);
  await g.loadAttach({ budget_usd: 10, budget: { source: 'spec', events: [], orchestrator: { counted: true, usd: 1, base: 0, last: 1, in_flight_usd: 3 }, in_flight_workers: { usd: 2, by_worker: { w1: 2 }, partial: [] } } });
  assert.strictEqual(g.state().record.orchestrator.in_flight_usd, 0);
  assert.strictEqual(g.state().record.in_flight_workers, null);
  assert.ok(o.s.written.length >= 1, 'the stale figure was cleared on the run row');
});

test('a steady stream of orchestrator lines does not starve the worker read: the worker figure keeps growing', async () => {
  const w = withWorker(1); // $2.00
  const realNow = Date.now;
  try {
    const o = spy({ run: 0 });
    // A stubbed clock: every orchestrator line takes the tick slot at the same instant as the poll tick that follows it, so the
    // poll's worker read can only happen if it has a slot of its own. No wall clock, no sleep.
    let clock = 1000;
    Date.now = () => clock;
    const g = mk(o, { dataDir: w.dataDir, tickMs: 20 });
    g.tick(w.rows);
    let n = 0;
    for (let i = 0; i < 3; i++) { clock += 21; g.noteOrchestratorLine(msg(`o${n++}`, 10)); } // lines inside every slot
    fs.appendFileSync(`${w.dataDir}/workers/w1/stream.jsonl`, msg('late') + '\n'); // the worker turn grows by $2.00
    for (let i = 0; i < 4; i++) { clock += 21; g.noteOrchestratorLine(msg(`p${n++}`, 10)); g.tick(w.rows); } // the line first, the poll in the same instant
    Date.now = realNow;
    await settle(g);
    assert.strictEqual(g.state().record.in_flight_workers.by_worker.w1, 4);
  } finally { Date.now = realNow; w.done(); }
});

test('the in-flight check is throttled: lines inside one tick cost one check', async () => {
  const o = spy({ run: 1 });
  const g = mk(o, { countInFlight: true, tickMs: 60000 });
  for (let i = 0; i < 20; i++) g.noteOrchestratorLine(msg(`m${i}`, 1000));
  await settle(g);
  assert.ok(o.s.calls.length <= 1, `${o.s.calls.length} spend reads`);
});

test('the wake text names the in-flight basis and stays inside the cap', () => {
  const t = wakeTextOf({ runId: 'a-very-long-run-identifier-0123456789', scope: 'run', spent: 123.456, limit: 200, unknown: 1, inFlight: true });
  assert.ok(Buffer.byteLength(t) <= 221);
});

test('the run spec lever is off unless stated, needs a budget, and must be a boolean', () => {
  const out = {};
  assert.deepStrictEqual(applyBudget(out, { budget_usd: 10 }), {});
  assert.strictEqual(out.budget_counts_in_flight, false);
  const on = {};
  assert.deepStrictEqual(applyBudget(on, { budget_usd: 10, budget_counts_in_flight: true }), {});
  assert.strictEqual(on.budget_counts_in_flight, true);
  assert.match(applyBudget({}, { budget_counts_in_flight: true }).error, /needs a budget/);
  assert.match(applyBudget({}, { budget_usd: 10, budget_counts_in_flight: 'yes' }).error, /true or false/);
});

test('lever on: a worker turn that has just reported is not counted again as in flight before the next tick', async () => {
  const w = withWorker(1); // $2.00 of the turn read by the first tick
  try {
    const o = spy({ run: 5 });
    const g = mk(o, { countInFlight: true, dataDir: w.dataDir, tickMs: 60000 });
    g.tick(w.rows); await settle(g);
    assert.strictEqual(g.state().record.in_flight_workers.usd, 2);
    fs.appendFileSync(`${w.dataDir}/workers/w1/stream.jsonl`, result + '\n'); // the turn ends...
    o.s.run = 7; // ...and its $2.00 reaches the ledger at once, with no tick in between
    await g.onUsage({ worker_id: 'w1' }); await settle(g);
    assert.deepStrictEqual(o.s.pauses, [], '$7.00 reported is under the $9.00 threshold');
  } finally { w.done(); }
});

test('lever on: a worker followed for the first time starts at its current turn, so a stream longer than one catch-up never counts reported turns', async () => {
  const w = withWorker(0);
  try {
    const sp = `${w.dataDir}/workers/w1/stream.jsonl`;
    const pad = (i) => msg(`p${i}`, 1).replace('"content":[]', `"content":["${'x'.repeat(1000)}"]`); // about 4.5 MB: past the tracker's 4 MB read per call
    // An old turn worth $2.00 whose result lies past the first 4 MB; the last line is a result, so nothing is in flight.
    fs.writeFileSync(sp, [init, msg('old'), ...Array.from({ length: 4500 }, (_, i) => pad(i)), result, init, msg('t2'), result].join('\n') + '\n');
    const o = spy({ run: 8 });
    const g = mk(o, { countInFlight: true, dataDir: w.dataDir, tickMs: 0 });
    g.tick(w.rows); await settle(g);
    assert.deepStrictEqual(o.s.pauses, [], 'nothing is in flight: the ledger holds $8.00 of $10.00');
    const fl = g.state().record.in_flight_workers || { usd: 0, partial: [] };
    assert.deepStrictEqual([fl.usd, fl.partial], [0, []]);
  } finally { w.done(); }
});
