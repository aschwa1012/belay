'use strict';
// project-namespace.test.cjs — ADR 0041 §5: the "project" namespace alias and the verified copy into the
// project. The name comes from the run row's project column and nothing else; with no project the literal
// "project" namespace is what it has always been; a copy happens only under project_writes.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const proj = callerFor('orchestrator', { run_id: 'r-proj' });         // project "acme", project_writes on
const readOnly = callerFor('orchestrator', { run_id: 'r-nowrites' }); // project "acme", project_writes off
const none = callerFor('orchestrator', { run_id: 'r-none' });         // no project at all
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const dbRow = id => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const events = () => store.p("SELECT * FROM memory_event WHERE kind = 'project_write' ORDER BY seq").all();
const vec = (x, y) => ({ embedding: [x, y], embedding_model: 'fake', embedding_revision: 'r', dim: 2 });
const count = () => store.p('SELECT COUNT(*) AS n FROM memory_entries').get().n;
let n = 0;
const fresh = (caller, extra = {}) => call('memory.store', caller, { text: `fact ${++n}`, ...(extra.embedding ? {} : { embed: false }), ...extra });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: null, owner: null, establishedBy: 'test' });
  // notes off: these cases are the project index and copy of a run without notes (with a project, notes now default on and list notes only)
  const on = JSON.stringify({ project: 'acme', project_writes: true, notes: false });
  const off = JSON.stringify({ project: 'acme', notes: false });
  await call('run.attach', proj, { adapter_pid: process.pid, project: 'acme', memory_levers: on });
  await call('run.attach', readOnly, { adapter_pid: process.pid, project: 'acme', memory_levers: off });
  await call('run.attach', none, { adapter_pid: process.pid });
});
after(() => { store.close(); cleanup(dir); });

test('with no project the literal "project" namespace is what it always was', async () => {
  const w = await fresh(none, { namespace: 'project' });
  assert.strictEqual(w.namespace, 'project');
  const l = await call('memory.list', none, { namespace: 'project' });
  assert.deepStrictEqual(l.rows.map(r => r.id), [w.id]);
  assert.deepStrictEqual(l.searched.namespaces, ['project']);
  const s = await call('memory.search', none, { query: 'fact', mode: 'keyword', namespace: 'project' });
  assert.deepStrictEqual(s.searched.namespaces, ['project']);
});

test('with a project the alias resolves to project/<name> on write, list and search, and is reported', async () => {
  const w = await fresh(proj, { namespace: 'project', text: 'the deploy script is scripts/ship.sh' });
  assert.strictEqual(w.namespace, 'project/acme');
  assert.strictEqual(dbRow(w.id).namespace, 'project/acme');
  const l = await call('memory.list', proj, { namespace: 'project' });
  assert.deepStrictEqual(l.rows.map(r => r.id), [w.id]);
  assert.deepStrictEqual(l.searched.namespaces, ['project/acme']);
  const s = await call('memory.search', proj, { query: 'deploy script', mode: 'keyword', namespaces: ['project', `run/${proj.run_id}`] });
  assert.deepStrictEqual(s.searched.namespaces, ['project/acme', 'run/r-proj']);
  assert.ok(s.results.some(r => r.id === w.id && r.namespace === 'project/acme'));
  // The literal namespace of a run with no project is a different place and holds none of this.
  const lit = await call('memory.list', none, { namespace: 'project' });
  assert.ok(!lit.rows.some(r => r.id === w.id));
});

test('a semantic search through the alias embeds once and reports the resolved namespace', async () => {
  const getEmbedder = async () => ({ embed: async () => vec(1, 0) });
  const E2 = new Engine({ dataDir: dir, store, getEmbedder, owner: null, establishedBy: 'test' });
  const w = await E2.handle('memory.store', { caller: proj, namespace: 'project', text: 'vector fact', ...vec(1, 0) });
  const s = await E2.handle('memory.search', { caller: proj, query: 'anything', namespace: 'project' });
  assert.deepStrictEqual(s.searched.namespaces, ['project/acme']);
  assert.strictEqual(s.results[0].id, w.id);
});

