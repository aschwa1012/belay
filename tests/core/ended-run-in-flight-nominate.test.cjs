'use strict';
// ended-run-in-flight-nominate.test.cjs — memory.nominate counts a note's sightings with an await and writes the nomination
// after it, so a run.end that commits in between must be seen by the write (audit D42). The seam is the count's own store read:
// the first note_chance query ends the run, synchronously, inside the wait. Taking the guard out of the write makes the
// nomination land in the ended run.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');

let T;
before(async () => {
  T = await setup();
  // The runs that produced the sightings recorded delivery facts (notes_sink record), so their sightings count.
  for (const r of ['rA', 'rB', 'rC']) await T.call(callerFor('orchestrator', { run_id: r }), 'run.attach', { adapter_pid: process.pid, project: PROJECT, memory_levers: JSON.stringify({ project: PROJECT, notes: true, notes_sink: 'record' }) });
});
after(() => T.close());

const nominations = () => T.store.p("SELECT * FROM memory_entries WHERE type = 'nomination'").all();
const sight = (task, run) => ({ task_id: task, written_by: 'worker:w2', run_id: run, in_index_beforehand: false, at: 5000, evidence: [] });
const qualifying = (tag) => T.note(`nominee ${tag} about the gate`, { task_id: `a-${tag}`, run_id: 'rA', created_at: 1000, seen_in: [sight(`b-${tag}`, 'rB'), sight(`c-${tag}`, 'rC')] });

// Ends the run the first time the count reads delivery facts; returns the promise of that run.end.
function endRunInTheCount() {
  let ending = null;
  const p = T.store.p.bind(T.store);
  T.store.p = (sql) => {
    if (!ending && /kind = 'note_chance'/.test(sql)) ending = T.call(T.who.operator('propose'), 'run.end', { exit_reason: 'test' }); // commits before its first await
    return p(sql);
  };
  return { done: async () => { T.store.p = p; await ending; }, started: () => ending !== null };
}

test('a nomination whose run ended while the sightings were counted is refused and writes no nomination row', async () => {
  const id = qualifying('one');
  const seam = endRunInTheCount();
  try {
    await assert.rejects(T.call(T.who.harness('propose'), 'memory.nominate', {}), (e) => { assert.strictEqual(e.code, 'E_ARGS', e.message); assert.match(e.message, /has already ended/); return true; });
  } finally { await seam.done(); }
  assert.ok(seam.started(), 'the run ended inside the count');
  assert.strictEqual(nominations().length, 0, 'no nomination row was written into the ended run');
  assert.strictEqual(T.row(id).namespace, `project/${PROJECT}`);
});
