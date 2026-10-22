'use strict';
// memory-copy-note.test.cjs — the project copy of a verified run row (project_writes) goes through memory.store, whose dedup answers a row whose
// text is exactly a note's with that note, unchanged. The copy then set it verified on the run row's test: receipt. A note is verified only by a
// review, so such a copy is refused, for an unheld note and for a held one, and nothing about the note changes.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { setup, PROJECT } = require('./lifecycle-env.cjs');

let T;
after(() => T.close());

const RUN = 'lc-pw';
const orch = () => T.who.tool('apply') && { ...T.who.tool('apply'), run_id: RUN };

before(async () => {
  T = await setup();
  await T.call(orch(), 'run.attach', { adapter_pid: process.pid, project: PROJECT, memory_levers: JSON.stringify({ project: PROJECT, notes: true, project_writes: true }) });
});

async function verifyRunRowWithText(text) {
  const row = await T.call(orch(), 'memory.store', { namespace: `run/${RUN}`, text, embed: false });
  return T.call(orch(), 'memory.setStatus', { id: row.id, status: 'verified', receipt: 'test:npm test passed' });
}
const stateOf = (id) => { const r = T.row(id); return JSON.stringify([r.status, r.status_receipt, r.body]); };

test('an unheld note whose text a verified run row repeats is not verified by the copy', async () => {
  const n = T.note('copy unheld');
  const before = stateOf(n);
  const out = await verifyRunRowWithText(T.row(n).text);
  assert.strictEqual(out.project_copy.ok, false);
  assert.strictEqual(out.project_copy.code, 'E_PRECONDITION');
  assert.match(out.project_copy.message, /verified only by a review/);
  assert.strictEqual(stateOf(n), before, 'the note is as it was');
});

test('a held note is not verified by the copy either, and its hold stays counted', async () => {
  const n = T.note('copy held', { reported_wrong: [T.report()] });
  await T.call(T.who.harness('apply'), 'memory.scrubApply', { scrub: [{ id: n, action: 'hold', kind: 'wrong', ground: 'report_confirmed', reason: 'contradicted', cites: [T.cite] }], scope: [n], ...T.evidence });
  const before = stateOf(n);
  const total = (await T.call(T.who.tool('apply'), 'memory.held', {})).total;
  const out = await verifyRunRowWithText(T.row(n).text);
  assert.strictEqual(out.project_copy.ok, false);
  assert.strictEqual(stateOf(n), before);
  assert.strictEqual((await T.call(T.who.tool('apply'), 'memory.held', {})).total, total);
});

test('a copy of a row that is not a note still lands and is verified (the ordinary path is unchanged)', async () => {
  const out = await verifyRunRowWithText('copy ordinary fact that no note has');
  assert.strictEqual(out.project_copy.ok, true);
  assert.strictEqual(out.project_copy.status, 'verified');
  assert.strictEqual(out.project_copy.namespace, `project/${PROJECT}`);
});
