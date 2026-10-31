'use strict';
// policy-steps.test.cjs -- the policy step store (policy.claim, policy.finish, policy.list) and the schema bump that carries it.
// The claim is one INSERT under a UNIQUE key, so the proofs are: a double claim answers the first row, two claimants of one trigger
// (one stalled between its validation and its INSERT by the fault-injection seam) leave exactly one row, an older store migrates, and
// reading the new store creates no file. Real core and sandbox stores; no sleeps, no load.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { core, sandbox, cleanup, callerFor, listDataDir } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { openCore } = core('index.cjs');
const steps = core('policy-steps.cjs');
const { SCHEMA_VERSION } = core('schema-stamp.cjs');

const HARNESS = { role: 'operator', run_id: 'r1', channel: 'harness' };
const E = (store) => ({ store, noteWrite() {}, writtenBy: (c) => c.role });
const TRIG = { table: 'task', id: 't-1', seq: 4 };
const seedTask = (store, id) => Number(store.p("INSERT INTO task(id, run_id, spec, state, written_at, written_by) VALUES (?, 'r1', 'x', 'open', 1, 'orchestrator')").run(id).lastInsertRowid);
const rowsOf = (store) => store.p('SELECT * FROM policy_step ORDER BY seq').all();

async function rejectsCode(p, code) {
  await assert.rejects(p, (e) => { assert.strictEqual(e.code, code, e.message); return true; });
}

test('the schema is version 3 and a fresh store has the policy tables and step columns', () => {
  const d = sandbox();
  try {
    assert.strictEqual(SCHEMA_VERSION, 3);
    const s = new Store(path.join(d, 'memory.db'), { stamp: true });
    try {
      const cols = (t) => s.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      assert.deepStrictEqual(cols('policy_step'), ['seq', 'run_id', 'task_id', 'step', 'trigger_table', 'trigger_id', 'trigger_seq', 'policy_rev', 'outcome', 'row_ref', 'error', 'worker_id', 'turn', 'at', 'finished_at', 'claimant_pid', 'claimant_created']);
      assert.deepStrictEqual(cols('check_flake'), ['argv', 'cwd', 'key_sha', 'key_kind', 'pass_n', 'fail_n', 'flips', 'last_outcome', 'last_concurrent', 'first_at', 'last_at']);
      for (const t of ['task', 'lease', 'integration']) for (const c of ['acted_by', 'trigger', 'policy_rev']) assert.ok(cols(t).includes(c), `${t}.${c}`);
      assert.ok(cols('task').includes('policy'));
      assert.strictEqual(s.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '3');
    } finally { s.close(); }
  } finally { cleanup(d); }
});

test('a double claim answers the first row with existing: true, and writes no second row', async () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    const first = await steps.claim(E(s), HARNESS, { task_id: 't-1', step: 'fix', trigger: TRIG, policy_rev: 2, worker_id: 'w-9', turn: 7 });
    assert.strictEqual(first.existing, false);
    assert.deepStrictEqual({ ...first.row }, { seq: first.row.seq, run_id: 'r1', task_id: 't-1', step: 'fix', trigger_table: 'task', trigger_id: 't-1', trigger_seq: 4, policy_rev: 2, outcome: 'started', row_ref: null, error: null, worker_id: 'w-9', turn: 7, at: first.row.at, finished_at: null, claimant_pid: null, claimant_created: null });
    const again = await steps.claim(E(s), HARNESS, { task_id: 't-1', step: 'fix', trigger: TRIG, policy_rev: 3 });
    assert.strictEqual(again.existing, true);
    assert.deepStrictEqual({ ...again.row }, { ...first.row }, 'the first row, untouched by the second claimant (its rev, worker and turn are not written over it)');
    assert.strictEqual(rowsOf(s).length, 1);
    // A different step, or the same step on the next version of the trigger row, is its own claim.
    assert.strictEqual((await steps.claim(E(s), HARNESS, { step: 're_review', trigger: TRIG })).existing, false);
    assert.strictEqual((await steps.claim(E(s), HARNESS, { step: 'fix', trigger: { ...TRIG, seq: 5 } })).existing, false);
    assert.strictEqual((await steps.claim(E(s), { ...HARNESS, run_id: 'r2' }, { step: 'fix', trigger: TRIG })).existing, false, 'another run is not the same trigger');
    assert.strictEqual(rowsOf(s).length, 4);
  } finally { s.close(); cleanup(d); }
});

