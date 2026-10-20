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
    assert.match(renderText([ev]), /1 open proposal and 1 pending note of ended runs wait on you/);
    assert.deepStrictEqual(strandedEvents({ total: 0 }, 'r1'), []);
  } finally { S.close(); }
});
