'use strict';
// knowledge-gate.cjs — ADR 0043 decision 1: whether the orchestrator adapter lists `knowledge_ask`. The tool is
// listed only when the run's `knowledge_agent` lever is on, so the adapter reads the run row once, at its first
// `tools/list`, through the core's own bounded read, and keeps the answer for the life of the process.
//
// The gate never creates anything: no store means no run row means no tool, and no core is opened for it. A read
// that fails or runs past its bound answers "not listed" and says so on both channels, and is not cached, so the
// next `tools/list` asks again. The lever is also enforced where the question is answered (the run manager
// refuses E_LEVER_OFF), so a missed listing costs the orchestrator a tool, never a lever.
//
// The read is the one core call the levers cost a run at the defaults, and ADR 0043 decision 1 places it here:
// Claude Code lists the tools at startup, before the orchestrator calls anything, so the run row is not yet in
// the adapter's hands and the listing cannot wait for it. Once the adapter's own run.attach has returned the row
// (`attachedRun`), the gate answers from it and reads nothing.

const DEFAULT_BOUND_MS = 3000;

function createKnowledgeGate({ role, runId, storeExists, openCore, log, boundMs = DEFAULT_BOUND_MS, attachedRun = () => null }) {
  let answer = null; // true or false once a read has answered; null until then
  let notes = false; // ADR 0047: the same read also answers whether the run has the notes lever on
  let inflight = null;

  async function read() {
    const core = await openCore();
    const { leversFor } = require('../run/memory-levers.cjs'); // no requires of its own
    const levers = await leversFor(core, runId);
    notes = levers.notes === true;
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

  async function knowledgeListed() {
    if (role !== 'orchestrator') return false;
    if (answer !== null) return answer;
    const row = attachedRun();
    if (row) {
      const lv = require('../run/memory-levers.cjs').leversOfRow(row);
      answer = lv.knowledge_agent === true;
      notes = lv.notes === true;
      return answer;
    }
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
  }
  // The notes lever from the same single read (the orchestrator lists memory_summaries only when it is on).
  knowledgeListed.notes = () => notes; // read after knowledgeListed() has answered; never a second read
  return knowledgeListed;
}

module.exports = { createKnowledgeGate, DEFAULT_BOUND_MS };
