'use strict';
// memory-scrub-strand-drafts.test.cjs — a draft proposal is no mark on a note's state (a later nomination of the same note needs a draft of
// its own, so the open-proposal dedup does not cover it), and `stranded` counts a proposal only while the operator can still settle it: a draft
// while its note's newest nomination is open, the draft is not older than it and the note is not promoted; a relate while both notes pass the
// relation's liveness gate (live, not refuted, not superseded, not held) and neither records a `new` verdict.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');
const NM = require('../../src/core/memory-nominate.cjs');

let T;
before(async () => {
  T = await setup();
  for (const r of ['rA', 'rB', 'rC']) await T.call(callerFor('orchestrator', { run_id: r }), 'run.attach', { adapter_pid: process.pid, project: PROJECT, memory_levers: JSON.stringify({ project: PROJECT, notes: true, notes_sink: 'record' }) });
});
after(() => T.close());

let ids = 0;
const sight = (task, run, w) => ({ task_id: task, written_by: `worker:${w}`, run_id: run, in_index_beforehand: false, at: 5000, evidence: [] });
const mk = () => { const k = ++ids; return T.note(`strand nominee ${k}`, { task_id: `a${k}`, run_id: 'rA', created_at: 1000, seen_in: [sight(`b${k}`, 'rB', 'w2'), sight(`c${k}`, 'rA', 'w3')], seen_total: 0 }); };
const nominate = () => T.call(T.who.harness('propose'), 'memory.nominate', {});
const draft = (id, rule = 'Mock the gate in tests.') => T.call(T.who.harness('propose'), 'memory.scrubApply', { scrub: [{ id, action: 'draft', reason: 'the lesson holds', draft: { rule, target: 'CLAUDE.md' } }], scope: [id], ...T.evidence });
const stranded = async () => (await T.call(T.who.operator('apply'), 'memory.held', { reports: true })).stranded;
const decide = (id, decision) => T.call(T.who.operator('propose'), 'memory.notePromote', { note_id: id, decision, reason: 'k1' });
const nomRows = (id) => T.store.p("SELECT id, created_at, body FROM memory_entries WHERE type = 'nomination' AND json_extract(body, '$.note_id') = ? ORDER BY created_at, rowid").all(id);
const propRows = (id) => T.store.p("SELECT id, created_at FROM memory_entries WHERE type = 'proposal' AND json_extract(body, '$.note_id') = ? ORDER BY created_at, rowid").all(id);
const setAt = (id, at) => T.store.p('UPDATE memory_entries SET created_at = ? WHERE id = ?').run(at, id);
const mine = async (id) => (await stranded()).note_ids.includes(id);

test('K1: a draft proposed for a rejected, then re-nominated note is written again, and the note stops being asked for', async () => {
  const n = mk();
  await nominate();
  const first = await draft(n);
  assert.strictEqual(first.counts.proposed, 1, JSON.stringify(first.refused));
  assert.ok(!NM.nominationsForScope(T.E, PROJECT).some((x) => x.id === n), 'the first draft answers the first nomination');
  await decide(n, 'reject');
  T.store.patchBody(n, (b) => { b.seen_in.push(sight('d-new', 'rC', 'w6')); return b; });
  await nominate();
  const [old, fresh] = nomRows(n);
  assert.deepStrictEqual([JSON.parse(old.body).state, JSON.parse(fresh.body).state], ['rejected', 'nominated']);
  setAt(old.id, 1000); setAt(first.proposed[0].row.id, 1001); setAt(fresh.id, 2000); // fixed times: no same-millisecond ties
  assert.ok(NM.nominationsForScope(T.E, PROJECT).some((x) => x.id === n), 'the new nomination asks for a draft again');
  const second = await draft(n, 'A rule for the second nomination.');
  assert.strictEqual(second.counts.proposed, 1, JSON.stringify(second.refused));
  assert.strictEqual(second.proposed[0].already_open, undefined, 'the old open draft row is not handed back');
  assert.notStrictEqual(second.proposed[0].row.id, first.proposed[0].row.id);
  assert.strictEqual(propRows(n).length, 2);
  assert.ok(!NM.nominationsForScope(T.E, PROJECT).some((x) => x.id === n), 'the second draft answers the new nomination');
});

