'use strict';
// memory-scrub-dead-end.test.cjs — the default propose mode is not a dead end. A pending note stays in the scrub's scope after its run
// ended until it is settled; a mark that is already an open proposal is neither offered nor written again at every close (and is offered
// again in apply mode); the operator is told what waits on them (`memory.held` `stranded`, the `notes_stranded` notice).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');
const { strandedEvents, renderText } = require('../../src/cli/cmd-notices.cjs');

let T;
before(async () => {
  T = await setup();
  const levers = JSON.stringify({ project: PROJECT, notes: true });
  for (const run_id of ['lc-ended', 'lc-live2']) await T.E.handle('run.attach', { caller: callerFor('orchestrator', { run_id }), adapter_pid: process.pid, project: PROJECT, memory_levers: levers });
  await T.E.handle('run.end', { caller: callerFor('orchestrator', { run_id: 'lc-ended' }), exit_reason: 'done' });
});
after(() => T.close());

const scope = (kind) => T.call(T.who.operator(kind), 'memory.scrubScope', {});
const why = (s, id) => (s.items.find((i) => i.id === id) || {}).why;
const pending = (title, run_id, over = {}) => T.note(title, { ns: `pending/${PROJECT}`, state: 'pending', run_id, ...over });
const mark = (kind, entries) => T.call(T.who.harness(kind), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap((e) => [e.id, e.of].filter(Boolean)), ...T.evidence });
const proposalRows = (id) => T.store.p("SELECT id FROM memory_entries WHERE type = 'proposal' AND json_extract(body, '$.note_id') = ?").all(id);
const event = (kind, ids, extra = {}) => T.call(T.who.harness('apply'), 'memory.recordEvent', { kind, run_id: 'lc-apply', key: 'run:lc-apply', row_ids: ids, ...extra });
const match = (id) => ({ id, title: 't', kind: 'lesson', basis: 'observed', similarity: 0.95 });

test('D11: a pending note of an ended run is offered until it is settled; a live run\'s is its writers\' to resolve', async () => {
  const ended = pending('dead end ended run', 'lc-ended');
  const live = pending('dead end live run', 'lc-live2');
  const own = pending('dead end own run', 'lc-apply');
  const s = await scope('apply');
  assert.deepStrictEqual([why(s, ended), why(s, live), why(s, own)], [['pending'], undefined, ['pending']]);
});

test('D11: a pending note the scrub child ignored in two scrubs is dropped from later runs\' scopes', async () => {
  const dropped = pending('dead end dropped', 'lc-ended');
  assert.deepStrictEqual(why(await scope('apply'), dropped), ['pending']);
  await event('scrub_owed', [dropped], { ok: false, code: 'E_DROPPED', message: 'no entry in two scrubs' });
  assert.strictEqual(why(await scope('apply'), dropped), undefined);
});

test('D11: in propose mode a pending note with an open proposal is not offered or proposed again; in apply mode it is offered', async () => {
  const p = pending('dead end proposed', 'lc-ended');
  assert.deepStrictEqual(why(await scope('propose'), p), ['pending'], 'offered before it is proposed');
  const first = await mark('propose', [{ id: p, action: 'resolve', resolve: 'new', reason: 'distinct from every other note' }]);
  assert.strictEqual(first.counts.proposed, 1, JSON.stringify(first.refused));
  assert.strictEqual(first.proposed[0].already_open, undefined);
  const second = await mark('propose', [{ id: p, action: 'resolve', resolve: 'new', reason: 'still distinct, in other words' }]);
  assert.deepStrictEqual([second.proposed[0].already_open, second.proposed[0].row.id], [true, first.proposed[0].row.id], 'the open row comes back');
  assert.strictEqual(proposalRows(p).length, 1, 'one row, not one per close');
  assert.strictEqual(why(await scope('propose'), p), undefined, 'waiting on the operator');
  assert.deepStrictEqual(why(await scope('apply'), p), ['pending'], 'apply mode takes the note up again');
});

