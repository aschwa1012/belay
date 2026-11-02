'use strict';
require('../helpers/tmp.cjs');
// store-invariants-review.test.cjs — the review round: S1 (an errored rule is not a pass), S2 (ended_at transitions), S3 (evaluated counts),
// S4 (a torn copy), and the nits (every done row, unproven pid reuse, scratch folder cleaned).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { checkStore } = require('../helpers/store-invariants.cjs');
const F = require('../helpers/store-invariants-fixture.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'belay-inv-test-'));
const withStore = (fx, fn) => {
  const d = tmp();
  try { F.materialize(fx, d); return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); }
};
const plus = (append) => ({ base: 'clean', append });
const SWEEP = path.join(__dirname, '..', '..', 'scripts', 'sweep-store-invariants.cjs');

test('S1: a table that exists without a column a rule reads is an error, not a pass and not "absent"', () => {
  const d = tmp();
  try {
    const db = new DatabaseSync(path.join(d, 'memory.db'));
    db.exec('CREATE TABLE run(seq INTEGER PRIMARY KEY, id TEXT, ended_at INTEGER, written_by TEXT); CREATE TABLE worker(seq INTEGER PRIMARY KEY, id TEXT, state TEXT)');
    db.close();
    const r = checkStore(d);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 'incomplete');
    assert.deepStrictEqual(r.errors.map((e) => e.rule).sort(), ['run_single_end', 'worker_no_zombie']);
    assert.match(r.errors[0].reason, /lacks column/);
    assert.ok(r.skipped.some((s) => s.rule === 'lease_single_live'), 'an absent table is still only skipped');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('S2: later versions of an ended row with the same ended_at are not a second end; a second null-to-set or a non-operator change is', () => {
  const same = (by) => ({ id: 'r1', epoch: 1, started_at: 900, ended_at: 5001, exit_reason: 'done', written_at: 5200, written_by: by });
  withStore(plus({ run: [same('harness'), same('harness')] }), (d) => {
    assert.deepStrictEqual(checkStore(d).violations, []);
  });
  withStore(plus({ run: [same('harness')] }), (d) => { // strict mode still counts the clean fixture's orchestrator-then-operator overwrite, and only that
    assert.deepStrictEqual(checkStore(d, { strictRunEnd: true }).violations.map((x) => x.rule), ['run_single_end']);
  });
  withStore(plus({ run: [{ id: 'r1', epoch: 1, ended_at: null, written_at: 5300, written_by: 'operator' }, { id: 'r1', epoch: 1, ended_at: 5400, written_at: 5400, written_by: 'operator' }] }), (d) => {
    const r = checkStore(d);
    assert.deepStrictEqual(r.violations.map((x) => x.rule), ['run_single_end']);
    assert.match(r.violations[0].detail, /second null-to-set/);
  });
  withStore(plus({ run: [{ id: 'r1', epoch: 1, ended_at: 5400, written_at: 5400, written_by: 'harness' }] }), (d) => {
    assert.match(checkStore(d).violations[0].detail, /changed at seq \d+ by harness/);
  });
});

test('S3: every rule reports what it evaluated, and the clean fixture evaluates every rule', () => {
  withStore(F.load('clean'), (d) => {
    const r = checkStore(d);
    assert.deepStrictEqual(r.evaluated, { quick_check: 1, lease_single_live: 4, lease_supersedes: 3, done_evidence: 1, run_single_end: 1, worker_no_zombie: 1 });
    assert.ok(r.extra.supersede_exclusions >= 1);
  });
});

test('S3: the sweep script emits per-rule evaluated counts, cleans its scratch folder and has no default root', () => {
  const root = tmp(), out = tmp();
  try {
    const a = path.join(root, 'run-a', 'store'), b = path.join(root, 'run-b', 'store');
    F.materialize(F.load('clean'), a);
    fs.mkdirSync(b, { recursive: true });
    const db = new DatabaseSync(path.join(b, 'memory.db')); db.exec('CREATE TABLE meta(key TEXT)'); db.close();
    const old = new Date(Date.now() - 3600e3);
    for (const p of [path.join(a, 'memory.db'), path.join(b, 'memory.db')]) fs.utimesSync(p, old, old);
    const json = path.join(out, 'r.json');
    const p = spawnSync(process.execPath, [SWEEP, '--root', root, '--json', json, '--scratch', path.join(out, 'scratch')], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    const j = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.strictEqual(j.summary.checked, 2);
    assert.strictEqual(j.perRule.lease_single_live.evaluated, 4);
    assert.strictEqual(j.perRule.lease_single_live.stores_absent, 1);
    assert.deepStrictEqual(j.summary.vacuous_rules, []);
    assert.deepStrictEqual(fs.readdirSync(path.join(out, 'scratch')), [], 'the named scratch path stays and holds no sweep-* leftover');
    assert.strictEqual(spawnSync(process.execPath, [SWEEP], { encoding: 'utf8' }).status, 64);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
});

test('S4: a source that changes during the copy is retried once, then labelled torn and not clean', () => {
  const touch = (d) => () => { const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000)); fs.utimesSync(path.join(d, 'memory.db'), t, t); };
  withStore(F.load('clean'), (d) => {
    let n = 0;
    const r = checkStore(d, { afterCopy: () => { if (n++ === 0) touch(d)(); } });
    assert.strictEqual(r.status, 'clean');
    assert.strictEqual(r.copies, 2, 'one retry');
  });
  withStore(F.load('clean'), (d) => {
    const r = checkStore(d, { afterCopy: touch(d) });
    assert.strictEqual(r.torn, true);
    assert.strictEqual(r.status, 'torn');
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.violations, []);
    assert.match(r.errors[0].reason, /changed during the copy/);
  });
});

test('nits: every done row, unproven pid reuse, a fresh started_at is no evidence, no leftover copies', () => {
  withStore(plus({ task: [{ id: 't1', run_id: 'r1', state: 'done', results: '{"executable":true,"passed":false}', written_at: 2000, written_by: 'operator' }] }), (d) => {
    const r = checkStore(d);
    assert.deepStrictEqual(r.violations.map((x) => x.rule), ['done_evidence']);
    assert.strictEqual(r.evaluated.done_evidence, 2);
  });
  const dead = (pc) => ({ id: 'w6', run_id: 'r1', state: 'dead', pid: 30, pid_created: pc, started_at: 1, written_at: 1900, written_by: 'w6' });
  const run = (pc, started) => ({ id: 'w6', run_id: 'r1', state: 'running', pid: 30, pid_created: pc, started_at: started, written_at: 1950, written_by: 'w6' });
  withStore(plus({ worker: [dead(null), run(null, 1)] }), (d) => {
    const r = checkStore(d);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.unproven.length, 1);
  });
  withStore(plus({ worker: [dead(7), run(7, 999)] }), (d) => {
    assert.deepStrictEqual(checkStore(d).violations.map((x) => x.rule), ['worker_no_zombie']);
  });
  const scratch = tmp();
  try {
    withStore(F.load('clean'), (d) => checkStore(d, { scratch: path.join(scratch, 's') }));
    assert.deepStrictEqual(fs.readdirSync(path.join(scratch, 's')), []);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('S5: the sweep never removes or empties the --scratch path it is given, only its own sweep-* folder', () => {
  const root = tmp(), keep = tmp();
  try {
    F.materialize(F.load('clean'), path.join(root, 'run-a', 'store'));
    const old = new Date(Date.now() - 3600e3);
    fs.utimesSync(path.join(root, 'run-a', 'store', 'memory.db'), old, old);
    fs.writeFileSync(path.join(keep, 'precious.txt'), 'keep');
    fs.mkdirSync(path.join(keep, 'sub'));
    fs.writeFileSync(path.join(keep, 'sub', 'also.txt'), 'keep');
    const p = spawnSync(process.execPath, [SWEEP, '--root', root, '--scratch', keep], { encoding: 'utf8' });
    assert.strictEqual(p.status, 0, p.stderr);
    assert.strictEqual(fs.readFileSync(path.join(keep, 'precious.txt'), 'utf8'), 'keep');
    assert.strictEqual(fs.readFileSync(path.join(keep, 'sub', 'also.txt'), 'utf8'), 'keep');
    assert.deepStrictEqual(fs.readdirSync(keep).sort(), ['precious.txt', 'sub'], 'no sweep-* folder is left behind');
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(keep, { recursive: true, force: true }); }
});

test('N8: a store with violations and an errored rule is counted as incomplete too', () => {
  const d = tmp();
  try {
    F.materialize(F.load('planted/done_evidence'), d);
    const db = new DatabaseSync(path.join(d, 'memory.db'));
    db.exec('DROP TABLE run; CREATE TABLE run(seq INTEGER PRIMARY KEY, id TEXT)');
    db.close();
    const r = checkStore(d);
    assert.strictEqual(r.status, 'violations');
    assert.strictEqual(r.incomplete, true);
    assert.strictEqual(r.ok, false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
