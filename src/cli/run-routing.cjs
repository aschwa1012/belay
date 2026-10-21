'use strict';
// run-routing.cjs — pins a run's retrieval routing at its start (ADR 0050 decision 3): after run.attach and BEFORE the orchestrator's first
// prompt, `belay run` asks the store owner to resolve the routing once and record it on the run row (run.pinRouting, retrieval-pin.cjs), which also
// probes the GPU and warms every pinned model. Only a run whose levers route something off the default (a reranker, a heavy embedder, a routed
// agent type) pins: a default run is on nano with no reranker whether or not a row says so, so it writes nothing and loads nothing.
//
// A heavy embedder with a backlog in the run's scope is on_heavy_behind's business (ADR 0050 decision 4): `wait` drains it here, with its
// progress written to `write` (and kept in the result's `start_progress`, which the receipt carries, so --json loses none of it), and the run
// starts when it is empty; `fallback` is decided by the owner (the heavy roles use nano for this run). A drain that FAILS is a heavy failure, and
// on_heavy_failure decides: `fallback` pins the demoted routing with ONE notice and starts; `pause` refuses, naming the pin and the cause.

const { resolveRouting } = require('../core/retrieval-routing.cjs'); // pure
const RP = require('../core/retrieval-profiles.cjs'); // pure
const { DEFAULTS } = require('../core/memory-levers.cjs'); // pure

const DRAIN_ROUNDS = 500; // a backstop: each round is one bounded call that makes progress or stops the loop

// Whether the levers route any tier off the default (nano, no reranker). Unreadable levers do not pin: the run's own attach refuses them.
function needsPin(memoryLevers) {
  if (!memoryLevers) return false;
  try {
    const r = resolveRouting({ levers: memoryLevers, agentTypes: [], gpu: true });
    return [r.run, ...Object.values(r.tiers)].some((t) => t.embedder !== RP.NANO || t.reranker);
  } catch { return false; }
}

// -> the pin record the owner wrote ({ routing, probe, warm, notices, behind, start_progress }), or null when this run pins nothing.
async function pinAtStart(core, { levers, write = null } = {}) {
  if (!needsPin(levers && levers.memory_levers)) return null;
  const progress = [];
  const say = (m) => { progress.push(m); if (write) write(`belay: ${m}\n`); };
  const onFailure = (levers.memory_levers && levers.memory_levers.on_heavy_failure) || DEFAULTS.on_heavy_failure;
  say('resolving the retrieval routing: probing the GPU and warming the pinned models (a cold load can take a while)');
  let r = await core.run.pinRouting({});
  const failedDrains = [];
  for (let round = 0; r.action === 'drain' && round < DRAIN_ROUNDS; round += 1) {
    let moved = false;
    for (const b of r.behind) {
      say(`${b.embedder} is ${b.rows} note${b.rows === 1 ? '' : 's'} behind, and on_heavy_behind is wait: embedding them before the run starts`);
      let d;
      try {
        do {
          d = await core.memory.drainHeavy({ model: b.embedder, namespaces: b.namespaces });
          say(`${b.embedder}: ${d.written} of ${d.total} embedded this pass, ${d.remaining} left (${d.ms} ms)`);
          if (d.written > 0) moved = true;
        } while (!d.done && d.written > 0);
      } catch (e) {
        const why = `${(e && e.code) || 'E_INTERNAL'}: ${(e && e.message) || e}`;
        if (onFailure === 'pause') throw new Error(`the ${b.embedder} embedder failed while draining its backlog (${why}), and on_heavy_failure is pause, so the run was not started on it; fix the GPU, or set on_heavy_failure to fallback`);
        say(`the ${b.embedder} embedder failed while draining (${why}); on_heavy_failure is fallback, so the heavy roles use nano for this run`);
        failedDrains.push({ embedder: b.embedder, code: (e && e.code) || 'E_INTERNAL', message: String((e && e.message) || e).slice(0, 300) });
        moved = true; // not a stall: the failure is handled below
      }
    }
    if (!moved) throw new Error(`the heavy embedder backlog did not shrink, so the run was not started on it (drain it with: belay memory embed --model ${r.behind[0].embedder})`);
    r = await core.run.pinRouting(failedDrains.length ? { drain_failed: failedDrains } : {});
  }
  if (r.action === 'drain') throw new Error('the heavy embedder backlog was still not empty after the drain rounds, so the run was not started');
  for (const n of r.notices || []) say(`notice (${n.code}): ${n.message}`);
  return { ...r, start_progress: progress };
}

module.exports = { pinAtStart, needsPin };
