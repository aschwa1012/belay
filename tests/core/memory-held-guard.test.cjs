'use strict';
// memory-held-guard.test.cjs — nothing changes a held note's visibility or status except the explicit operator and the archive review's
// cited outcome on that one note (held-guard.cjs). One case per write of a visibility or status field (the R6 table), each asserting E_HELD,
// an unchanged state and the hold still counted; the operator's own call on the same path succeeds; the run's close stages (the operator on
// the harness channel) have no blanket authority; a grant covers one note, dies when its wrapper returns, and does not leak to another call.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT, A, A_NEAR, B } = require('./lifecycle-env.cjs');
const { callerFor } = require('./helpers.cjs');
const HG = require('../../src/core/held-guard.cjs');

let T;
before(async () => { T = await setup(); });
after(() => T.close());

const NS = `project/${PROJECT}`;
const tool = () => T.who.tool('apply'); // the orchestrator model's tool call
const closeStages = () => T.who.harness('apply'); // orchestrator on the harness channel
const operator = () => T.who.operator('apply'); // the human's own command
const opHarness = () => ({ ...T.who.operator('apply'), channel: 'harness' }); // the run's close stages
const worker = () => callerFor('worker', { run_id: 'lc-apply', worker_id: 'w1' });
const held = (e) => T.call(closeStages(), 'memory.scrubApply', { scrub: [e], scope: [e.id], ...T.evidence }).then((r) => r.applied[0].held);
const wrongHold = (id) => ({ id, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'contradicted by the code', cites: [T.cite] });
const heldCount = async () => (await T.call(tool(), 'memory.held', {})).total;
// A note held for review: a report from another writer, then the wrong hold. Returns { id, hold }.
async function heldNote(title, over = {}) {
  const id = T.note(title, { reported_wrong: [T.report()], ...over });
  const h = await held(wrongHold(id));
  return { id, hold: h.id };
}
const state = (id) => { const r = T.row(id); return JSON.stringify({ ns: r.namespace, st: r.status, receipt: r.status_receipt, sup: r.supersedes, body: r.body }); };
const rejectsHeld = async (p, id, hold, op) => {
  await assert.rejects(p, (e) => e.code === 'E_HELD' && e.detail.id === id && e.detail.held_row === hold && (!op || e.detail.op === op), `expected E_HELD for ${id}`);
};

test('the store-level writes, by caller: the explicit operator passes; a tool call, the close stages, the operator on the harness channel and a bare store do not', async () => {
  const { id, hold } = await heldNote('guard callers');
  const f = { status: 'refuted', receipt: 'test:x', by: 'orchestrator', at: 1 };
  for (const [who, name] of [[tool(), 'orchestrator tool'], [closeStages(), 'close stages'], [opHarness(), 'operator on the harness channel'], [worker(), 'worker']]) {
    assert.throws(() => HG.runAs(who, () => T.store.setStatus(id, f)), (e) => e.code === 'E_HELD' && e.detail.held_row === hold && e.detail.op === 'status', name);
  }
  assert.throws(() => T.store.setStatus(id, f), (e) => e.code === 'E_HELD', 'no context at all');
  assert.strictEqual(T.row(id).status, null);
  const out = HG.runAs(operator(), () => T.store.setStatus(id, f));
  assert.strictEqual(out.status, 'refuted');
});

test('row 1: moving a held note out of project/ is refused; the operator\'s move and an unheld note\'s move are not', async () => {
  const { id, hold } = await heldNote('guard move');
  const before = state(id);
  assert.throws(() => HG.runAs(tool(), () => T.store.moveRow(id, NS, `archive/${PROJECT}`)), (e) => e.code === 'E_HELD' && e.detail.op === 'move' && e.detail.held_row === hold);
  assert.strictEqual(state(id), before, 'no row moved');
  const free = T.note('guard move free');
  HG.runAs(tool(), () => T.store.moveRow(free, NS, `archive/${PROJECT}`));
  assert.strictEqual(T.row(free).namespace, `archive/${PROJECT}`);
  HG.runAs(operator(), () => T.store.moveRow(id, NS, `archive/${PROJECT}`));
  assert.strictEqual(T.row(id).namespace, `archive/${PROJECT}`);
});