test('two connections claim one trigger, one stalled before its INSERT: exactly one row results', async () => {
  const d = sandbox();
  const f = path.join(d, 'memory.db');
  const a = new Store(f, { stamp: true });
  const b = new Store(f, {});
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    let reached;
    const parked = new Promise((r) => { reached = r; });
    let stalls = 0;
    steps.setHooksForTest({ beforeInsert: async () => { if (stalls++ === 0) { reached(); await gate; } } });
    const slow = steps.claim(E(a), HARNESS, { step: 'integrate', trigger: TRIG });
    await parked; // claimant A has validated its claim and found nothing, and now waits
    const fast = await steps.claim(E(b), HARNESS, { step: 'integrate', trigger: TRIG });
    assert.strictEqual(fast.existing, false, 'B took the trigger while A was stalled');
    release();
    const late = await slow;
    assert.strictEqual(late.existing, true, 'A, released after B committed, is told it lost');
    assert.strictEqual(late.row.seq, fast.row.seq);
    assert.strictEqual(rowsOf(a).length, 1);
    assert.strictEqual(rowsOf(b).length, 1);
  } finally { steps.setHooksForTest(null); a.close(); b.close(); cleanup(d); }
});

test('finish moves a claim once and names its effect; it refuses a step without one', async () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    const { row } = await steps.claim(E(s), HARNESS, { step: 'fix', trigger: TRIG });
    await rejectsCode(steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'done' }), 'E_ARGS'); // success with no row
    await rejectsCode(steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'exception' }), 'E_ARGS'); // failure with no error
    await rejectsCode(steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'started', row_ref: 'x' }), 'E_ARGS');
    await rejectsCode(steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'superseded' }), 'E_ARGS');
    await rejectsCode(steps.finish(E(s), HARNESS, { seq: 999, outcome: 'skipped', error: 'x' }), 'E_NOT_FOUND');
    await rejectsCode(steps.finish(E(s), { ...HARNESS, run_id: 'other' }, { seq: row.seq, outcome: 'skipped', error: 'x' }), 'E_NOT_FOUND');
    assert.strictEqual(rowsOf(s)[0].outcome, 'started', 'every refusal left the claim as it was');
    // The row a step says it wrote must exist, in a grammar the checkers can split.
    for (const bad of ['task:fix-1', 'task:fix-1:1', 'nowhere:x', 'task', 'task:', 'task:a:b', 'task:a:1:2']) {
      await rejectsCode(steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'done', row_ref: bad }), bad === 'task:fix-1' || bad === 'task:fix-1:1' ? 'E_NOT_FOUND' : 'E_ARGS');
    }
    assert.strictEqual(rowsOf(s)[0].outcome, 'started', 'a ref to nothing recorded nothing');
    const tseq = seedTask(s, 'fix-1');
    await rejectsCode(steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'done', row_ref: `task:fix-1:${tseq + 50}` }), 'E_NOT_FOUND'); // the id exists, that version does not
    // A row of another run is not this step's effect; a row with no run id passes.
    const other = Number(s.p("INSERT INTO task(id, run_id, spec, state, written_at, written_by) VALUES ('alien', 'r9', 'x', 'open', 1, 'orchestrator')").run().lastInsertRowid);
    await rejectsCode(steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'done', row_ref: `task:alien:${other}` }), 'E_ARGS');
    await rejectsCode(steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'done', row_ref: 'task:alien' }), 'E_ARGS');
    await rejectsCode(steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'done', row_ref: 'run:r9' }), 'E_NOT_FOUND');
    s.p("INSERT INTO task(id, run_id, spec, state, written_at, written_by) VALUES ('nullrun', NULL, 'x', 'open', 1, 'orchestrator')").run();
    assert.strictEqual(rowsOf(s)[0].outcome, 'started');
    const done = await steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'done', row_ref: `task:fix-1:${tseq}` });
    assert.strictEqual(done.row.seq, row.seq);
    assert.strictEqual(done.row.outcome, 'done');
    assert.strictEqual(done.row.row_ref, `task:fix-1:${tseq}`);
    assert.ok(done.row.finished_at >= row.at);
    await rejectsCode(steps.finish(E(s), HARNESS, { seq: row.seq, outcome: 'exception', error: 'later' }), 'E_BUSY');
    assert.strictEqual(rowsOf(s)[0].outcome, 'done');
    const c2 = (await steps.claim(E(s), HARNESS, { step: 'fix', trigger: { ...TRIG, seq: 9 } })).row;
    const ex = await steps.finish(E(s), HARNESS, { seq: c2.seq, outcome: 'exception', error: 'E_BUSY: w-1 is working' });
    assert.deepStrictEqual([ex.row.outcome, ex.row.error, ex.row.row_ref], ['exception', 'E_BUSY: w-1 is working', null]);
    const c3 = (await steps.claim(E(s), HARNESS, { step: 'fix', trigger: { ...TRIG, seq: 12 } })).row;
    assert.strictEqual((await steps.finish(E(s), HARNESS, { seq: c3.seq, outcome: 'done', row_ref: 'task:nullrun' })).row.row_ref, 'task:nullrun', 'a row with no run id passes');
  } finally { s.close(); cleanup(d); }
});

