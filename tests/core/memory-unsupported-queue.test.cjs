'use strict';
// memory-unsupported-queue.test.cjs — the `unsupported` note verdict (operator, 2026-10-17): a normal unverified note in its own on-demand queue
// kind, settled by the Opus archive reviewer on cites (verify, refute, still_unsupported). Real core against a sandbox store, a real stream file
// and a real git repo. Nothing here starts a model.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { setup } = require('./report-env.cjs');

let X;
before(async () => { X = await setup('r-uns'); });
after(() => X.cleanup());
const call = (...a) => X.call(...a);
const written = (...a) => X.written(...a);
const reported = (...a) => X.reported(...a);
const review = (...a) => X.review(...a);
const apply = (...a) => X.apply(...a);
const briefOf = (...a) => X.briefOf(...a);
const rowOf = (id) => X.rowOf(id);
const bodyOf = (id) => X.bodyOf(id);
const events = (k) => X.events(k);
const cite = (...a) => X.cite(...a);
const orch = () => X.orch;
const harness = () => X.harness;
const mark = (id, status) => X.store.p('UPDATE memory_entries SET status = ? WHERE id = ?').run(status, id);
const heldFor = (id) => X.store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").get(id).n;
const UPHELD = (id) => [X.rv(id, 'upheld', [cite(X.UP)], 'the stream shows the file was opened')];

const UNS = (id, over = {}) => ({ id, verdict: 'unsupported', reason: 'no single place proves or disproves it', ...over });
const queued = (id) => X.store.p("SELECT id, body FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").all(id).map((r) => ({ id: r.id, b: JSON.parse(r.body) }));
const streamOf = (w) => `${X.dir}/workers/${w}/stream.jsonl`.replace(/\\/g, '/');
const applyReview = (verdicts, files) => call('memory.reviewApply', X.harness, { verdicts, evidence_files: files, worktree: X.repo });
async function unsupportedNote(w, marker) {
  const a = await written(w, marker);
  const rt = await review(`rev-${w}`, a.task, { memory_verdicts: [UNS(a.note)] });
  const out = await apply(rt);
  return { ...a, rt, out };
}

test('U1: a reviewer answers unsupported with a reason and no cites: the note stays unverified with no warning, and is queued as its own kind', async () => {
  const u = await unsupportedNote('w-u1', 'K20');
  assert.deepStrictEqual([u.out.applied.length, u.out.applied[0].verdict, u.out.applied[0].status, u.out.refused.length], [1, 'unsupported', 'unverified', 0], JSON.stringify(u.out));
  const n = rowOf(u.note), b = bodyOf(u.note);
  assert.deepStrictEqual([n.status ?? 'unverified', n.namespace, b.held, b.unsupported.state], ['unverified', 'project/acme', undefined, 'open']);
  const q = queued(u.note);
  assert.deepStrictEqual([q.length, q[0].b.kind, q[0].b.state, q[0].b.ground, q[0].b.cites], [1, 'unsupported', 'held', 'unsupported', []]);
  assert.strictEqual(events('note_refuted').filter((e) => e.key === `refuted:${u.note}`).length, 0, 'no wake');
  const queue = await call('memory.reviewQueue', X.harness, {});
  assert.ok(queue.held.some((h) => h.id === u.note && h.kind === 'unsupported' && h.note.run_id));
  const held = await call('memory.held', X.orch, {});
  assert.ok(held.unsupported >= 1 && held.unsupported_by_project.acme >= 1 && held.total >= held.unsupported);
  const again = await apply(u.rt);
  assert.strictEqual(again.already.length, 1);
  assert.strictEqual(queued(u.note).length, 1, 'a second application queues nothing more');
  const brief = await briefOf(u.task);
  assert.ok(!brief.notes.some((x) => x.id === u.note), 'an unsupported note is not offered to a note review again');
});

test('U3: the Opus reviewer verifies an unsupported note on cites: verified, receipt returned, off the queue', async () => {
  const u = await unsupportedNote('w-u3', 'K22');
  const r = await applyReview([{ id: u.note, verdict: 'verify', reason: 'the stream shows the loader works as stated', cites: [{ where: `stream:${streamOf('w-u3')}`, quote: 'the loader worked as the note says' }], shown_hash: require('../../src/core/note-brief-capture.cjs').hashOfRow(rowOf(u.note)) }], [streamOf('w-u3')]);
  assert.deepStrictEqual([r.applied.length, r.refused.length, r.applied[0].outcome, r.applied[0].status], [1, 0, 'verified', 'verified'], JSON.stringify(r));
  assert.match(r.applied[0].receipt, /^review:r-uns:/);
  const n = rowOf(u.note);
  assert.deepStrictEqual([n.status, n.status_receipt, bodyOf(u.note).unsupported.state, queued(u.note)[0].b.state], ['verified', r.applied[0].receipt, 'verified', 'verified']);
  assert.ok(!(await call('memory.reviewQueue', X.harness, {})).held.some((h) => h.id === u.note));
});