test('row 1 (resolve): a worker\'s or the orchestrator\'s refines of a held note is E_HELD naming the hold, and no row moved; a repeat is refused as held for review', async () => {
  const target = await heldNote('guard resolve target', { vec: A });
  const pend = (title, vec) => T.note(title, { ns: `pending/${PROJECT}`, vec, state: 'pending', matches: [{ id: target.id, similarity: 0.99, embedding_model: 'm', dim: 3, template: 'v1' }], written_by: 'worker:w1' });
  const p = pend('guard resolve pending refines', A_NEAR);
  const before = state(target.id);
  await rejectsHeld(T.call(tool(), 'memory.noteResolve', { resolutions: [{ id: p, resolve: 'refines', of: target.id, evidence: [{ where: 'a.js', saw: 'x' }] }] }), target.id, target.hold);
  assert.strictEqual(state(target.id), before);
  assert.strictEqual(T.row(p).namespace, `pending/${PROJECT}`, 'the pending note stays pending');
  const p2 = pend('guard resolve pending supersedes', A_NEAR);
  await rejectsHeld(T.call(tool(), 'memory.noteResolve', { resolutions: [{ id: p2, resolve: 'supersedes', of: target.id, evidence: [{ where: 'a.js', saw: 'x' }] }] }), target.id, target.hold);
  assert.strictEqual(T.row(p2).supersedes, null);
  assert.strictEqual(await heldCount() >= 1, true, 'the hold is still counted');
  const p3 = T.note('guard resolve pending repeats', { ns: `pending/${PROJECT}`, vec: A_NEAR, state: 'pending', matches: [{ id: target.id, similarity: 0.99, embedding_model: 'm', dim: 3, template: 'v1' }], written_by: 'worker:w9', task_id: 'other-task' });
  // Widened 2026-10-25: any hold that withholds the note (here a report_confirmed wrong hold) refuses a repeat, as a reported hold always did.
  await assert.rejects(T.call(tool(), 'memory.noteResolve', { resolutions: [{ id: p3, resolve: 'repeats', of: target.id }] }), (e) => e.code === 'E_ARGS' && e.detail.reason === 'held_for_review');
  assert.strictEqual(T.row(p3).namespace, `pending/${PROJECT}`, 'the repeat waits in pending');
});

test('row 2: restoring B, whose supersedes names a held A, would hide A again: refused for the orchestrator, allowed for the operator', async () => {
  const a = await heldNote('guard restore a', { vec: A });
  const b = T.note('guard restore b', { ns: `archive/${PROJECT}`, vec: A_NEAR, state: 'archived' });
  T.store.p('UPDATE memory_entries SET supersedes = ? WHERE id = ?').run(a.id, b);
  T.store.p("UPDATE memory_entries SET body = ? WHERE id = ?").run(JSON.stringify({ ...T.body(b), archived: { at: 1, from: NS, kind: 'wrong' } }), b);
  const hidden = () => T.store.p('SELECT id FROM memory_entries WHERE supersedes = ? AND namespace = ?').get(a.id, NS);
  await rejectsHeld(T.call(tool(), 'memory.noteRestore', { id: b, reason: 'try' }), a.id, a.hold, 'supersede');
  assert.strictEqual(T.row(b).namespace, `archive/${PROJECT}`);
  assert.strictEqual(hidden(), undefined, 'A is still visible');
  const r = await T.call(operator(), 'memory.noteRestore', { id: b, reason: 'the operator restores it' });
  assert.strictEqual(r.restored, true);
});

test('row 5: the orchestrator\'s memory_verify refuted (test: receipt) on a note is a report, never a status (a held note keeps its hold); the operator may refute', async () => {
  const { id, hold } = await heldNote('guard verify');
  const before = T.row(id);
  const out = await T.call(tool(), 'memory.setStatus', { id, status: 'refuted', receipt: 'test:npm test passed' });
  assert.deepStrictEqual([out.state, out.hold.merged, out.status === 'refuted'], ['held', hold, false], 'the scrubber hold is merged into one reported hold');
  assert.deepStrictEqual([T.row(id).status, T.row(id).namespace, T.row(id).status_receipt], [before.status, before.namespace, before.status_receipt]);
  const free = T.note('guard verify free');
  const rep = await T.call(tool(), 'memory.setStatus', { id: free, status: 'refuted', receipt: 'test:npm test passed' });
  assert.deepStrictEqual([rep.state, rep.status === 'refuted'], ['held', false]);
  assert.strictEqual((await T.call(operator(), 'memory.setStatus', { id, status: 'refuted', receipt: 'test:the operator ran it' })).status, 'refuted');
});

