'use strict';
// memory-held-settle-xp.test.cjs — the compare-and-set of memory.heldSettle { if_awaiting } across PROCESSES. Two node processes, each with its own Store connection to
// one db file. A (release) has read the hold and is held, by a seam in the child script, just before its write transaction opens; B (reoffer) commits in that gap.
// With the flag A must be refused E_PRECONDITION and the hold stays held with `undecided` cleared; without it the old behaviour (A writes) is what the flag exists
// to stop. A body that kept working from A's pre-transaction read would pass the in-process tests and fail this one.
// Also: isAwaiting is never looser than the SQL predicate the listing uses, over the odd shapes a body can have.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./report-env.cjs');
const { isAwaiting, AWAITING } = require('../../src/core/notes-held.cjs');

let X;
before(async () => { X = await setup('r-xp'); });
after(() => X.cleanup());

async function race(flag, marker, w, wb, bAction = 'reoffer') {
  const a = await X.written(w, marker);
  await X.reported(wb, a.note);
  const h = X.activeHold(a.note);
  await X.call('memory.reviewApply', X.harness, { verdicts: [{ id: a.note, verdict: 'undecided', reason: 'cannot say', held_row: h.id, rev: 0 }] });
  const gate = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-gate-'));
  const child = (role, action) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'held-settle-xp-child.cjs'), role, X.dir, a.note, action, gate, flag], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ role, code, res: out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))[0] || { raw: out } }));
  });
  try {
    const [ra, rb] = await Promise.all([child('A', 'release'), child('B', bAction)]);
    const row = X.store.p('SELECT body FROM memory_entries WHERE id = ?').get(h.id);
    return { ra, rb, hold: JSON.parse(row.body), note: a.note };
  } finally { fs.rmSync(gate, { recursive: true, force: true }); }
}

test('XP1: with if_awaiting, a settle held after its read is refused when another process re-offers in the gap', async () => {
  const { ra, rb, hold } = await race('flag', 'K21', 'w-a21', 'w-b21');
  assert.deepStrictEqual([rb.res.ok, rb.res.outcome], [true, 'reoffered'], JSON.stringify(rb));
  assert.strictEqual(ra.res.ok, false, JSON.stringify(ra));
  assert.strictEqual(ra.res.code, 'E_PRECONDITION');
  assert.strictEqual(ra.res.detail.awaiting, false);
  assert.strictEqual(hold.state, 'held', 'A wrote nothing: the hold is still held');
  assert.ok(hold.undecided == null, 'B cleared the undecided mark');
});

test('XP2: without the flag the same race lets A write (what the flag is for)', async () => {
  const { ra, rb, hold } = await race('noflag', 'K22', 'w-a22', 'w-b22');
  assert.strictEqual(rb.res.ok, true, JSON.stringify(rb));
  assert.strictEqual(ra.res.ok, true, JSON.stringify(ra));
  assert.strictEqual(hold.state, 'released');
});

test('XP4: the settle works from the hold as its own transaction reads it: a report added in the gap is settled too', async () => {
  const { ra } = await race('noflag', 'K23', 'w-a23', 'w-b23', 'addreport');
  assert.strictEqual(ra.res.ok, true, JSON.stringify(ra));
  assert.strictEqual(ra.res.outcome, 'released');
  assert.deepStrictEqual(ra.res.settled.keys.slice().sort(), ['s:1', 's:9'], 'the report added in the gap is settled with the rest');
});

// ---- isAwaiting is never looser than the SQL ----
const SHAPES = [
  ['undecided missing', { rev: 0 }],
  ['undecided null', { rev: 0, undecided: null }],
  ['undecided empty', { rev: 0, undecided: {} }],
  ['undecided.rev null', { rev: 0, undecided: { rev: null } }],
  ['undecided.rev string', { rev: 0, undecided: { rev: '0' } }],
  ['both strings', { rev: '0', undecided: { rev: '0' } }],
  ['undecided.rev float', { rev: 0, undecided: { rev: 0.5 } }],
  ['both float', { rev: 0.5, undecided: { rev: 0.5 } }],
  ['rev missing, undecided 0', { undecided: { rev: 0 } }],
  ['rev missing, undecided 1', { undecided: { rev: 1 } }],
  ['rev null, undecided 0', { rev: null, undecided: { rev: 0 } }],
  ['equal revisions', { rev: 2, undecided: { rev: 2 } }],
  ['older undecided', { rev: 3, undecided: { rev: 2 } }],
  ['undecided is an array', { rev: 0, undecided: [] }],
  ['undecided is a string', { rev: 0, undecided: 'x' }],
  ['undecided.rev true', { rev: 1, undecided: { rev: true } }],
];
test('XP3: isAwaiting is never looser than the SQL AWAITING, and equals it for integer revisions', () => {
  for (const [name, body] of SHAPES) {
    const sql = X.store.p(`SELECT 1 AS x FROM (SELECT ? AS body) h WHERE ${AWAITING}`).get(JSON.stringify(body)) !== undefined;
    const js = isAwaiting(body);
    assert.ok(!js || sql, `${name}: the JS says awaiting where the SQL does not`);
    const ints = ['rev' in body ? body.rev : 0, body.undecided && body.undecided.rev].every((v) => v == null || Number.isInteger(v));
    if (ints && body.undecided && body.undecided.rev != null) assert.strictEqual(js, sql, `${name}: integer revisions agree`);
  }
  assert.strictEqual(isAwaiting(null), false);
});