test('D11: the same mark on ANOTHER note is a row of its own (a project\'s proposals are not one pool)', async () => {
  const a = pending('dead end twin a', 'lc-ended'), b = pending('dead end twin b', 'lc-ended');
  const ra = await mark('propose', [{ id: a, action: 'resolve', resolve: 'new', reason: 'distinct' }]);
  const rb = await mark('propose', [{ id: b, action: 'resolve', resolve: 'new', reason: 'distinct' }]);
  assert.strictEqual(rb.proposed[0].already_open, undefined);
  assert.notStrictEqual(ra.proposed[0].row.id, rb.proposed[0].row.id);
  assert.deepStrictEqual([proposalRows(a).length, proposalRows(b).length], [1, 1]);
});

test('D11: a proposal for a different mark of the same note is a row of its own', async () => {
  const o = T.note('dead end diff old', { vec: A, created_at: 100 });
  const n = T.note('dead end diff new', { vec: A_NEAR, created_at: 200, matches: [match(o)] });
  const rep = await mark('propose', [{ id: n, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }]);
  const nw = await mark('propose', [{ id: n, action: 'relate', relation: 'new', of: o, reason: 'distinct after all' }]);
  assert.notStrictEqual(rep.proposed[0].row.id, nw.proposed[0].row.id);
  assert.strictEqual(proposalRows(n).length, 2);
  const again = await mark('propose', [{ id: n, action: 'relate', relation: 'repeats', of: o, reason: 'same claim, other words' }]);
  assert.deepStrictEqual([again.proposed[0].already_open, again.proposed[0].row.id], [true, rep.proposed[0].row.id]);
});

test('D11: a matched pair with an open proposal is not offered again in propose mode, and is in apply mode', async () => {
  const o = T.note('dead end pair old', { vec: A, created_at: 100 });
  const n = T.note('dead end pair new', { vec: A_NEAR, created_at: 200, matches: [match(o)] });
  assert.deepStrictEqual(why(await scope('propose'), n), ['matched']);
  await mark('propose', [{ id: n, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }]);
  assert.strictEqual(why(await scope('propose'), n), undefined);
  assert.deepStrictEqual(why(await scope('apply'), n), ['matched']);
});

