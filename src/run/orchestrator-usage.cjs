'use strict';
// orchestrator-usage.cjs — build step W2-3 (S4b), design item 4. A pure accumulator for the orchestrator's
// own usage, fed the ready and turn_end events orchestrator.cjs already handles. It follows the worker's
// rules (worker.cjs onTurnEnd): tokens are summed per turn, cost is SET from the latest cumulative
// total_cost_usd (never summed: it carries across a --resume), and the model is the init's own, never the
// requested string. No state outside the closure, no process, no store; not imported by any read path.

const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

function createUsage() {
  const s = { model: null, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, turns: 0 };
  return {
    onInit(ev) {
      if (ev && ev.model) s.model = ev.model;
    },
    onTurnEnd(ev) {
      const u = (ev && ev.usage) || {};
      s.turns += 1;
      s.input += n(u.input_tokens);
      s.output += n(u.output_tokens);
      s.cacheRead += n(u.cache_read_input_tokens);
      s.cacheCreation += n(u.cache_creation_input_tokens);
      if (ev && typeof ev.cost_usd === 'number') s.cost = ev.cost_usd;
    },
    snapshot() {
      return {
        orch_model: s.model, orch_input_tokens: s.input, orch_output_tokens: s.output,
        orch_cache_read_tokens: s.cacheRead, orch_cache_creation_tokens: s.cacheCreation,
        orch_cost_usd: s.cost, orch_turns: s.turns,
      };
    },
  };
}

module.exports = { createUsage };
