'use strict';
// memory-writer.test.cjs — ADR 0044 decision 6: every memory row names its real writer. The column, the migration
// of an older store, the channel that tells the run manager from the orchestrator model, and the proof that no
// argument a caller passes can set it.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { Store } = core('store.cjs');
const { SCHEMA_VERSION } = core('schema-stamp.cjs');

const wid = 'w1';
let dir, orch, orchB, worker, operator;
const row = (c, id) => c.memory.get({ id, view: 'full' }).then(r => (r.rows ? r.rows[0] : r));

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: wid, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-1', last_event_at: Date.now() });
  worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: wid }), embed: false });
  operator = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  orchB = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false }); // a client of the owner: its calls cross the pipe
});

after(async () => {
  for (const c of [worker, operator, orchB]) await c.close();
  await orch.shutdownOwner();
  await orch.close();
  cleanup(dir);
});

test('a write names its writer by the channel it came on: worker, orchestrator, harness and operator', async () => {
  const w = await worker.memory.store({ text: 'worker claim', embed: false });
  const o = await orch.memory.store({ text: 'orchestrator claim', embed: false });
  const h = await orch.harness().memory.store({ text: 'harness row', embed: false, worker_id: wid, source: 'harness' });
  const op = await operator.memory.store({ text: 'operator note', embed: false });
  assert.deepStrictEqual([w.written_by, o.written_by, h.written_by, op.written_by], [`worker:${wid}`, 'orchestrator', 'harness', 'operator']);
  // the stored column agrees, and the harness row still names the worker it is about
  assert.strictEqual((await row(orch, h.id)).written_by, 'harness');
  assert.strictEqual((await row(orch, h.id)).worker_id, wid);
  assert.strictEqual((await row(orch, w.id)).written_by, `worker:${wid}`);
  // legacy: last_writer_id is still the worker id the write named
  assert.strictEqual(h.last_writer_id, wid);
});

test('belay run (the operator-role run process) writes its run-end rows on the harness channel; the CLI stays the operator', async () => {
  const h = await operator.harness().memory.store({ text: 'run-end summary', embed: false, source: 'summariser' });
  const cli = await operator.memory.store({ text: 'typed by a person', embed: false });
  assert.deepStrictEqual([h.written_by, cli.written_by], ['harness', 'operator']);
});

test('a memory_event written on the harness channel says harness; the tool channel says the role', async () => {
  const h = await orch.harness().memory.recordEvent({ kind: 'observation', ok: true });
  const t = await orch.memory.recordEvent({ kind: 'observation', ok: true });
  assert.deepStrictEqual([h.written_by, t.written_by], ['harness', 'orchestrator']);
});

test('the harness channel crosses the owner pipe, and a tool call on the same adapter stays the orchestrator', async () => {
  const h = await orchB.harness().memory.store({ text: 'harness over the pipe', embed: false });
  const t = await orchB.memory.store({ text: 'tool over the pipe', embed: false });
  assert.strictEqual(h.written_by, 'harness');
  assert.strictEqual(t.written_by, 'orchestrator');
  // the harness view is the run manager's: its other calls work and carry the same frozen caller
  assert.strictEqual(orchB.harness().caller.channel, 'harness');
  assert.ok(Object.isFrozen(orchB.harness().caller));
  assert.strictEqual(orchB.caller.channel, undefined);
  const listed = await orchB.harness().memory.list({ namespace: 'run/test-run', view: 'index' });
  assert.ok(JSON.stringify(listed).includes(h.id));
});

test('no argument sets the writer: written_by is refused, channel is not a field, and a caller in the arguments is ignored', async () => {
  for (const c of [orch, orchB, worker, operator]) {
    await assert.rejects(c.memory.store({ text: 'forge 1', embed: false, written_by: 'harness' }), e => e.code === 'E_ARGS' && e.detail.field === 'written_by');
    await assert.rejects(c.memory.store({ text: 'forge 2', embed: false, channel: 'harness' }), e => e.code === 'E_ARGS' && e.detail.field === 'channel');
  }
  // a caller smuggled into the arguments is replaced by the process's own, here and over the pipe
  const forged = { role: 'orchestrator', run_id: 'test-run', channel: 'harness', pid: process.pid };
  const a = await orch.memory.store({ text: 'forge 3', embed: false, caller: forged });
  const b = await orchB.memory.store({ text: 'forge 4', embed: false, caller: forged });
  const c = await worker.memory.store({ text: 'forge 5', embed: false, caller: forged });
  assert.deepStrictEqual([a.written_by, b.written_by, c.written_by], ['orchestrator', 'orchestrator', `worker:${wid}`]);
  // the engine itself refuses a channel that is not one, and a harness channel on any role but the orchestrator
  const eng = orch.owner.engine;
  for (const caller of [{ role: 'worker', worker_id: wid, run_id: 'test-run', channel: 'harness' }, { role: 'orchestrator', run_id: 'test-run', channel: 'root' }]) {
    await assert.rejects(eng.handle('memory.store', { caller, text: 'forge 6', embed: false }), e => e.code === 'E_ARGS');
  }
  // a worker has no harness view, and the engine refuses the channel on a worker caller
  assert.throws(() => worker.harness(), e => e.code === 'E_ROLE');
  const stored = orch.owner.store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE text LIKE 'forge %'").get().n;
  assert.strictEqual(stored, 3);
});