test('row 8: an orchestrator memory.store that supersedes a held note is E_HELD and writes no row; superseding an unheld note works', async () => {
  const { id, hold } = await heldNote('guard store');
  const count = () => T.store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  const n0 = count();
  // A project write by the orchestrator is a note now and takes no supersedes, so the store-level guard is exercised on the run's own namespace.
  await rejectsHeld(T.call(tool(), 'memory.store', { namespace: 'run/lc-apply', text: 'a replacement that hides the held note', supersedes: id, embed: false }), id, hold, 'supersede');
  assert.strictEqual(count(), n0, 'no row written');
  const free = T.note('guard store free');
  const ok = await T.call(tool(), 'memory.store', { namespace: 'run/lc-apply', text: 'a replacement of an unheld note', supersedes: free, embed: false });
  assert.strictEqual(ok.action, 'inserted');
});

test('row 9: a dedup update whose supersedes names a held note is E_HELD; a dedup hit on a held note returns it unchanged, body untouched', async () => {
  const { id, hold } = await heldNote('guard dedup');
  const own = (t) => T.call(tool(), 'memory.store', { namespace: 'run/lc-apply', text: t, embed: false });
  await own('guard dedup own row');
  await assert.rejects(T.call(tool(), 'memory.store', { namespace: 'run/lc-apply', text: 'guard dedup own row', supersedes: id, embed: false }), (e) => e.code === 'E_HELD' && e.detail.held_row === hold);
  assert.strictEqual(T.store.p('SELECT COUNT(*) AS n FROM memory_entries WHERE supersedes = ?').get(id).n, 0);
  const noteRow = T.row(id);
  const unchanged = await T.call(closeStages(), 'memory.store', { namespace: NS, text: noteRow.text, embed: false });
  assert.strictEqual(unchanged.action, 'unchanged');
  assert.strictEqual(T.row(id).body, noteRow.body, 'the note\'s body is untouched');
});

test('row 10: a resolve as supersedes of a held note, by a worker and by the scrubber, is E_HELD', async () => {
  const target = await heldNote('guard supersedes target', { vec: B });
  const pend = T.note('guard supersedes pending', { ns: `pending/${PROJECT}`, vec: B, state: 'pending', matches: [{ id: target.id, similarity: 0.99, embedding_model: 'm', dim: 3, template: 'v1' }], written_by: 'worker:w1', run_id: 'lc-apply' });
  await rejectsHeld(T.call(worker(), 'memory.noteResolve', { resolutions: [{ id: pend, resolve: 'supersedes', of: target.id, evidence: [{ where: 'a.js', saw: 'x' }] }] }), target.id, target.hold);
  await assert.rejects(T.call(closeStages(), 'memory.scrubApply', { scrub: [{ id: pend, action: 'resolve', resolve: 'supersedes', of: target.id, reason: 'newer', ground: null }], scope: [pend, target.id], ...T.evidence }).then((r) => { if (r.refused[0]) throw Object.assign(new Error(r.refused[0].message), { code: r.refused[0].code, detail: r.refused[0].detail }); return r; }), (e) => e.code === 'E_HELD' || e.code === 'E_PRECONDITION');
  assert.strictEqual(T.row(pend).supersedes, null);
});

test('row 11: deleting a held note: the orchestrator is E_ROLE (as before), the close stages are E_HELD, the explicit operator deletes', async () => {
  const { id, hold } = await heldNote('guard delete');
  await assert.rejects(T.call(tool(), 'memory.delete', { id }), (e) => e.code === 'E_ROLE');
  await assert.rejects(T.call(opHarness(), 'memory.delete', { id }), (e) => e.code === 'E_HELD' && e.detail.held_row === hold && e.detail.op === 'delete');
  assert.ok(T.row(id));
  assert.strictEqual((await T.call(operator(), 'memory.delete', { id })).deleted, true);
});

