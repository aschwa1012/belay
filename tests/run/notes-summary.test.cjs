'use strict';
// notes-summary.test.cjs — ADR 0047 decision 1 on the run side: with the notes lever on a task's summary is stored in
// summary/<project>, not the project and not the run; with it off the destination is what ADR 0044 made it.

const test = require('node:test');
const assert = require('node:assert');

const MJ = require('../../src/run/memory-jobs.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');

function spy() {
  const stores = [], events = [];
  const core = {
    run: { get: async () => ({ run: { memory_levers: null } }) },
    task: { get: async () => ({ id: 't1', spec: 'build it', state: 'released', handoff: { result: { summary: 'built it' } } }) },
    continuity: { lastCheckpoint: async () => ({ checkpoint: null }) },
    worker: { list: async () => ({ workers: [] }) },
    memory: {
      list: async () => ({ rows: [], total: 0 }),
      get_many: async () => ({ rows: [] }),
      events: async () => ({ events: [] }),
      store: async (a) => { stores.push(a); return { id: `m${stores.length}`, action: 'inserted', namespace: a.namespace || 'run/r1' }; },
      recordEvent: async (a) => { events.push(a); return { id: `e${events.length}`, ...a }; },
      promote: async () => ({ moved: [], existing: [], refused: [], skipped: [], capped: 0 }),
    },
  };
  return { core, stores, events };
}
const worker = () => ({ id: 'w1', taskId: 't1', substrate: 'claude-code', turns: 1, costUsd: 0, pid: 100, lastTurnUsage: {} });
async function turnEnd(levers) {
  const s = spy();
  const w = worker();
  MJ.afterTurn(w, { core: s.core, runId: 'r1', memoryLevers: { ...DEFAULTS, ...levers }, shutdownFlags: { closed: false } }, {});
  await new Promise((r) => setImmediate(r));
  await w.memoryQueue;
  return s;
}
const summaryStore = (s) => s.stores.find((x) => x.type === 'summary');

test('notes on: the summary goes to summary/<project>, even with project writes on, and is not a project write', async () => {
  for (const extra of [{}, { project_writes: true }]) {
    const s = await turnEnd({ project: 'acme', notes: true, summaries: 'mechanical', observations: true, capture: true, ...extra });
    assert.strictEqual(summaryStore(s).namespace, 'summary/acme', JSON.stringify(extra));
    assert.ok(s.events.some((e) => e.kind === 'summary' && e.ok !== false), 'the summary receipt');
    assert.ok(!s.events.some((e) => e.kind === 'project_write' && /^summary:/.test(e.key || '')), 'no project_write receipt for it');
  }
});

test('notes off: the summary goes where ADR 0044 sent it', async () => {
  const run = await turnEnd({ project: 'acme', summaries: 'mechanical', observations: true, capture: true });
  assert.strictEqual(summaryStore(run).namespace, undefined, 'the run namespace (the store\'s default)');
  const proj = await turnEnd({ project: 'acme', summaries: 'mechanical', observations: true, capture: true, project_writes: true });
  assert.strictEqual(summaryStore(proj).namespace, 'project/acme');
});