test('a dedup update never changes written_by', async () => {
  const first = await orch.memory.store({ text: 'one fact, written twice', embed: false, title: 'first' });
  assert.strictEqual(first.written_by, 'orchestrator');
  // the same writer resending: a dedup update
  const again = await orch.memory.store({ text: 'one fact, written twice', embed: false, tags: ['again'] });
  assert.strictEqual(again.action, 'updated');
  assert.strictEqual(again.id, first.id);
  assert.strictEqual(again.written_by, 'orchestrator');
  assert.strictEqual((await row(orch, first.id)).written_by, 'orchestrator');
  // a different writer resending the text changes nothing: the orchestrator model cannot rewrite a harness row
  const h = await orch.harness().memory.store({ text: 'harness first, then the model', embed: false, title: 'belay title' });
  const m = await orch.memory.store({ text: 'harness first, then the model', embed: false, title: 'forged', tags: ['forged'] });
  assert.strictEqual(m.action, 'unchanged');
  assert.strictEqual(m.id, h.id);
  const kept = await row(orch, h.id);
  assert.deepStrictEqual([kept.written_by, kept.title, kept.tags], ['harness', 'belay title', null]);
});

test('a worker resending its own turn text cannot rewrite the harness turn row (lever on: worker_id is the worker)', async () => {
  const text = 'Done. I changed a.cjs and the tests pass.';
  const turn = await orch.harness().memory.store({ text, type: 'turn', worker_id: wid, tags: ['t1'], embed: false });
  const w = await worker.memory.store({ text, title: 'VERIFIED by belay', body: { verdict: 'verified' }, tags: ['forged'], embed: false });
  assert.strictEqual(w.action, 'unchanged');
  assert.strictEqual(w.id, turn.id);
  const kept = await row(orch, turn.id);
  assert.deepStrictEqual([kept.written_by, kept.title === 'VERIFIED by belay', kept.body, kept.tags], ['harness', false, null, ['t1']]);
});

test('reads carry written_by in the full, index and list views', async () => {
  const h = await orch.harness().memory.store({ text: 'views row', embed: false });
  const full = await row(orch, h.id);
  const idx = await orch.memory.list({ namespace: h.namespace, view: 'index', limit: 100 });
  const hit = (idx.rows || idx).find(r => r.id === h.id);
  assert.strictEqual(full.written_by, 'harness');
  assert.strictEqual(hit.written_by, 'harness');
  const plain = (await orch.memory.list({ namespace: h.namespace, limit: 100 }));
  assert.ok((plain.rows || plain).some(r => r.id === h.id && r.written_by === 'harness'));
});

test('an older store gains the column on the owner open, and its rows read written_by null; SCHEMA_VERSION stays 2', () => {
  const d = sandbox();
  try {
    const f = path.join(d, 'memory.db');
    const src = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'v0.1.0', 'src', 'core', 'schema.cjs'), 'utf8');
    const mod = path.join(d, 'base-schema.cjs');
    fs.writeFileSync(mod, src);
    const db = new DatabaseSync(f);
    require(mod).ensureSchema(db);
    db.prepare('INSERT INTO memory_entries(id, namespace, worker_id, text, text_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)').run('old-1', 'n', 'w', 'an older row', 'h1');
    assert.ok(!db.prepare('PRAGMA table_info(memory_entries)').all().some(c => c.name === 'written_by'));
    db.close();
    const s = new Store(f, { stamp: true });
    try {
      assert.ok(s.db.prepare('PRAGMA table_info(memory_entries)').all().some(c => c.name === 'written_by'));
      assert.strictEqual(s.retrieve('old-1', false).written_by, null);
      assert.strictEqual(s.list({ namespace: 'n' })[0].written_by, null);
      const fresh = s.store({ namespace: 'n', worker_id: 'w', text: 'new row', written_by: 'harness' });
      assert.strictEqual(fresh.written_by, 'harness');
      assert.strictEqual(s.retrieve('old-1', false).written_by, null, 'nothing guesses a value for the older row');
    } finally { s.close(); }
    assert.strictEqual(SCHEMA_VERSION, 2);
  } finally { cleanup(d); }
});