test('a trigger names a known table and, for a versioned row, the version it acted on', async () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    for (const trigger of [{ table: 'task', id: 't-1' }, { table: 'lease', id: 'l-1' }, { table: 'integration', id: 'i-1' }, { table: 'review', id: 'x', seq: 1 }, { table: 'task', id: 't-1', seq: 1.5 }, { table: 'worker', id: 'w-1', seq: 3 }, { table: 'run', id: 'r1', seq: 1 }, { id: 'x', seq: 1 }]) {
      await rejectsCode(steps.claim(E(s), HARNESS, { step: 'fix', trigger }), 'E_ARGS');
    }
    assert.strictEqual(rowsOf(s).length, 0);
    // A later version of the row is a new trigger, so a second fix on a newer review is a new claim, not existing: true.
    assert.strictEqual((await steps.claim(E(s), HARNESS, { step: 'fix', trigger: { table: 'task', id: 'rev-1', seq: 10 } })).existing, false);
    assert.strictEqual((await steps.claim(E(s), HARNESS, { step: 'fix', trigger: { table: 'task', id: 'rev-1', seq: 11 } })).existing, false);
    for (const trigger of [{ table: 'worker', id: 'w-1' }, { table: 'run', id: 'r1' }]) assert.strictEqual((await steps.claim(E(s), HARNESS, { step: 'fix', trigger })).row.trigger_seq, 0);
    await rejectsCode(steps.claim(E(s), { role: 'operator', channel: 'harness' }, { step: 'fix', trigger: TRIG }), 'E_ARGS'); // no run_id on the caller
    await rejectsCode(steps.finish(E(s), { role: 'operator', channel: 'harness' }, { seq: 1, outcome: 'skipped', error: 'x' }), 'E_ARGS');
    assert.strictEqual(rowsOf(s).length, 4);
  } finally { s.close(); cleanup(d); }
});

test('list answers the run\'s steps in claim order after a cursor', async () => {
  const d = sandbox();
  const s = new Store(path.join(d, 'memory.db'), { stamp: true });
  try {
    const seqs = [];
    for (const step of ['review', 'fix', 're_review']) seqs.push((await steps.claim(E(s), HARNESS, { step, trigger: TRIG })).row.seq);
    await steps.claim(E(s), { ...HARNESS, run_id: 'r2' }, { step: 'fix', trigger: TRIG });
    const all = await steps.list(E(s), HARNESS, {});
    assert.deepStrictEqual(all.rows.map((r) => r.seq), seqs);
    assert.strictEqual(all.last_seq, seqs[2]);
    const tail = await steps.list(E(s), HARNESS, { since_seq: seqs[0] });
    assert.deepStrictEqual(tail.rows.map((r) => r.step), ['fix', 're_review']);
    assert.deepStrictEqual((await steps.list(E(s), HARNESS, { since_seq: seqs[2] })), { rows: [], last_seq: seqs[2] });
    assert.strictEqual((await steps.list(E(s), HARNESS, { run_id: 'r2' })).rows.length, 1);
    await rejectsCode(steps.list(E(s), HARNESS, { since_seq: -1 }), 'E_ARGS');
    await rejectsCode(steps.list(E(s), HARNESS, { bogus: 1 }), 'E_ARGS');
  } finally { s.close(); cleanup(d); }
});

