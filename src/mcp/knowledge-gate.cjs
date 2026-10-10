'use strict';
// knowledge-gate.cjs — ADR 0043 decision 1: whether the orchestrator adapter lists `knowledge_ask`. The tool is
// listed only when the run's `knowledge_agent` lever is on, so the adapter reads the run row once, at its first
// `tools/list`, through the core's own bounded read, and keeps the answer for the life of the process.
//
// The gate never creates anything: no store means no run row means no tool, and no core is opened for it. A read
// that fails or runs past its bound answers "not listed" and says so on both channels, and is not cached, so the
// next `tools/list` asks again. The lever is also enforced where the question is answered (the run manager
// refuses E_LEVER_OFF), so a missed listing costs the orchestrator a tool, never a lever.

const DEFAULT_BOUND_MS = 3000;

function createKnowledgeGate({ role, runId, storeExists, openCore, log, boundMs = DEFAULT_BOUND_MS }) {
  let answer = null; // true or false once a read has answered; null until then
  let inflight = null;

  async function read() {
    const core = await openCore();
    const { leversFor } = require('../run/memory-levers.cjs'); // no requires of its own
    const levers = await leversFor(core, runId);
    return levers.knowledge_agent === true;
  }

  function bounded() {
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the run row did not answer inside ${boundMs} ms`)), boundMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([read(), limit]).finally(() => clearTimeout(timer));
  }

  return async function knowledgeListed() {
    if (role !== 'orchestrator') return false;
    if (answer !== null) return answer;
    if (!storeExists()) return false;
    if (!inflight) {
      inflight = bounded()
        .then((v) => { answer = v; return v; })
        .catch((e) => {
          const line = `knowledge_ask is not listed: the run's levers could not be read: ${e && e.message}`;
          log('!!', line);
          process.stderr.write(`belay-mcp: ${line}\n`);
          return false;
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  };
}

module.exports = { createKnowledgeGate, DEFAULT_BOUND_MS };