test('D11: a proposal made on the old vectors does not hide a pair that was re-embedded after it was settled', async () => {
  const o = T.note('dead end stale old', { vec: A, created_at: 100 });
  const n = T.note('dead end stale new', { vec: A_NEAR, created_at: 200, matches: [match(o)] });
  const first = await mark('propose', [{ id: n, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }]);
  assert.strictEqual(first.counts.proposed, 1, JSON.stringify(first.refused));
  assert.strictEqual(why(await scope('propose'), n), undefined, 'the open proposal hides the pair');
  const settled = await mark('apply', [{ id: n, action: 'relate', relation: 'new', of: o, reason: 'distinct after all' }]);
  assert.strictEqual(settled.counts.applied, 1, JSON.stringify(settled.refused));
  assert.strictEqual(why(await scope('propose'), n), undefined, 'judged on the current vectors');
  for (const id of [o, n]) T.store.p("UPDATE memory_entries SET embedding_model = 'm2' WHERE id = ?").run(id); // both notes re-embedded
  assert.deepStrictEqual(why(await scope('propose'), n), ['matched'], 'the judgement and the proposal are both stale: the pair is a new question');
  const again = await mark('propose', [{ id: n, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim, on the new vectors' }]);
  assert.strictEqual(again.proposed[0].already_open, undefined, 'the stale row is not handed back as the open one');
  assert.notStrictEqual(again.proposed[0].row.id, first.proposed[0].row.id);
  assert.strictEqual(why(await scope('propose'), n), undefined, 'the new proposal hides it again');
});

// A proposal row as the store holds it before keys were recorded is stale: it must not hide a pair re-embedded since, nor be handed back
// as the open row.
test('D11: a proposal row written without keys (the earlier row format) is stale, so the re-embedded pair is a new question', async () => {
  const o = T.note('dead end legacy old', { vec: A, created_at: 100 });
  const n = T.note('dead end legacy new', { vec: A_NEAR, created_at: 200, matches: [match(o)] });
  const first = await mark('propose', [{ id: n, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }]);
  assert.strictEqual(first.counts.proposed, 1, JSON.stringify(first.refused));
  const rid = first.proposed[0].row.id;
  const body = JSON.parse(T.store.p('SELECT body FROM memory_entries WHERE id = ?').get(rid).body);
  delete body.keys; // what the store holds from before keys were recorded
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(body), rid);
  const settled = await mark('apply', [{ id: n, action: 'relate', relation: 'new', of: o, reason: 'distinct after all' }]);
  assert.strictEqual(settled.counts.applied, 1, JSON.stringify(settled.refused));
  for (const id of [o, n]) T.store.p("UPDATE memory_entries SET embedding_model = 'm3' WHERE id = ?").run(id);
  assert.deepStrictEqual(why(await scope('propose'), n), ['matched'], 'a keyless proposal does not hide the pair');
  const again = await mark('propose', [{ id: n, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim, new vectors' }]);
  assert.strictEqual(again.proposed[0].already_open, undefined, 'the keyless row is not handed back as the open one');
  assert.notStrictEqual(again.proposed[0].row.id, rid);
});

test('D11: a proposal row that holds a key for only one of the two notes it names is stale', async () => {
  const o = T.note('dead end partial old', { vec: A, created_at: 100 });
  const n = T.note('dead end partial new', { vec: A_NEAR, created_at: 200, matches: [match(o)] });
  const first = await mark('propose', [{ id: n, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }]);
  const rid = first.proposed[0].row.id;
  assert.strictEqual(why(await scope('propose'), n), undefined, 'a complete proposal hides the pair');
  const body = JSON.parse(T.store.p('SELECT body FROM memory_entries WHERE id = ?').get(rid).body);
  delete body.keys[o];
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify(body), rid);
  assert.deepStrictEqual(why(await scope('propose'), n), ['matched'], 'an incomplete proposal does not hide the pair');
});

test('D11: a report that arrives after the proposal brings the note back into the propose scope', async () => {
  const keep = T.note('dead end late keep', { vec: A, created_at: 10 });
  const x = T.note('dead end late report', { vec: A_NEAR, created_at: 20, reported_wrong: [{ ...T.report('worker:w2', keep), run_id: 'lc-propose', at: 1 }] });
  assert.deepStrictEqual(why(await scope('propose'), x), ['replaced_by']);
  await mark('propose', [{ id: x, action: 'relate', relation: 'repeats', of: keep, reason: 'the same claim' }]);
  assert.strictEqual(why(await scope('propose'), x), undefined, 'the report is older than the proposal');
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify({ ...T.body(x), reported_wrong: [{ ...T.report('worker:w3', keep), run_id: 'lc-propose', at: Date.now() + 60000 }] }), x);
  assert.deepStrictEqual(why(await scope('propose'), x), ['replaced_by'], 'a newer report is news');
});

test('D10: a pair this run\'s scrub handled comes back only for a newer STANDING report, not for a rejected one', async () => {
  const keep = T.note('handled keep', { vec: A, created_at: 10 });
  const first = { ...T.report('worker:w2', keep), run_id: 'lc-apply', task_id: 'tx-1', at: 1 };
  const late = { ...T.report('worker:w3', keep), run_id: 'lc-apply', task_id: 'tx-3', at: Date.now() + 120000 };
  const x = T.note('handled report', { vec: A_NEAR, created_at: 20, reported_wrong: [first] });
  assert.deepStrictEqual(why(await scope('apply'), x), ['replaced_by']);
  await event('scrub_job', [x], { ok: true });
  assert.strictEqual(why(await scope('apply'), x), undefined, 'the scrub of this run handled it');
  // a newer report arrives and is rejected: it is not news
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify({ ...T.body(x), reported_wrong: [first, late], report_judgments: [{ task_id: 'tx-3', report_at: late.at, verdict: 'rejected' }] }), x);
  assert.strictEqual(why(await scope('apply'), x), undefined, 'a rejected report is not news');
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify({ ...T.body(x), report_judgments: [] }), x);
  assert.deepStrictEqual(why(await scope('apply'), x), ['replaced_by'], 'unjudged, the newer report is news');
});

test('D11: the operator is told: stranded counts open proposals on unsettled notes and pending notes of ended runs', async () => {
  const S = await setup();
  try {
    const call = (k, m, a) => S.call(S.who.operator(k), m, a);
    assert.strictEqual((await call('apply', 'memory.held', { reports: true })).stranded.total, 0);
    const levers = JSON.stringify({ project: PROJECT, notes: true });
    for (const run_id of ['s-ended', 's-live']) await S.E.handle('run.attach', { caller: callerFor('orchestrator', { run_id }), adapter_pid: process.pid, project: PROJECT, memory_levers: levers });
    await S.E.handle('run.end', { caller: callerFor('orchestrator', { run_id: 's-ended' }), exit_reason: 'done' });
    const p = (title, run_id) => S.note(title, { ns: `pending/${PROJECT}`, state: 'pending', run_id });
    const ended = p('stranded ended', 's-ended'), live = p('stranded live', 's-live');
    assert.deepStrictEqual((await call('apply', 'memory.held', { reports: true })).stranded.note_ids, [ended], 'the live run\'s pending note is not stranded');
    const proposed = await S.call(S.who.harness('propose'), 'memory.scrubApply', { scrub: [{ id: live, action: 'resolve', resolve: 'new', reason: 'distinct' }], scope: [live], ...S.evidence });
    assert.strictEqual(proposed.counts.proposed, 1, JSON.stringify(proposed.refused));
    const st = (await call('apply', 'memory.held', { reports: true })).stranded;
    assert.deepStrictEqual([st.open_proposals, st.pending, st.total, st.by_project], [1, 1, 2, { [PROJECT]: 2 }]);
    assert.deepStrictEqual([...st.note_ids].sort(), [ended, live].sort());
    assert.strictEqual((await call('apply', 'memory.held', { reports: true, project: 'elsewhere' })).stranded.total, 0, 'scoped by project');
    // a proposal whose note has left the unsettled states stops counting
    S.store.p("UPDATE memory_entries SET namespace = ? WHERE id = ?").run(`archive/${PROJECT}`, live);
    assert.strictEqual((await call('apply', 'memory.held', { reports: true })).stranded.open_proposals, 0);
    const [ev] = strandedEvents(st, 'r1');
    assert.deepStrictEqual([ev.kind, ev.count, ev.open_proposals, ev.pending, ev.command], ['notes_stranded', 2, 1, 1, 'belay memory proposals']);
    assert.ok(renderText([ev]).includes('2 notes wait on you (1 open proposal, 1 pending note of ended runs'));
    assert.deepStrictEqual(strandedEvents({ total: 0 }, 'r1'), []);
  } finally { S.close(); }
});

// ---- what stranded counts: a proposal only while its mark is unsettled ----------------------------------------------------------------

async function withStore(fn) {
  const S = await setup();
  try {
    const call = (k, m, a) => S.call(S.who.operator(k), m, a);
    const stranded = async () => (await call('apply', 'memory.held', { reports: true })).stranded;
    const propose = (entries, k = 'propose') => S.call(S.who.harness(k), 'memory.scrubApply', { scrub: entries, scope: entries.flatMap((e) => [e.id, e.of].filter(Boolean)), ...S.evidence });
    await fn({ S, call, stranded, propose });
  } finally { S.close(); }
}

test('D11: a resolve proposal stops counting when the operator resolves the note; one note both pending and proposed counts once', async () => {
  await withStore(async ({ S, call, stranded, propose }) => {
    const levers = JSON.stringify({ project: PROJECT, notes: true });
    await S.E.handle('run.attach', { caller: callerFor('orchestrator', { run_id: 'k-ended' }), adapter_pid: process.pid, project: PROJECT, memory_levers: levers });
    await S.E.handle('run.end', { caller: callerFor('orchestrator', { run_id: 'k-ended' }), exit_reason: 'done' });
    const id = S.note('resolve then settle', { ns: `pending/${PROJECT}`, state: 'pending', run_id: 'k-ended' });
    const first = await propose([{ id, action: 'resolve', resolve: 'new', reason: 'distinct' }]);
    assert.strictEqual(first.counts.proposed, 1, JSON.stringify(first.refused));
    const st = await stranded();
    assert.deepStrictEqual([st.open_proposals, st.pending, st.total, st.by_project, st.note_ids], [1, 1, 1, { [PROJECT]: 1 }, [id]], 'one note, counted once');
    const out = await call('apply', 'memory.noteResolve', { resolutions: [{ id, resolve: 'new' }] });
    assert.ok(S.row(id).namespace.startsWith('project/'), `the note is live now: ${JSON.stringify(out)}`);
    const after = await stranded();
    assert.deepStrictEqual([after.open_proposals, after.pending, after.total, after.note_ids], [0, 0, 0, []], 'the open proposal row no longer strands anything');
    assert.strictEqual(S.store.p("SELECT id FROM memory_entries WHERE type = 'proposal' AND json_extract(body, '$.note_id') = ?").all(id).length, 1, 'the proposal row itself is untouched');
  });
});

test('D11: a relate proposal counts while both notes are live and no new verdict is recorded on the pair, in either direction', async () => {
  await withStore(async ({ S, stranded, propose }) => {
    const o = S.note('relate stranded old', { vec: A, created_at: 100 });
    const n = S.note('relate stranded new', { vec: A_NEAR, created_at: 200, matches: [match(o)] });
    const made = await propose([{ id: n, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }]);
    assert.strictEqual(made.counts.proposed, 1, JSON.stringify(made.refused));
    const first = await stranded();
    assert.deepStrictEqual([first.total, first.note_ids], [1, [n]]);
    const setJudged = (id, of) => S.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify({ ...S.body(id), pair_judged: of ? [{ of }] : [] }), id);
    setJudged(o, n);
    assert.strictEqual((await stranded()).total, 0, 'the verdict recorded on the partner closes it');
    setJudged(o, null); setJudged(n, o);
    assert.strictEqual((await stranded()).total, 0, 'the verdict recorded on the note closes it');
    setJudged(n, null);
    assert.strictEqual((await stranded()).total, 1, 'with the verdicts gone it counts again');
    for (const id of [o, n]) {
      S.store.p('UPDATE memory_entries SET namespace = ? WHERE id = ?').run(`archive/${PROJECT}`, id);
      assert.strictEqual((await stranded()).total, 0, `a pair with an archived ${id === o ? 'partner' : 'note'} is settled`);
      S.store.p('UPDATE memory_entries SET namespace = ? WHERE id = ?').run(`project/${PROJECT}`, id);
    }
    assert.strictEqual((await stranded()).total, 1);
  });
});

