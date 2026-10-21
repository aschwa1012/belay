'use strict';
// ended-run-in-flight-review.test.cjs — memory.scrubApply and memory.reviewApply check a citation against git, and the run
// can end while they wait (audit D42). The run ends inside the check (the citation seam); every write after it, applied or a
// refusal receipt, meets its guard and nothing is written. Removing the guard from a write makes its test fail.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup } = require('./lifecycle-env.cjs');
const CC = require('../../src/core/memory-citations.cjs');

let T;
before(async () => { T = await setup(); });
after(() => { CC.seam.afterCheck = null; T.close(); });

const ended = (p) => assert.rejects(p, (e) => { assert.strictEqual(e.code, 'E_ARGS', e.message); assert.match(e.message, /has already ended/); return true; });
const endDuringCheck = (run) => { CC.seam.afterCheck = async () => { CC.seam.afterCheck = null; await T.call(T.who.operator(run), 'run.end', { exit_reason: 'test' }); }; };
const count = (sql, ...a) => T.store.p(sql).get(...a).n;
const heldRows = (id) => count("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?", id);
const proposals = () => count("SELECT COUNT(*) AS n FROM memory_entries WHERE namespace LIKE 'proposal/%'");
const wrong = (id, over = {}) => ({ id, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'the loader does throw', cites: [T.cite], ...over });
const scrub = (run, entries) => T.call(T.who.harness(run), 'memory.scrubApply', { scrub: entries, scope: entries.map(e => e.id), ...T.evidence });
const reviewOf = (run, verdicts) => T.call(T.who.harness(run), 'memory.reviewApply', { verdicts, ...T.evidence });

test('a scrub hold whose citation check outlasts run.end is refused as an ended run, not stored as a refused entry, and holds nothing', async () => {
  const n = T.note('scrub apply in flight', { reported_wrong: [T.report()] });
  endDuringCheck('alarm');
  try { await ended(scrub('alarm', [wrong(n)])); } finally { CC.seam.afterCheck = null; }
  assert.strictEqual(heldRows(n), 0, 'no held row');
  assert.strictEqual(T.body(n).held, undefined, 'the note was not marked held');
  assert.strictEqual(T.row(n).namespace, `project/lc`, 'the note was not archived');
});

test('a proposed scrub whose citation check outlasts run.end stores no proposal', async () => {
  const n = T.note('scrub propose in flight', { reported_wrong: [T.report()] });
  const before = proposals();
  endDuringCheck('propose');
  try { await ended(scrub('propose', [wrong(n)])); } finally { CC.seam.afterCheck = null; }
  assert.strictEqual(proposals(), before, 'no proposal row was written into the ended run');
});

test('a reviewer archive whose citation check outlasts run.end archives nothing and verifies nothing', async () => {
  const n = T.note('review apply in flight', { reported_wrong: [T.report()] });
  await scrub('apply', [wrong(n)]);
  assert.strictEqual(heldRows(n), 1);
  endDuringCheck('strict');
  try { await ended(reviewOf('strict', [{ id: n, verdict: 'archive', reason: 'confirmed', cites: [T.cite], same_claim: true }])); } finally { CC.seam.afterCheck = null; }
  assert.strictEqual(T.row(n).namespace, 'project/lc', 'the note was not archived');
  assert.deepStrictEqual(T.store.p("SELECT json_extract(body, '$.reviews') AS r FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").get(n).r, '[]', 'no review entry on the hold');
});

test('a reviewer archive refused after the check, while the run ended in it, writes no refusal receipt', async () => {
  // ground code_contradicts needs a file cite; the reviewer cites a stream only, so the check passes and the archive is refused.
  const n = T.note('review refuse in flight', { reported_wrong: [T.report()] });
  await scrub('apply', [wrong(n, { ground: 'code_contradicts' })]);
  const fs = require('node:fs');
  const stream = `${T.dir}/refuse-stream.jsonl`;
  fs.writeFileSync(stream, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'error: fixture alpha is not listed in the manifest' }] }] } })}\n`);
  const reviews = () => T.store.p("SELECT json_extract(body, '$.reviews') AS r FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").get(n).r;
  endDuringCheck('off');
  try {
    await ended(T.call(T.who.harness('off'), 'memory.reviewApply', { verdicts: [{ id: n, verdict: 'archive', reason: 'confirmed', cites: [{ where: `stream:${stream}`, quote: 'error: fixture alpha is not listed in the manifest' }], same_claim: true }], evidence_files: [stream], ...T.evidence }));
  } finally { CC.seam.afterCheck = null; }
  assert.strictEqual(reviews(), '[]', 'no refusal was recorded on the hold');
});

test('an unsupported note verified while the run ended in the citation check stays unverified', async () => {
  const { queueUnsupported } = require('../../src/core/note-unsupported.cjs');
  const n = T.note('review unsupported in flight', { task_id: 'uns-flight' });
  queueUnsupported(T.E, T.who.harness('plain'), { reviewer: 'rv', ref: 'ref-uns', keyBase: 'k-uns' }, { id: n, reason: 'no single place', cites: [] }, { id: n, task_id: 'uns-flight', run_id: 'old-run' });
  endDuringCheck('apply');
  try { await ended(reviewOf('apply', [{ id: n, verdict: 'verify', reason: 'the loader throws on unlisted names', cites: [T.cite] }])); } finally { CC.seam.afterCheck = null; }
  assert.strictEqual(T.row(n).status ?? 'unverified', 'unverified', 'the note was not verified');
  assert.strictEqual(T.body(n).unsupported.state, 'open', 'the queue row was not settled');
});
