// fake-core-knowledge.cjs — the stand-in core of fake-core.cjs plus a run.get that answers the run's memory
// levers, for the adapter's knowledge_ask listing gate (ADR 0043 decision 1). Used only through BELAY_FAKE_CORE.
//   BELAY_FAKE_LEVERS     JSON of the run row's memory_levers (absent: the row has none)
//   BELAY_FAKE_RUNGET     'fail' makes run.get reject; 'hang' makes it never answer
//   BELAY_FAKE_COUNT_FILE a line is appended here for every run.get, so a test can count the reads
// Its run manager answers `ask` by echoing the question, so the route can be proved without a worker.
'use strict';

const fs = require('node:fs');
const base = require('./fake-core.cjs');

async function openCore(opts) {
  const core = await base.openCore(opts);
  core.run.get = async () => {
    if (process.env.BELAY_FAKE_COUNT_FILE) fs.appendFileSync(process.env.BELAY_FAKE_COUNT_FILE, 'run.get\n');
    if (process.env.BELAY_FAKE_RUNGET === 'fail') throw Object.assign(new Error('fake run.get failure'), { code: 'E_INTERNAL' });
    if (process.env.BELAY_FAKE_RUNGET === 'hang') await new Promise(() => {});
    const levers = process.env.BELAY_FAKE_LEVERS || null;
    return { run: { id: opts.caller.run_id, epoch: 1, memory_levers: levers }, epochs: [] };
  };
  return core;
}

function createRunManager(args) {
  const manager = base.createRunManager(args);
  manager.ask = async (a) => ({ answer: `echo: ${a.question}`, cited: [], uncited_claims: false, worker_id: `knowledge-${args.runId}`, turn: 1, waited_ms: 1 });
  return manager;
}

module.exports = { openCore, createRunManager, CoreError: base.CoreError };
