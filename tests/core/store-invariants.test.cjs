'use strict';
require('../helpers/tmp.cjs');
// store-invariants.test.cjs — each planted fixture is caught by exactly its rule, the clean fixture passes, and the original store
// is never touched (same sha256 for the db and its sidecars before and after, no sidecar created beside it).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkStore, RULES } = require('../helpers/store-invariants.cjs');
const F = require('../helpers/store-invariants-fixture.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'belay-inv-test-'));
const planted = fs.readdirSync(path.join(F.DIR, 'planted')).map((f) => f.replace(/\.json$/, ''));

test('every rule has a planted fixture', () => {
  assert.deepStrictEqual([...planted].sort(), [...RULES].sort());
});

test('the clean fixture passes every rule', () => {
  const d = tmp();
  try {
    F.materialize(F.load('clean'), d);
    const r = checkStore(d);
    assert.deepStrictEqual(r.violations, []);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([...r.rules_run].sort(), [...RULES].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

for (const name of planted) {
  test(`planted ${name} is caught by exactly that rule`, () => {
    const d = tmp();
    try {
      F.materialize(F.load('planted/' + name), d);
      const r = checkStore(d, { hashOriginals: true });
      assert.strictEqual(r.ok, false);
      assert.deepStrictEqual(r.errors, [], 'no rule threw on the planted store');
      assert.deepStrictEqual([...new Set(r.violations.map((x) => x.rule))], [name], JSON.stringify(r.violations));
      assert.deepStrictEqual(r.hashes.before, r.hashes.after);
      assert.deepStrictEqual(fs.readdirSync(d), ['memory.db']);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
}

test('a WAL store held open by its writer is read from a copy and left byte-identical', () => {
  const d = tmp();
  const m = F.materialize(F.load('clean'), d, { wal: true, keepOpen: true });
  try {
    const before = fs.readdirSync(d).sort();
    assert.ok(before.includes('memory.db-wal'), 'the fixture has a WAL sidecar: ' + before);
    const r = checkStore(d, { hashOriginals: true });
    assert.strictEqual(r.ok, true, JSON.stringify(r.violations));
    assert.deepStrictEqual(r.hashes.before, r.hashes.after);
    assert.deepStrictEqual(fs.readdirSync(d).sort(), before);
  } finally { m.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('strictRunEnd counts the legitimate orchestrator-then-operator pair as two ends', () => {
  const d = tmp();
  try {
    F.materialize(F.load('clean'), d);
    assert.strictEqual(checkStore(d).ok, true);
    assert.deepStrictEqual(checkStore(d, { strictRunEnd: true }).violations.map((x) => x.rule), ['run_single_end']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a missing table skips its rules by name and does not pass them silently', () => {
  const d = tmp();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(d, 'memory.db'));
    db.exec('CREATE TABLE meta(key TEXT, value TEXT)');
    db.close();
    const r = checkStore(d);
    assert.deepStrictEqual(r.rules_run, ['quick_check']);
    assert.strictEqual(r.skipped.length, RULES.length - 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('teardown check: assertStoreInvariants throws on a planted violation, passes a clean store and a missing one', () => {
  const { assertStoreInvariants } = require('../helpers/store-invariants.cjs');
  const d = tmp();
  try {
    assert.strictEqual(assertStoreInvariants(d), null, 'no store, nothing to check');
    F.materialize(F.load('clean'), d);
    assert.strictEqual(assertStoreInvariants(d).ok, true);
    fs.rmSync(path.join(d, 'memory.db'));
    F.materialize(F.load('planted/lease_single_live'), d);
    assert.throws(() => assertStoreInvariants(d), /lease_single_live/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('teardown check: cleanup checks the sandbox store by default, and an opt-out needs a reason', () => {
  const H = require('./helpers.cjs');
  const d = H.sandbox();
  F.materialize(F.load('planted/done_evidence'), d);
  assert.throws(() => H.cleanup(d, { skipInvariants: 'a string' }), /needs { rules/);
  assert.throws(() => H.cleanup(d, { skipInvariants: { rules: ['done_evidence'], reason: ' ' } }), /needs { rules/);
  assert.throws(() => H.cleanup(d, { skipInvariants: { rules: ['lease_supersedes'], reason: 'wrong rule' } }), /done_evidence/);
  assert.strictEqual(fs.existsSync(d), false, 'the sandbox is removed before the violation is thrown');
  const e = H.sandbox();
  F.materialize(F.load('planted/done_evidence'), e);
  assert.throws(() => H.cleanup(e), /done_evidence/);
  const f = H.sandbox();
  F.materialize(F.load('planted/done_evidence'), f);
  H.cleanup(f, { skipInvariants: { rules: ['done_evidence'], reason: 'a planted violation' } });
  assert.strictEqual(fs.existsSync(f), false);
  const c = H.sandbox();
  F.materialize(F.load('clean'), path.join(c, '.belay'));
  H.cleanup(c);
  assert.strictEqual(fs.existsSync(c), false);
});