test('D11: a relate proposal stops counting once an apply-mode scrub judges the pair new', async () => {
  await withStore(async ({ S, stranded, propose }) => {
    const o = S.note('judged later old', { vec: A, created_at: 100 });
    const n = S.note('judged later new', { vec: A_NEAR, created_at: 200, matches: [match(o)] });
    await propose([{ id: n, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }]);
    assert.strictEqual((await stranded()).total, 1);
    const applied = await propose([{ id: n, action: 'relate', relation: 'new', of: o, reason: 'distinct after all' }], 'apply');
    assert.strictEqual(applied.counts.applied, 1, JSON.stringify(applied.refused));
    assert.ok(S.body(n).pair_judged.length && S.body(o).pair_judged.length, 'pair_judged on both notes');
    const st = await stranded();
    assert.deepStrictEqual([st.open_proposals, st.total, st.note_ids], [0, 0, []], 'the settled pair strands nothing');
  });
});

// ---- the propose scope, pair by pair, and the standing-report reads ----------------------------------------------------------------

test('D11: a proposal about one partner of a note does not hide the pair a worker reported', async () => {
  const keep = T.note('pair keep', { vec: A, created_at: 10 });
  const o = T.note('pair other', { vec: A, created_at: 11 });
  const x = T.note('pair reported', { vec: A_NEAR, created_at: 20, matches: [match(o)], reported_wrong: [{ ...T.report('worker:w2', keep), run_id: 'lc-propose', at: 1 }] });
  assert.deepStrictEqual(why(await scope('propose'), x), ['replaced_by', 'matched']);
  const other = await mark('propose', [{ id: x, action: 'relate', relation: 'repeats', of: o, reason: 'the same claim' }]);
  assert.strictEqual(other.counts.proposed, 1, JSON.stringify(other.refused));
  assert.deepStrictEqual(why(await scope('propose'), x), ['replaced_by'], 'x-to-o is proposed, x-to-keep is not');
  const named = await mark('propose', [{ id: x, action: 'relate', relation: 'repeats', of: keep, reason: 'the same claim' }]);
  assert.strictEqual(named.counts.proposed, 1, JSON.stringify(named.refused));
  assert.strictEqual(why(await scope('propose'), x), undefined, 'both pairs now wait on the operator');
});