test('U4: refute marks the note refuted with the wake receipt; still_unsupported leaves the queue and the note unverified', async () => {
  const u = await unsupportedNote('w-u4', 'K23');
  const r = await applyReview([{ id: u.note, verdict: 'refute', reason: 'the stream shows the opposite', cites: [{ where: `stream:${streamOf('w-u4')}`, quote: 'the loader worked as the note says' }] }], [streamOf('w-u4')]);
  assert.deepStrictEqual([r.applied[0].outcome, rowOf(u.note).status, bodyOf(u.note).unsupported.state], ['refuted', 'refuted', 'refuted']);
  assert.strictEqual(events('note_refuted').filter((e) => e.key === `refuted:${u.note}`).length, 1, 'the orchestrator wake source');
  const s = await unsupportedNote('w-u5', 'K24');
  const r2 = await applyReview([{ id: s.note, verdict: 'still_unsupported', reason: 'the evidence does not settle it' }], []);
  assert.deepStrictEqual([r2.applied[0].outcome, r2.applied[0].receipt.startsWith('review:r-uns:')], ['still_unsupported', true]);
  assert.deepStrictEqual([rowOf(s.note).status ?? 'unverified', bodyOf(s.note).unsupported.state, bodyOf(s.note).held], ['unverified', 'still_unsupported', undefined]);
  assert.ok(!(await call('memory.reviewQueue', X.harness, {})).held.some((h) => h.id === s.note));
  const brief = await briefOf(s.task);
  assert.ok(!brief.notes.some((x) => x.id === s.note), 'it is not offered to a note review again');
});

test('U5: wrong answers for the kind are refused with a reason; a verify without a real cite is refused and written on the row', async () => {
  const u = await unsupportedNote('w-u6', 'K25');
  const wrongKind = await applyReview([{ id: u.note, verdict: 'archive', reason: 'x', cites: [] }], []);
  assert.deepStrictEqual([wrongKind.applied.length, wrongKind.refused[0].code], [0, 'E_PRECONDITION']);
  const noCite = await applyReview([{ id: u.note, verdict: 'verify', reason: 'looks right' }], []);
  assert.deepStrictEqual([noCite.refused[0].code, noCite.refused[0].outcome], ['E_CITATION', 'refused']);
  const fake = await applyReview([{ id: u.note, verdict: 'refute', reason: 'wrong', cites: [{ where: `stream:${streamOf('w-u6')}`, quote: 'a line that was never in the stream' }] }], [streamOf('w-u6')]);
  assert.strictEqual(fake.refused[0].code, 'E_CITATION');
  assert.strictEqual(rowOf(u.note).status ?? 'unverified', 'unverified');
  assert.strictEqual(queued(u.note)[0].b.reviews.length, 2, 'both refusals are on the row');
  assert.strictEqual(queued(u.note)[0].b.state, 'held', 'still in the queue');
});

test('U6: a hold with a warning takes archive or release only', async () => {
  const a = await written('w-a30', 'K26');
  const tb = await reported('w-b30', a.note);
  await apply(await review('rev-30', tb, { report_verdicts: UPHELD(a.note) }));
  const r = await applyReview([{ id: a.note, verdict: 'verify', reason: 'x', cites: [cite('the loader worked as the note says')] }], []);
  assert.deepStrictEqual([r.applied.length, r.refused[0].code], [0, 'E_PRECONDITION']);
});

test('U7: verify or refute cites only TOOL RESULTS of non-belay tools: the note itself, belay tool inputs, assistant prose and the task brief are refused', async () => {
  const u = await unsupportedNote('w-u7', 'K27');
  const note = rowOf(u.note);
  const BRIEF = 'The loader is known to be fine with empty input per the maintainer';
  const PROSE = 'loadConfig handles empty files by returning defaults, I checked it';
  const INPUT = 'belay-input-only-phrase-for-the-lease-release';
  const REAL = 'REAL-TOOL-OUTPUT: the loader returned defaults for the empty file';
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(streamOf('w-u7'),
    line({ type: 'user', message: { role: 'user', content: BRIEF } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: PROSE }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tb1', name: 'mcp__belay__lease_release', input: { notes: [{ title: note.title, text: INPUT }] } }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tr1', name: 'Bash', input: { command: 'run-it' } }] } })
    + line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tr1', content: [{ type: 'text', text: REAL }] }] } }));
  const forbidden = [['the note itself', note.title], ['the task brief', BRIEF], ['assistant prose', PROSE], ['a belay tool input', INPUT]];
  for (const [what, quote] of forbidden) {
    for (const verdict of ['verify', 'refute']) {
      const r = await applyReview([{ id: u.note, verdict, reason: 'x', cites: [{ where: `stream:${streamOf('w-u7')}`, quote }] }], [streamOf('w-u7')]);
      assert.deepStrictEqual([r.applied.length, r.refused[0] && r.refused[0].code], [0, 'E_CITATION'], `${what} / ${verdict}: ${JSON.stringify(r.refused)}`);
    }
  }
  assert.strictEqual(rowOf(u.note).status ?? 'unverified', 'unverified');
  assert.strictEqual(events('note_refuted').filter((e) => e.key === `refuted:${u.note}`).length, 0, 'no wake from a refused refute');
  const ok = await applyReview([{ id: u.note, verdict: 'refute', reason: 'the tool output shows defaults', cites: [{ where: `stream:${streamOf('w-u7')}`, quote: REAL }] }], [streamOf('w-u7')]);
  assert.deepStrictEqual([ok.applied.length, rowOf(u.note).status], [1, 'refuted'], 'a real tool result is evidence');
});