test('through the core: claim and finish are the harness channel\'s alone, and the run is the caller\'s own', async (tcx) => {
  const d = sandbox();
  const orch = await openCore({ dataDir: `${d}/data`, caller: callerFor('orchestrator'), embed: false });
  tcx.after(async () => { try { await orch.shutdownOwner(); } finally { await orch.close(); cleanup(d); } });
  await orch.run.attach({ adapter_pid: process.pid });
  const args = { step: 'fix', trigger: TRIG, run_id: 'forged' };
  await rejectsCode(orch.policy.claim({ step: 'fix', trigger: TRIG }), 'E_ROLE'); // a tool call is never the harness
  await rejectsCode(orch.policy.finish({ seq: 1, outcome: 'skipped', error: 'x' }), 'E_ROLE');
  await rejectsCode(orch.harness().policy.claim(args), 'E_ARGS'); // run_id is not an argument
  const h = orch.harness();
  const c = await h.policy.claim({ step: 'fix', trigger: TRIG });
  assert.strictEqual(c.existing, false);
  assert.strictEqual(c.row.run_id, 'test-run', 'the run comes from the process identity');
  assert.strictEqual((await h.policy.claim({ step: 'fix', trigger: TRIG })).existing, true);
  const worker = await openCore({ dataDir: `${d}/data`, caller: callerFor('worker', { worker_id: 'w-1' }), embed: false });
  tcx.after(() => worker.close());
  await rejectsCode(worker.policy.claim({ step: 'fix', trigger: TRIG }), 'E_ROLE');
  const fin = await h.policy.finish({ seq: c.row.seq, outcome: 'done', row_ref: 'run:test-run' });
  assert.strictEqual(fin.row.outcome, 'done');
  const listed = await worker.policy.list({});
  assert.deepStrictEqual(listed.rows.map((r) => [r.seq, r.outcome]), [[c.row.seq, 'done']]);
});

test('an older store opens, gains the policy tables and columns, keeps its rows, and is stamped version 3', () => {
  const d = sandbox();
  try {
    const f = path.join(d, 'memory.db');
    const mod = path.join(d, 'base-schema.cjs');
    fs.writeFileSync(mod, fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'v0.1.0', 'src', 'core', 'schema.cjs'), 'utf8'));
    const db = new DatabaseSync(f);
    require(mod).ensureSchema(db);
    db.prepare("INSERT INTO task(id, run_id, spec, state, written_at, written_by) VALUES ('old-t', 'r0', 'an old task', 'open', 1, 'orchestrator')").run();
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '2')").run();
    const had = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t);
    assert.ok(!had('policy_step') && !had('check_flake') && !had('ix_usage_turn'));
    assert.ok(!db.prepare('PRAGMA table_info(task)').all().some((c) => c.name === 'acted_by'));
    db.close();
    const s = new Store(f, { stamp: true });
    try {
      assert.ok(s.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'policy_step'").get());
      assert.ok(s.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'check_flake'").get());
      assert.ok(s.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_usage_turn'").get(), 'an older store gains the usage turn index on open');
      const old = s.p("SELECT * FROM task WHERE id = 'old-t'").get();
      assert.strictEqual(old.spec, 'an old task');
      assert.deepStrictEqual([old.acted_by, old.trigger, old.policy_rev, old.policy], [null, null, null, null], 'nothing guesses a stamp for an older row');
      assert.strictEqual(s.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION));
    } finally { s.close(); }
  } finally { cleanup(d); }
});

test('reading the store\'s steps creates no file in the data dir', async (tcx) => {
  const d = sandbox();
  const o = await openCore({ dataDir: d, caller: callerFor('orchestrator'), embed: false });
  tcx.after(() => Promise.resolve().then(() => o.shutdownOwner()));
  tcx.after(() => Promise.resolve().then(() => o.close()));
  try {
    await o.run.attach({ adapter_pid: process.pid });
    const claim = await o.harness().policy.claim({ step: 'integrate', trigger: TRIG });
    await o.shutdownOwner();
    await o.close();
    const before = listDataDir(d);
    const c = await openCore({ dataDir: d, caller: callerFor('operator'), embed: false });
    tcx.after(() => Promise.resolve().then(() => c.close()));
    const st = await c.status.get({});
    assert.strictEqual(st.established_by, 'copy');
    assert.strictEqual(st.store.schema_version, 3);
    assert.deepStrictEqual(listDataDir(d), before, 'status.get of a version-3 store created nothing');
    const got = await c.policy.list({});
    assert.deepStrictEqual(got.rows.map((r) => r.seq), [claim.row.seq]);
    assert.deepStrictEqual(listDataDir(d), before, 'a read of the new tables created nothing');
    assert.ok(!listDataDir(d).some((n) => /-wal$|-shm$|-journal$/.test(n)), 'and left no sidecar');
    await c.close();
  } finally { cleanup(d); }
});