test('row 12: no note path sets a ttl_at, and the sweep leaves a held note alone even then', async () => {
  const { id } = await heldNote('guard ttl');
  assert.strictEqual(T.row(id).ttl_at, null);
  T.store.p('UPDATE memory_entries SET ttl_at = 1 WHERE id = ?').run(id);
  const swept = T.store.sweep();
  assert.ok(T.row(id), 'the held note survives the sweep');
  assert.ok(!swept.namespaces.includes(NS) || T.row(id));
  T.store.p('UPDATE memory_entries SET ttl_at = NULL WHERE id = ?').run(id);
});

test('row 14: changing the body state or promoted_to of a held note outside the operator is E_HELD; other body writes are not', async () => {
  const { id, hold } = await heldNote('guard body');
  assert.throws(() => HG.runAs(tool(), () => T.store.patchBody(id, (b) => { b.state = 'archived'; return b; })), (e) => e.code === 'E_HELD' && e.detail.held_row === hold && e.detail.op === 'body');
  assert.throws(() => HG.runAs(closeStages(), () => T.store.patchBody(id, (b) => { b.promoted_to = { target: 'CLAUDE.md' }; return b; })), (e) => e.code === 'E_HELD');
  HG.runAs(tool(), () => T.store.patchBody(id, (b) => { b.seen_total = (b.seen_total || 0) + 1; return b; }));
  HG.runAs(operator(), () => T.store.patchBody(id, (b) => { b.promoted_to = { target: 'CLAUDE.md', text: 't', at: 1 }; return b; }));
  assert.ok(T.body(id).promoted_to);
});

test('a note queued as unsupported counts as held for every write above', async () => {
  const id = T.note('guard unsupported');
  T.store.storeIn({ namespace: `held/${PROJECT}`, worker_id: 'harness', type: 'held', text: `queued ${id}`, title: 'q', body: { state: 'held', note_id: id, kind: 'unsupported', ground: 'unsupported' }, run_id: 'lc-apply', source: 'harness', written_by: 'harness' });
  const f = { status: 'refuted', receipt: 'test:x', by: 'orchestrator', at: 1 };
  assert.throws(() => HG.runAs(closeStages(), () => T.store.setStatus(id, f)), (e) => e.code === 'E_HELD');
  assert.throws(() => HG.runAs(opHarness(), () => T.store.moveRow(id, NS, `archive/${PROJECT}`)), (e) => e.code === 'E_HELD');
  const scrubbed = await T.call(closeStages(), 'memory.scrubApply', { scrub: [{ id, action: 'relate', relation: 'repeats', of: T.note('guard unsupported other', { vec: A }), reason: 'same' }], scope: [id], ...T.evidence }).catch((e) => ({ refused: [{ code: e.code }] }));
  assert.ok((scrubbed.refused || []).every((r) => r.code === 'E_PRECONDITION' || r.code === 'E_SCOPE'), 'the relation gate refuses it cleanly, before the guard');
  assert.strictEqual(T.row(id).namespace, NS);
});

test('a grant covers one note, in one synchronous transaction: another held note is refused, and the token dies with the wrapper', async () => {
  const a = await heldNote('guard grant a'), b = await heldNote('guard grant b');
  const f = { status: 'verified', receipt: 'review:x', by: 'harness', at: 1 };
  HG.runAs(closeStages(), () => {
    HG.grant('archive_review', a.id, () => { T.store.setStatusIn(a.id, f); });
    assert.strictEqual(T.row(a.id).status, 'verified');
    assert.throws(() => HG.grant('archive_review', a.id, () => T.store.setStatusIn(b.id, f)), (e) => e.code === 'E_HELD' && e.detail.id === b.id, 'the grant of one note covers no other');
    assert.throws(() => T.store.setStatusIn(a.id, f), (e) => e.code === 'E_HELD', 'outside the wrapper there is no authority');
  });
  assert.throws(() => HG.grant('archive_review', a.id, async () => {}), /synchronous/);
});

