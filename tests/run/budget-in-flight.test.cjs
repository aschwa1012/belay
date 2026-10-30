'use strict';
// budget-in-flight.test.cjs — the budget guard and the in-flight estimate (ADR 0066 amendment, proposed). With the lever off the guard
// behaves as it always did: reported cost only. With it on, the headless orchestrator's turn in flight (priced from its stream lines as
// they arrive) and the live workers' in-flight estimate are added to what it compares, the pause says so, and the turn's result line
// hands the figure back to the reported cost. A fake core and fake stream lines; no process, no clock beyond the guard's own tick.

const test = require('node:test');
const assert = require('node:assert');
const { createBudgetGuard, wakeTextOf } = require('../../src/run/budget-guard.cjs');
const { applyBudget } = require('../../src/cli/run-budget-levers.cjs');

// Opus 5.5 at 20 per million out: 100,000 output tokens of one message cost $2.00.
const msg = (id, out = 100000) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const result = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1, usage: {} });

function spy({ run = 0, workers = 0 } = {}) {
  const s = { run, workers, calls: [], pauses: [], written: [], pausedBy: null };
  const core = {
    usage: { spend: async (a) => { s.calls.push(a); return { usd: s.run, turns: 1, unknown_turns: 0, first_seq: 1, last_seq: 1, per_worker: {}, per_task: {}, unknown_workers: [], ...(a.in_flight ? { in_flight_usd: s.workers, in_flight_workers: 1 } : {}) }; } },
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
  g.tick(); await settle(g);
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

test('lever on: the live workers in-flight estimate counts too, and the turn result line hands the orchestrator figure back to the reported cost', async () => {
  const o = spy({ run: 5, workers: 3 }); // 8.00 so far
  const g = mk(o, { countInFlight: true });
  g.noteOrchestratorLine(msg('a')); // 10.00 with $2.00 in flight: over
  await settle(g);
  assert.strictEqual(o.s.pauses.length, 1);
  const p = spy({ run: 5, workers: 0 });
  const h = mk(p, { countInFlight: true });
  h.noteOrchestratorLine(msg('a')); await settle(h);
  assert.strictEqual(h.state().record.orchestrator.in_flight_usd, 2);
  h.noteOrchestratorLine(result);
  await h.noteOrchestratorCost(2); // the turn ended: the reported cost is now the orchestrator's, the estimate is empty
  assert.strictEqual(h.state().record.orchestrator.in_flight_usd, 0);
  assert.strictEqual(h.state().record.orchestrator.usd, 2);
});

test('lever on: the poll tick checks the budget while the orchestrator is silent and a worker turn runs', async () => {
  const o = spy({ run: 5, workers: 4.5 });
  const g = mk(o, { countInFlight: true });
  g.tick(); await settle(g);
  assert.strictEqual(o.s.pauses.length, 1);
  assert.match(o.s.pauses[0], /reported \+ in flight \(estimate\)/);
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