test('K1: a draft proposal strands its note only while its nomination is open and the note is not promoted', async () => {
  const n = mk();
  await nominate();
  assert.strictEqual(await mine(n), false, 'nominated, no draft yet: the scrubber owes it, not the operator');
  const made = await draft(n);
  assert.strictEqual(made.counts.proposed, 1, JSON.stringify(made.refused));
  assert.strictEqual(await mine(n), true, 'an open draft waits on the operator');
  assert.ok((await stranded()).open_proposals >= 1);
  // promoted_to set (a promotion whose nomination row still reads nominated)
  T.store.patchBody(n, (b) => { b.promoted_to = { target: 'CLAUDE.md', text: 'x', at: 1 }; return b; });
  assert.strictEqual(await mine(n), false, 'a promoted note has nothing left to decide');
  T.store.patchBody(n, (b) => { delete b.promoted_to; return b; });
  assert.strictEqual(await mine(n), true);
  // a later decision on the nomination
  await decide(n, 'reject');
  assert.strictEqual(await mine(n), false, 'a rejected nomination leaves its draft with nothing to decide');
  // a draft older than the note's newest nomination answers a nomination that is over
  T.store.patchBody(n, (b) => { b.seen_in.push(sight('d-new', 'rC', 'w6')); return b; });
  await nominate();
  const rows = nomRows(n), fresh = rows[rows.length - 1];
  assert.strictEqual(JSON.parse(fresh.body).state, 'nominated');
  setAt(made.proposed[0].row.id, fresh.created_at - 10);
  assert.strictEqual(await mine(n), false, 'the earlier nomination draft does not strand the renominated note');
  setAt(made.proposed[0].row.id, fresh.created_at);
  assert.strictEqual(await mine(n), true, 'a draft made for the open nomination does');
});

test('K1: an approved draft proposal strands nothing', async () => {
  const n = mk();
  await nominate();
  await draft(n);
  assert.strictEqual(await mine(n), true);
  const r = await decide(n, 'approve');
  assert.strictEqual(r.nomination.body.state, 'promoted');
  assert.strictEqual(await mine(n), false);
});

test('K1: a relate proposal strands nothing once either note is refuted, superseded or held', async () => {
  const o = T.note('relate gate old', { vec: A, created_at: 100 });
  const x = T.note('relate gate new', { vec: A_NEAR, created_at: 200, matches: [{ id: o, title: 't', kind: 'lesson', basis: 'observed', similarity: 0.95 }] });
  const made = await T.call(T.who.harness('propose'), 'memory.scrubApply', { scrub: [{ id: x, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }], scope: [x, o], ...T.evidence });
  assert.strictEqual(made.counts.proposed, 1, JSON.stringify(made.refused));
  assert.strictEqual(await mine(x), true);
  for (const [id, label] of [[o, 'partner'], [x, 'note']]) {
    T.store.p("UPDATE memory_entries SET status = 'refuted' WHERE id = ?").run(id);
    assert.strictEqual(await mine(x), false, `a refuted ${label} cannot be related`);
    T.store.p("UPDATE memory_entries SET status = 'unverified' WHERE id = ?").run(id);
    assert.strictEqual(await mine(x), true);
    const newer = T.note(`supersedes the ${label}`, { vec: A, created_at: 300 });
    T.store.p('UPDATE memory_entries SET supersedes = ? WHERE id = ?').run(id, newer);
    assert.strictEqual(await mine(x), false, `a superseded ${label} cannot be related`);
    T.store.p('UPDATE memory_entries SET supersedes = NULL WHERE id = ?').run(newer);
    assert.strictEqual(await mine(x), true);
    T.store.patchBody(id, (b) => { b.held = { row: 'h', kind: 'wrong' }; return b; });
    assert.strictEqual(await mine(x), false, `a held ${label} waits on the reviewer, not the operator`);
    T.store.patchBody(id, (b) => { delete b.held; return b; });
    assert.strictEqual(await mine(x), true);
  }
});
