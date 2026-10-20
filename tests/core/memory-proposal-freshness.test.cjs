'use strict';
// memory-proposal-freshness.test.cjs — every reader of a proposal row (openProposals, draftsFor, nominationsForScope, memory.notePromote and the
// stranded count of memory.held) applies one freshness rule: the row stores a key for every note it names, and all still match. A re-embedded
// note, or a row whose keys were removed, makes the proposal stale for all of them.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');
const NM = require('../../src/core/memory-nominate.cjs');
const { openProposals } = require('../../src/core/proposal-open.cjs');

let T;
before(async () => {
  T = await setup();
  for (const r of ['rA', 'rB', 'rC']) await T.call(callerFor('orchestrator', { run_id: r }), 'run.attach', { adapter_pid: process.pid, project: PROJECT, memory_levers: JSON.stringify({ project: PROJECT, notes: true, notes_sink: 'record' }) });
});
after(() => T.close());

let ids = 0;
const sight = (task, run, w) => ({ task_id: task, written_by: `worker:${w}`, run_id: run, in_index_beforehand: false, at: 5000, evidence: [] });
const mk = () => { const k = ++ids; return T.note(`fresh nominee ${k}`, { task_id: `a${k}`, run_id: 'rA', created_at: 1000, seen_in: [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')], seen_total: 0 }); };
const nominate = () => T.call(T.who.harness('propose'), 'memory.nominate', {});
const draft = (id) => T.call(T.who.harness('propose'), 'memory.scrubApply', { scrub: [{ id, action: 'draft', reason: 'the lesson holds', draft: { rule: 'Mock the gate in tests.', target: 'CLAUDE.md' } }], scope: [id], ...T.evidence });
const stranded = async () => (await T.call(T.who.operator('apply'), 'memory.held', { reports: true })).stranded;
const reembed = (id) => T.store.p("UPDATE memory_entries SET embedding_model = 'm-next' WHERE id = ?").run(id);
const dropKeys = (rowId) => T.store.patchBody(rowId, (b) => { delete b.keys; return b; });

test('K1: a draft proposal goes stale when its note is re-embedded, for every reader', async () => {
  const n = mk();
  await nominate();
  const made = await draft(n);
  assert.strictEqual(made.counts.proposed, 1, JSON.stringify(made.refused));
  assert.strictEqual(openProposals(T.E, PROJECT).filter((p) => p.note_id === n).length, 1);
  assert.strictEqual(NM.draftsFor(T.E, PROJECT, n, 0).length, 1);
  assert.ok((await stranded()).note_ids.includes(n));
  reembed(n);
  assert.strictEqual(openProposals(T.E, PROJECT).filter((p) => p.note_id === n).length, 0);
  assert.strictEqual(NM.draftsFor(T.E, PROJECT, n, 0).length, 0, 'draftsFor drops the stale draft');
  assert.ok(NM.nominationsForScope(T.E, PROJECT).some((x) => x.id === n), 'the note is asked for a fresh draft');
  assert.ok(!(await stranded()).note_ids.includes(n), 'a stale draft strands nothing');
  await assert.rejects(T.call(T.who.operator('propose'), 'memory.notePromote', { note_id: n, decision: 'approve', reason: 'k1' }), (e) => e.code === 'E_ARGS' && /no drafted rule/.test(e.message));
});

test('K1: a relate proposal goes stale on a re-embed of either note, or when its keys are removed', async () => {
  for (const side of ['note', 'partner']) {
    const o = T.note(`fresh old ${side}`, { vec: A, created_at: 100 });
    const x = T.note(`fresh new ${side}`, { vec: A_NEAR, created_at: 200, matches: [{ id: o, title: 't', kind: 'lesson', basis: 'observed', similarity: 0.95 }] });
    const before = (await stranded()).open_proposals;
    const made = await T.call(T.who.harness('propose'), 'memory.scrubApply', { scrub: [{ id: x, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }], scope: [x, o], ...T.evidence });
    assert.strictEqual(made.counts.proposed, 1, JSON.stringify(made.refused));
    assert.strictEqual((await stranded()).open_proposals, before + 1);
    reembed(side === 'note' ? x : o);
    assert.strictEqual(openProposals(T.E, PROJECT).filter((p) => p.note_id === x).length, 0);
    assert.strictEqual((await stranded()).open_proposals, before, `a re-embedded ${side} leaves the stale row uncounted`);
  }
  const o = T.note('fresh keyless old', { vec: A, created_at: 100 });
  const x = T.note('fresh keyless new', { vec: A_NEAR, created_at: 200, matches: [{ id: o, title: 't', kind: 'lesson', basis: 'observed', similarity: 0.95 }] });
  const before = (await stranded()).open_proposals;
  const made = await T.call(T.who.harness('propose'), 'memory.scrubApply', { scrub: [{ id: x, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }], scope: [x, o], ...T.evidence });
  assert.strictEqual((await stranded()).open_proposals, before + 1);
  dropKeys(made.proposed[0].row.id);
  assert.strictEqual((await stranded()).open_proposals, before, 'a row without keys is stale, never counted');
});
