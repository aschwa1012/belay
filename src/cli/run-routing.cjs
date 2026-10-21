'use strict';
// run-routing.cjs — pins a run's retrieval routing at its start (ADR 0050 decision 3): after run.attach and BEFORE the orchestrator's first
// prompt, `belay run` asks the store owner to resolve the routing once and record it on the run row (run.pinRouting, retrieval-pin.cjs).
// Only a run whose levers route something off the default (a reranker, a heavy embedder, a routed agent type) pins: a default run is on nano
// with no reranker whether or not a row says so, so it writes nothing and loads nothing.
//
// A heavy embedder with a backlog in the run's scope is on_heavy_behind's business (ADR 0050 decision 4): `wait` drains it here, with its
// progress written to `write`, and the run starts when it is empty; `fallback` is decided by the owner (the heavy roles use nano for this run).
// Every notice is written once, and is in the run row. A refusal that cannot be served (on_heavy_failure pause) throws.

const { resolveRouting } = require('../core/retrieval-routing.cjs'); // pure
const RP = require('../core/retrieval-profiles.cjs'); // pure

const DRAIN_ROUNDS = 500; // a backstop: each round is one bounded call that makes progress or stops the loop

// Whether the levers route any tier off the default (nano, no reranker). Unreadable levers do not pin: the run's own attach refuses them.
function needsPin(memoryLevers) {
  if (!memoryLevers) return false;
  try {
    const r = resolveRouting({ levers: memoryLevers, agentTypes: [], gpu: true });
    return [r.run, ...Object.values(r.tiers)].some((t) => t.embedder !== RP.NANO || t.reranker);
  } catch { return false; }
}

// -> the pin record the owner wrote ({ routing, probe, notices, behind }), or null when this run pins nothing.
async function pinAtStart(core, { levers, write = null } = {}) {
  if (!needsPin(levers && levers.memory_levers)) return null;
  const say = (m) => { if (write) write(`belay: ${m}\n`); };
  let r = await core.run.pinRouting({});
  for (let round = 0; r.action === 'drain' && round < DRAIN_ROUNDS; round += 1) {
    let moved = false;
    for (const b of r.behind) {
      say(`${b.embedder} is ${b.rows} note${b.rows === 1 ? '' : 's'} behind, and on_heavy_behind is wait: embedding them before the run starts`);
      let d;
      do {
        d = await core.memory.drainHeavy({ model: b.embedder, namespaces: b.namespaces });
        say(`${b.embedder}: ${d.written} of ${d.total} embedded this pass, ${d.remaining} left (${d.ms} ms)`);
        if (d.written > 0) moved = true;
      } while (!d.done && d.written > 0);
    }
    if (!moved) throw new Error(`the heavy embedder backlog did not shrink, so the run was not started on it (drain it with: belay memory embed --model ${r.behind[0].embedder})`);
    r = await core.run.pinRouting({});
  }
  if (r.action === 'drain') throw new Error('the heavy embedder backlog was still not empty after the drain rounds, so the run was not started');
  for (const n of r.notices || []) say(`notice (${n.code}): ${n.message}`);
  return r;
}

module.exports = { pinAtStart, needsPin };