test('an explicit project namespace and other names pass through untouched', async () => {
  const w = await fresh(proj, { namespace: 'project/other' });
  assert.strictEqual(w.namespace, 'project/other');
  const d = await fresh(proj);
  assert.strictEqual(d.namespace, 'run/r-proj');
});

test('the project name is never derived from the cwd or the call', async () => {
  // A caller that says what its project is changes nothing; only the run row names it.
  const w = await fresh(none, { namespace: 'project', project: 'acme' }).then(r => r, e => e);
  assert.notStrictEqual(w.namespace, 'project/acme');
  // A caller with no run at all keeps the literal.
  const { resolveNamespace } = core('methods-memory.cjs');
  assert.strictEqual(resolveNamespace(E, { role: 'operator', pid: process.pid }, 'project'), 'project');
  assert.strictEqual(resolveNamespace(E, proj, 'project'), 'project/acme');
  // The source of the alias is the run row, not the process: methods-memory reads the column and no path.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'src', 'core', 'methods-memory.cjs'), 'utf8');
  assert.ok(!/process\.cwd\(|path\.basename\(|execSync|spawnSync/.test(src));
});

test('verified copy: under project_writes, with copy-of provenance, the same receipt and a project_write event', async () => {
  const src = await fresh(proj, { text: 'run-scoped finding about retries', ...vec(0, 1) });
  const out = await call('memory.setStatus', proj, { id: src.id, status: 'verified', receipt: 'commit:abc1234' });
  assert.strictEqual(out.status, 'verified');
  assert.strictEqual(out.project_copy.ok, true);
  assert.strictEqual(out.project_copy.namespace, 'project/acme');
  const copy = dbRow(out.project_copy.id);
  assert.strictEqual(copy.namespace, 'project/acme');
  assert.strictEqual(copy.provenance, `copy-of:${src.id}`);
  assert.strictEqual(copy.status, 'verified');
  assert.strictEqual(copy.status_receipt, 'commit:abc1234');
  assert.strictEqual(copy.text, 'run-scoped finding about retries');
  assert.ok(copy.embedding, 'the vector travels with the copy');
  assert.strictEqual(dbRow(src.id).namespace, 'run/r-proj', 'the source stays where it was');
  const ev = events().filter(e => e.key === `copy-of:${src.id}`);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].ok, 1);
  assert.deepStrictEqual(JSON.parse(ev[0].row_ids), [copy.id]);
  // Verifying again does not duplicate the copy.
  const again = await call('memory.setStatus', proj, { id: src.id, status: 'verified', receipt: 'commit:abc1234' });
  assert.strictEqual(again.project_copy.id, copy.id);
  assert.strictEqual(store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE namespace = 'project/acme' AND provenance = ?").get(`copy-of:${src.id}`).n, 1);
});

test('a source refuted after its copy was verified refutes the copy: the project index and corpus drop it', async () => {
  const src = await fresh(proj, { text: 'the cache is safe to share', type: 'fact' });
  const v = await call('memory.setStatus', proj, { id: src.id, status: 'verified', receipt: 'test:looked fine' });
  const copyId = v.project_copy.id;
  const inIndex = async () => (await call('memory.index', proj, { namespaces: ['project/acme'] })).row_ids.includes(copyId);
  const inCorpus = async () => (await call('memory.corpus', proj, { project: 'acme' })).row_ids.includes(copyId);
  assert.ok(await inIndex(), 'the verified copy is in the project index');
  assert.ok(await inCorpus(), 'and in the corpus');

  const r = await call('memory.setStatus', proj, { id: src.id, status: 'refuted', receipt: 'test:race found' });
  assert.deepStrictEqual(r.copies, [{ ok: true, id: copyId, namespace: 'project/acme', status: 'refuted', source_id: src.id }]);
  const copy = dbRow(copyId);
  assert.strictEqual(copy.status, 'refuted');
  assert.strictEqual(copy.status_receipt, 'test:race found');
  assert.strictEqual(await inIndex(), false, 'a refuted copy is never injected into a later run');
  assert.strictEqual(await inCorpus(), false, 'nor served by the corpus');
  const ev = events().filter(e => e.key === `copy-of:${src.id}`);
  assert.deepStrictEqual(ev.map(e => [e.ok, JSON.parse(e.row_ids)]), [[1, [copyId]], [1, [copyId]]]);
  assert.match(ev[1].message, /to refuted/);

  // Back to unverified: the copy follows and its receipt is cleared.
  const u = await call('memory.setStatus', proj, { id: src.id, status: 'unverified' });
  assert.strictEqual(u.copies[0].status, 'unverified');
  assert.strictEqual(dbRow(copyId).status_receipt, null);
  // Verified again: the copy is found again (one row, not two) and is verified, reported once.
  const again = await call('memory.setStatus', proj, { id: src.id, status: 'verified', receipt: 'test:fixed' });
  assert.strictEqual(again.project_copy.id, copyId);
  assert.strictEqual(again.copies, undefined, 'the copy just written is not set a second time');
  assert.strictEqual(dbRow(copyId).status, 'verified');
});

test('no copy without project_writes, without a project, for other statuses, or outside the run namespace', async () => {
  const before = count();
  const cases = [];
  for (const caller of [readOnly, none]) {
    const r = await fresh(caller);
    cases.push(await call('memory.setStatus', caller, { id: r.id, status: 'verified', receipt: 'commit:abc1234' }));
  }
  const refuted = await fresh(proj);
  cases.push(await call('memory.setStatus', proj, { id: refuted.id, status: 'refuted', receipt: 'commit:abc1234' }));
  const elsewhere = await fresh(proj, { namespace: 'scratch/x' });
  cases.push(await call('memory.setStatus', proj, { id: elsewhere.id, status: 'verified', receipt: 'commit:abc1234' }));
  for (const c of cases) assert.strictEqual(c.project_copy, undefined, JSON.stringify(c));
  assert.strictEqual(count(), before + 4, 'only the four source rows were added');
  assert.deepStrictEqual(Object.keys(cases[0]).sort(), ['id', 'previous_status', 'receipt_check', 'status', 'status_at', 'status_by', 'status_receipt']);
  assert.strictEqual(cases[0].receipt_check.checked, false, 'no worktree is known for these rows, and the answer says the commit was not checked');
});

test('a row already in the project is not copied again, and a refused receipt copies nothing', async () => {
  const p = await fresh(proj, { namespace: 'project/acme' });
  const out = await call('memory.setStatus', proj, { id: p.id, status: 'verified', receipt: 'commit:abc1234' });
  assert.strictEqual(out.project_copy, undefined);
  const r = await fresh(proj);
  const n0 = count();
  await assert.rejects(call('memory.setStatus', proj, { id: r.id, status: 'verified', receipt: 'task:nope' }), e => e.code === 'E_RECEIPT');
  assert.strictEqual(count(), n0);
});

test('a failed copy is reported on the answer and recorded with its code, and the status change stands', async () => {
  const src = await fresh(proj, { text: 'bound elsewhere', ...vec(1, 0) });
  // Bind the project namespace to another model so the copy's vector is refused (E_MODEL).
  store.p("INSERT OR REPLACE INTO namespace_models(namespace, embedding_model, dim) VALUES ('project/acme', 'other-model', 2)").run();
  const out = await call('memory.setStatus', proj, { id: src.id, status: 'verified', receipt: 'commit:abc1234' });
  assert.strictEqual(out.status, 'verified');
  assert.strictEqual(dbRow(src.id).status, 'verified');
  assert.strictEqual(out.project_copy.ok, false);
  assert.strictEqual(out.project_copy.code, 'E_MODEL');
  const ev = events().filter(e => e.key === `copy-of:${src.id}`);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].ok, 0);
  assert.strictEqual(ev[0].code, 'E_MODEL');
});

test('methods-memory exports the shared embedding phase and holds no read methods', () => {
  const m = core('methods-memory.cjs');
  assert.strictEqual(typeof m.withEmbedding, 'function');
  assert.strictEqual(typeof m.notifyEmbedderFailure, 'function');
  for (const dead of ['get', 'search', 'list']) assert.strictEqual(m[dead], undefined, dead);
});