test('D11: a rejected report newer than the proposal does not bring the note back; a proposal at the report time covers it', async () => {
  const keep = T.note('rej keep', { vec: A, created_at: 10 });
  const first = { ...T.report('worker:w2', keep), run_id: 'lc-propose', task_id: 'tx-1', at: 5000 };
  const x = T.note('rej report', { vec: A_NEAR, created_at: 20, reported_wrong: [first] });
  const made = await mark('propose', [{ id: x, action: 'relate', relation: 'repeats', of: keep, reason: 'the same claim' }]);
  assert.strictEqual(made.counts.proposed, 1, JSON.stringify(made.refused));
  const late = { ...T.report('worker:w3', keep), run_id: 'lc-propose', task_id: 'tx-3', at: Date.now() + 120000 };
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify({ ...T.body(x), reported_wrong: [first, late], report_judgments: [{ task_id: 'tx-3', report_at: late.at, verdict: 'rejected' }] }), x);
  assert.strictEqual(why(await scope('propose'), x), undefined, 'a rejected report is not news');
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify({ ...T.body(x), reported_wrong: [first], report_judgments: [] }), x);
  T.store.p('UPDATE memory_entries SET created_at = ? WHERE id = ?').run(5000, made.proposed[0].row.id);
  assert.strictEqual(why(await scope('propose'), x), undefined, 'a proposal made at the time of the report covers it');
  T.store.p('UPDATE memory_entries SET created_at = ? WHERE id = ?').run(4999, made.proposed[0].row.id);
  assert.deepStrictEqual(why(await scope('propose'), x), ['replaced_by'], 'a proposal older than the report does not');
});