test('a delayed callback or an unawaited promise created inside a grant cannot reuse its token', async () => {
  const { id, hold } = await heldNote('guard grant expiry');
  const f = { status: 'verified', receipt: 'review:x', by: 'harness', at: 1 };
  const late = [];
  const done = [];
  const completion = () => { let r; const p = new Promise((x) => { r = x; }); done.push(p); return r; };
  await new Promise((resolve) => {
    HG.runAs(closeStages(), () => {
      HG.grant('archive_review', id, () => {
        const t = completion(); setTimeout(() => { try { T.store.setStatusIn(id, f); late.push('timer wrote'); } catch (e) { late.push(`timer ${e.code}`); } t(); }, 0);
        const p = completion(); Promise.resolve().then(() => { try { T.store.setStatusIn(id, f); late.push('promise wrote'); } catch (e) { late.push(`promise ${e.code}`); } p(); });
        const im = completion();
        setImmediate(() => { try { T.store.setStatusIn(id, f); late.push('immediate wrote'); } catch (e) { late.push(`immediate ${e.code}`); } im(); resolve(); });
      });
    });
  });
  await Promise.all(done); // each deferred callback signals its own completion
  assert.deepStrictEqual(late.sort(), ['immediate E_HELD', 'promise E_HELD', 'timer E_HELD']);
  assert.strictEqual(T.row(id).status, null, 'nothing was written');
  assert.ok(hold);
});

test('a grant does not leak to another call: a nested independent call inside the wrapper gets no authority', async () => {
  const a = await heldNote('guard leak a');
  const f = { status: 'verified', receipt: 'review:x', by: 'harness', at: 1 };
  HG.runAs(closeStages(), () => {
    HG.grant('archive_review', a.id, () => {
      assert.throws(() => HG.runAs(tool(), () => T.store.setStatusIn(a.id, f)), (e) => e.code === 'E_HELD', 'another call, even one nested in time, has its own context');
    });
  });
  assert.strictEqual(T.row(a.id).status, null);
});

test('carryReplaced stops at a held ancestor: the archive of the replacing note goes through, the held one stays in project/ and held', async () => {
  const old = await heldNote('guard carry old', { vec: A });
  const mid = T.note('guard carry mid', { vec: A_NEAR, created_at: 500 });
  T.store.p('UPDATE memory_entries SET supersedes = ? WHERE id = ?').run(old.id, mid);
  const kept = T.note('guard carry kept', { vec: A_NEAR, created_at: 900 });
  const A_ = require('../../src/core/memory-archive.cjs');
  const F = require('../../src/core/memory-facts.cjs');
  const done = T.store.tx(() => HG.runAs(operator(), () => A_.archiveNote(T.E, PROJECT, F.loadNote(T.E, mid), { kind: 'superseded', of: kept, ground: 'replaced_by_newer', reason: 'newer', direct: true }, F.loadNote(T.E, kept))));
  assert.deepStrictEqual(done.replaced_also_archived, []);
  assert.strictEqual(T.row(mid).namespace, `archive/${PROJECT}`);
  assert.strictEqual(T.row(old.id).namespace, NS, 'the held ancestor stays');
  assert.strictEqual(T.body(mid).archived.carry_stopped_at, old.id);
  assert.ok(T.body(old.id).held, 'and is still held');
});

test('an archive review of a held note passes under its grant; a plain call of the same path does not', async () => {
  const { id, hold } = await heldNote('guard review');
  const r = await T.call(closeStages(), 'memory.reviewApply', { verdicts: [{ id, verdict: 'archive', reason: 'the code confirms it', cites: [T.cite] }], ...T.evidence });
  assert.strictEqual(r.applied[0].outcome, 'archived', JSON.stringify(r.refused));
  assert.strictEqual(T.row(id).namespace, `archive/${PROJECT}`);
  assert.ok(hold);
});

test('the shape of E_HELD: the code, the note, the hold and the op', async () => {
  const { id, hold } = await heldNote('guard shape');
  try { HG.runAs(tool(), () => T.store.setStatus(id, { status: 'refuted', receipt: 'test:x', by: 'o', at: 1 })); assert.fail('not refused'); } catch (e) {
    assert.deepStrictEqual([e.code, e.detail.id, e.detail.held_row, e.detail.op], ['E_HELD', id, hold, 'status']);
    assert.match(e.message, /held for the archive review/);
  }
});