test('D11: opposite directions of one relation are two proposals (keep is part of the mark)', async () => {
  const o = T.note('keep sig old', { vec: A, created_at: 100 });
  const n = T.note('keep sig new', { vec: A_NEAR, created_at: 200, matches: [match(o)] });
  const a = await mark('propose', [{ id: n, action: 'relate', relation: 'repeats', of: o, keep: 'id', reason: 'the same claim' }]);
  const b = await mark('propose', [{ id: n, action: 'relate', relation: 'repeats', of: o, keep: 'of', reason: 'the same claim' }]);
  assert.strictEqual(a.counts.proposed + b.counts.proposed, 2, JSON.stringify([a.refused, b.refused]));
  assert.strictEqual(b.proposed[0].already_open, undefined);
  assert.strictEqual(proposalRows(n).length, 2);
});

test('D11: a pending note of the run itself that the scrub dropped is still offered to that run, and not to a later one', async () => {
  const own = pending('dead end own dropped', 'lc-apply'), later = pending('dead end later dropped', 'lc-ended');
  await event('scrub_owed', [own, later], { ok: false, code: 'E_DROPPED', message: 'no entry in two scrubs' });
  assert.deepStrictEqual(why(await scope('apply'), own), ['pending'], 'the run own note is its to settle');
  assert.strictEqual(why(await scope('apply'), later), undefined);
});

test('D10: a relate to a note named only by a rejected report is out of scope, as is a hold against it', async () => {
  const keep = T.note('reach keep', { vec: A, created_at: 10 });
  const reported = { ...T.report('worker:w2', keep), run_id: 'lc-apply', task_id: 'tx-r', at: 7 };
  const x = T.note('reach reported', { vec: A_NEAR, created_at: 20, reported_wrong: [reported] });
  const alone = (ent) => T.call(T.who.harness('propose'), 'memory.scrubApply', { scrub: [ent], scope: [x], ...T.evidence });
  const rel = { id: x, action: 'relate', relation: 'repeats', of: keep, reason: 'the same claim' };
  const hold = { id: x, action: 'hold', kind: 'duplicate', of: keep, ground: 'same_claim', reason: 'the same claim', cites: [] };
  for (const [name, ent] of [['relate', rel], ['hold', hold]]) {
    const out = await alone(ent);
    assert.strictEqual(out.counts.proposed, 1, `${name}: an unjudged report names the partner (${JSON.stringify(out.refused)})`);
  }
  T.store.p('UPDATE memory_entries SET body = ? WHERE id = ?').run(JSON.stringify({ ...T.body(x), report_judgments: [{ task_id: 'tx-r', report_at: 7, verdict: 'rejected' }] }), x);
  for (const [name, ent] of [['relate', rel], ['hold', hold]]) {
    const out = await alone({ ...ent, reason: 'now that the report is rejected' });
    assert.deepStrictEqual(out.refused.map((r) => r.code), ['E_SCOPE'], `${name}: a rejected report names no pair (${JSON.stringify(out)})`);
  }
});
