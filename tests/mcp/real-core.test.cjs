// real-core.test.cjs — the same tool surface driven against src/core, with no fake injected, in a
// sandbox data dir under the OS temp dir. The fake-core suite proves the adapter's routing and
// envelope; this one proves the rows and the refusal codes are the real core's, that a read creates
// no file, and that the owner the adapter elected is gone after stdin end.
//
// --no-embed throughout, so memory_store and memory_search are expected to refuse with E_NO_EMBEDDER.
// That is the contract's answer, not a failure: the core fails rather than returning empty.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { launch, sandboxDir } = require('./rpc.cjs');
const { openCore } = require('../../src/core/index.cjs');
require('../core/helpers.cjs').optInModel(); // the A8 test below needs the fetched model; phase 1 defaults to an empty cache

// Core resolves the data dir to one canonical spelling (resolveDataDir in lock.cjs), forward slashes
// on Windows, so the value handed in reads back byte for byte and a caller can compare against argv.

const real = (o) => launch({ ...o, fake: false, noEmbed: true });

test('status on a data dir that does not exist answers stopped and creates nothing', async (t) => {
  const parent = sandboxDir('real-status');
  const data = `${parent}/store`;
  const a = real({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const t0 = Date.now();
  const r = await a.call('status', {});
  const roundTrip = Date.now() - t0;
  assert.strictEqual(r.isError, false, 'a dead system is a valid answer, never an error');
  const s = r.structuredContent;
  console.log(`real status: verdict ${s.verdict}, core ms ${s.ms}, round trip ${roundTrip} ms`);
  assert.strictEqual(s.verdict, 'stopped');
  assert.strictEqual(s.established_by, 'none');
  assert.strictEqual(s.data_dir, data, 'status echoes the data dir in the spelling argv used');
  // The backslash is built rather than written, because this host's shell mangles one in a
  // literal (CLAUDE.md working rules).
  const BACKSLASH = String.fromCharCode(92);
  if (process.platform === 'win32') {
    assert.ok(!s.data_dir.includes(BACKSLASH), 'the canonical spelling carries no backslash on Windows');
  }
  assert.deepStrictEqual(s.rungs.map((x) => x.rung),
    ['configured', 'store-present', 'owner-alive', 'run-alive', 'worker-alive', 'worker-responsive']);
  // §4: verdict is stopped when the first four rungs do not all hold. The last two have nothing to
  // check with no workers on record, and a rung with nothing to check reports established.
  for (const rung of s.rungs.slice(0, 4)) {
    assert.strictEqual(rung.established, false, `${rung.rung} cannot hold against an absent store`);
  }
  for (const rung of s.rungs) {
    assert.ok(typeof rung.by === 'string' && rung.by.length > 0, `${rung.rung} names what established it`);
    assert.ok(rung.detail !== undefined, `${rung.rung} carries a detail`);
    assert.ok(typeof rung.ms === 'number', `${rung.rung} carries its cost`);
  }
  // Invariant 6, end to end: reading never writes.
  assert.strictEqual(fs.existsSync(data), false, 'status created the data dir');
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'status wrote into the sandbox');
});

test('the real core\'s refusal codes and details reach the model unchanged', async (t) => {
  const data = sandboxDir('real-refuse');
  const a = real({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  // --no-embed: the core fails rather than returning an empty result.
  for (const [tool, args] of [['memory_store', { text: 'a fact' }], ['memory_search', { query: 'a fact', mode: 'semantic' }]]) {
    const r = await a.call(tool, args);
    assert.strictEqual(r.isError, true, `${tool} must refuse under --no-embed`);
    assert.strictEqual(r.structuredContent.error, 'E_NO_EMBEDDER');
    assert.ok(r.structuredContent.message.length > 0, 'the message is a sentence');
    // contract §6 requires a code and a sentence; detail is optional and core's lazy-embedder refusal carries none
  }

  const first = await a.call('task_create', { spec: 'own a file', files_owned: ['src/a.js'] });
  assert.strictEqual(first.isError, false);
  const overlap = await a.call('task_create', { spec: 'own it too', files_owned: ['src/a.js'] });
  assert.strictEqual(overlap.isError, true);
  assert.strictEqual(overlap.structuredContent.error, 'E_FILES_OVERLAP');
  assert.strictEqual(overlap.structuredContent.detail.other_task_id, first.structuredContent.id,
    'the detail carries the id the orchestrator needs to act');
  assert.deepStrictEqual(overlap.structuredContent.detail.files, ['src/a.js']);

  const assign = await a.call('task_assign', { task_id: first.structuredContent.id, worker_id: 'wk-nobody' });
  assert.strictEqual(assign.isError, true);
  assert.strictEqual(assign.structuredContent.error, 'E_WORKER_NOT_LIVE');
});

test('A8 against the real core: task_create, task_list and briefing', async (t) => {
  const data = sandboxDir('real-task');
  const a = real({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const c = (await a.call('task_create', { spec: 'a real task', files_owned: ['src/b.js'] })).structuredContent;
  assert.strictEqual(c.state, 'open');
  assert.match(c.id, /^[0-9a-f-]{36}$/, 'the id is a uuid the orchestrator can carry');
  assert.strictEqual(c.run_id, 'run-1', 'the run id comes from argv');
  assert.strictEqual(c.written_by, 'orchestrator', 'the row is attributed to the argv role');
  assert.ok(typeof c.seq === 'number', 'every row carries seq');

  const list = (await a.call('task_list', {})).structuredContent;
  assert.strictEqual(list.tasks.length, 1);
  const row = list.tasks[0];
  assert.strictEqual(row.id, c.id);
  assert.strictEqual(row.lease, null, 'an unassigned task has no lease');
  assert.strictEqual(row.holder_pid_alive, null);
  assert.strictEqual(row.last_checkpoint_id, null);

  const b = (await a.call('briefing', { task_id: c.id })).structuredContent;
  assert.ok(b.line.bytes <= 400, `resume line is ${b.line.bytes} bytes`);
  assert.ok(b.doc.bytes <= 4096, `resume doc is ${b.doc.bytes} bytes`);
  assert.strictEqual(b.line.bytes, Buffer.byteLength(b.line.text, 'utf8'), 'the byte count is the text\'s own');
  assert.strictEqual(b.line.task_state, 'open');
  assert.match(b.line.text, new RegExp(c.id), 'the line names the task id');
  assert.match(b.line.text, /memory_search/, 'the line says how to recover context');
  assert.match(b.doc.text, /unverified|stated by the worker/,
    'the doc labels a worker\'s claim as a claim (ADR 0010 §3)');
  console.log(`real briefing: line ${b.line.bytes} bytes, doc ${b.doc.bytes} bytes`);
});

test('A8 against the real core: the memory reads that need no embedder', async (t) => {
  const data = sandboxDir('real-mem');
  const a = real({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  assert.deepStrictEqual((await a.call('memory_list', {})).structuredContent.rows, []);
  const miss = (await a.call('memory_retrieve', { id: 'no-such-id' })).structuredContent;
  assert.strictEqual(miss.found, false, 'a miss is a row saying so, not an error');
  assert.strictEqual(miss.id, 'no-such-id');
  const del = (await a.call('memory_delete', { id: 'no-such-id' })).structuredContent;
  assert.strictEqual(del.deleted, false);

  const stats = (await a.call('memory_stats', {})).structuredContent;
  assert.ok(stats.owner, 'stats carry owner liveness');
  for (const k of ['pid', 'pipe', 'alive', 'established_by']) {
    assert.ok(Object.prototype.hasOwnProperty.call(stats.owner, k), `stats.owner names ${k}`);
  }
  assert.ok(stats.owner.established_by.length > 0, 'the owner rung says what established it');
});

test('a worker-role adapter carries its argv identity into the real core and never elects', async (t) => {
  const data = sandboxDir('real-worker');
  const a = real({ role: 'worker', data, workerId: 'wk-real-1', run: 'run-w' });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  // No owner is alive and a worker never elects one, so a write cannot succeed. Whether the core
  // refuses for want of an owner or an embedder first, both are contract codes and neither is a
  // silent success.
  // A worker_id argument never gets that far: it is a harness field, refused by name at the boundary.
  const forged = await a.call('memory_store', { text: 'x', worker_id: 'wk-forged' });
  assert.strictEqual(forged.structuredContent.error, 'E_ARGS');
  const w = await a.call('memory_store', { text: 'x' });
  assert.strictEqual(w.isError, true, 'a worker write with no owner must not succeed');
  assert.ok(['E_NO_OWNER', 'E_NO_EMBEDDER'].includes(w.structuredContent.error),
    `expected E_NO_OWNER or E_NO_EMBEDDER, got ${w.structuredContent.error}`);

  // Reads still answer from a copy with no owner alive.
  assert.strictEqual((await a.call('memory_list', {})).isError, false, 'a read answers with no owner');
  assert.strictEqual((await a.call('status', {})).isError, false);

  // Role gating is enforced by the adapter's listing and again by the core; the adapter's E_ROLE
  // comes first, so a worker never reaches an orchestrator method at all.
  const refused = await a.call('task_create', { spec: 'not mine' });
  assert.strictEqual(refused.structuredContent.error, 'E_ROLE');
  assert.strictEqual(fs.existsSync(`${data}/owner.lock`), false, 'a worker took the owner lock');
});

// A3 through the tool surface, at the shape the tester measured: a second orchestrator adapter on the
// same run must have settled the epoch before it answers anything, because `status` is the first thing
// an operator or an attached session calls and it must not present the previous epoch's rows as
// current. ADR 0009's reconstruction cannot wait for a worker tool the session may never call.
test('a second orchestrator adapter reconciles the previous epoch before its first status answers', { timeout: 60000 }, async (t) => {
  const data = sandboxDir('real-epoch');
  const owner = await openCore({
    dataDir: data,
    caller: { role: 'orchestrator', run_id: 'run-epoch', pid: process.pid },
    embed: false,
  });
  t.after(() => Promise.resolve().then(() => owner.shutdownOwner()).catch(() => {}));
  t.after(() => Promise.resolve().then(() => owner.close()).catch(() => {}));
  const first = await owner.run.attach({ adapter_pid: process.pid });
  assert.strictEqual(first.epoch, 1);
  assert.strictEqual(first.reattached, false, 'the first adapter on a fresh store is not a reattach');

  // A worker the previous epoch left mid-launch whose process is gone. `starting` is written rather
  // than `running` because `running` is refused unless the pid is alive at the moment it is written
  // (api.md §2), and this pid is deliberately dead: a real child, run to completion.
  const gone = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const gonePid = gone.pid;
  await new Promise((r) => gone.on('exit', r));
  await owner.worker.write({ id: 'wk-gone', substrate: 'claude-code', pid: gonePid, state: 'starting' });
  await owner.shutdownOwner();
  await owner.close();

  const a = real({ role: 'orchestrator', data, run: 'run-epoch' });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  // The very first tool call, and it is a read.
  const s = (await a.call('status', {})).structuredContent;
  assert.ok(s.attach, 'the first status carries the attach, so the session can see the epoch turned');
  assert.strictEqual(s.attach.reattached, true, 'a second adapter on the same run is a reattach');
  assert.deepStrictEqual(s.attach.workers_marked_dead, ['wk-gone'],
    'the reattach names the worker it declared dead from a pid check');
  const w = s.workers.find((x) => x.id === 'wk-gone');
  assert.ok(w, 'status still lists the worker');
  assert.strictEqual(w.state, 'dead', 'and it reads dead, not the previous epoch\'s starting');
  assert.strictEqual(w.pid_alive, false, 'liveness is derived from the pid, as it always was');

  // Settled once, not on every call: a second read does not turn the epoch again.
  const again = (await a.call('status', {})).structuredContent;
  assert.deepStrictEqual(again.attach, s.attach, 'the epoch is settled once per adapter, not per call');
  const runRow = (await a.call('task_list', {})).structuredContent;
  assert.ok(Array.isArray(runRow.tasks), 'and the rest of the surface still answers');
});

// The other half of the rule: settling the epoch never brings a store into being. A read against a
// data dir with no store still writes nothing, so invariant 6 and api.md §4's `stopped` both hold.
test('an orchestrator adapter with no store to attach to writes nothing and claims no attach', async (t) => {
  const parent = sandboxDir('real-noattach');
  const data = `${parent}/store`;
  const a = real({ role: 'orchestrator', data });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();
  const s = (await a.call('status', {})).structuredContent;
  assert.strictEqual(s.verdict, 'stopped', 'a dead system is still a valid answer');
  assert.strictEqual(s.attach, undefined, 'and the adapter claims no attach it did not make');
  assert.strictEqual(fs.existsSync(data), false, 'settling the epoch must not create the store');
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'nor anything else in the sandbox');
});

// ADR 0010 §4: a worker may act on its own lease and never outrank an assignment, and §2's refusal
// columns for the three worker-role tools name the codes. Everything below goes through the tool
// surface against src/core; only the setup, which needs the orchestrator-only `worker.write` the
// surface deliberately does not expose, touches the core directly. The test process is the owner, so
// the worker adapters' writes travel the pipe exactly as they would under a live orchestrator.
test('the three worker-role tools refuse a non-holder with the codes ADR 0010 §2 names', { timeout: 60000 }, async (t) => {
  const data = sandboxDir('real-lease');
  const owner = await openCore({
    dataDir: data,
    caller: { role: 'orchestrator', run_id: 'run-1', pid: process.pid },
    embed: false,
  });
  t.after(async () => { await owner.shutdownOwner(); await owner.close(); });

  const task = await owner.task.create({ spec: 'a task somebody else holds', files_owned: [] });
  // `running` is refused unless the pid is alive at the moment it is written, so the holder is given
  // this test process's own pid: a real live process, not a placeholder.
  await owner.worker.write({ id: 'wk-holder', substrate: 'claude-code', pid: process.pid, state: 'running' });
  const assigned = await owner.task.assign({ task_id: task.id, worker_id: 'wk-holder' });
  const leaseId = assigned.new_lease.id;
  assert.strictEqual(assigned.new_lease.holder, 'wk-holder');

  const other = real({ role: 'worker', data, workerId: 'wk-other', run: 'run-1' });
  t.after(async () => { await other.close(); other.kill(); });
  await other.initialize();

  const renew = await other.call('lease_renew', { lease_id: leaseId });
  assert.strictEqual(renew.isError, true, 'a non-holder must not renew a lease');
  assert.strictEqual(renew.structuredContent.error, 'E_NOT_HOLDER');
  assert.match(renew.structuredContent.message, /wk-holder/, 'the message names who does hold it');
  assert.match(renew.structuredContent.message, /wk-other/, 'and who asked');
  assert.strictEqual(renew.structuredContent.detail.holder, 'wk-holder', 'the detail carries the holder');
  assert.strictEqual(renew.structuredContent.detail.lease_id, leaseId);

  const release = await other.call('lease_release', { lease_id: leaseId, reason: 'not mine to give up' });
  assert.strictEqual(release.isError, true, 'a non-holder must not release a lease');
  assert.strictEqual(release.structuredContent.error, 'E_NOT_HOLDER');
  assert.match(release.structuredContent.message, /wk-holder/);

  const ck = await other.call('checkpoint_write', { task_id: task.id, turn: 1, summary: 'I did a thing' });
  assert.strictEqual(ck.isError, true, 'a worker with no lease must not check in against the task');
  assert.strictEqual(ck.structuredContent.error, 'E_NO_LEASE');
  assert.match(ck.structuredContent.message, /wk-other/, 'the message names the worker that has no lease');
  assert.match(ck.structuredContent.message, new RegExp(task.id), 'and the task it has no lease on');
  assert.strictEqual(ck.structuredContent.detail.task_id, task.id);

  // No success without effect, read the other way: the refusals wrote nothing.
  const after = await owner.task.get({ task_id: task.id });
  assert.strictEqual(after.state, 'assigned', 'a refused release must not have released the task');
  assert.strictEqual(after.lease.id, leaseId, 'a refused renew must not have superseded the lease');
  assert.strictEqual(after.last_checkpoint_id, null, 'a refused checkpoint wrote no row');

  // The positive control: the same three calls from the holder's own adapter succeed, so the refusals
  // above are about who asked, not about the plumbing between the adapter and the owner.
  const holder = real({ role: 'worker', data, workerId: 'wk-holder', run: 'run-1' });
  t.after(async () => { await holder.close(); holder.kill(); });
  await holder.initialize();
  const mine = await holder.call('lease_renew', { lease_id: leaseId });
  assert.strictEqual(mine.isError, false, `the holder's own renew refused: ${JSON.stringify(mine.structuredContent)}`);
  assert.strictEqual(mine.structuredContent.id, leaseId, 'renew returns the lease row it extended');
  assert.ok(mine.structuredContent.expires_at > assigned.new_lease.expires_at - 1, 'with a later expiry');
  const mineCk = await holder.call('checkpoint_write', { task_id: task.id, turn: 1, summary: 'I did a thing', next_step: 'the next thing' });
  assert.strictEqual(mineCk.isError, false, `the holder's own checkpoint refused: ${JSON.stringify(mineCk.structuredContent)}`);
  assert.strictEqual(mineCk.structuredContent.source, 'worker', 'and it is recorded as the worker\'s claim');
  assert.strictEqual(mineCk.structuredContent.worker_id, 'wk-holder', 'attributed to the argv identity');
});

test('the owner the orchestrator elected is released on stdin end, without a signal', async (tcx) => {
  const data = sandboxDir('real-owner');
  const a = real({ role: 'orchestrator', data });
  tcx.after(() => Promise.resolve().then(() => a.close()).catch(() => {}));
  await a.initialize();
  // A write elects this process as owner for the life of the session.
  assert.strictEqual((await a.call('task_create', { spec: 'elect me' })).isError, false);
  assert.ok(fs.existsSync(`${data}/owner.lock`), 'a write should have elected an owner');
  const stats = (await a.call('memory_stats', {})).structuredContent;
  assert.strictEqual(stats.owner.pid, a.pid, 'the adapter itself is the owner');

  const code = await a.close();
  assert.strictEqual(code, 0, `exit code ${code}, stderr: ${a.stderr}`);
  assert.strictEqual(fs.existsSync(`${data}/owner.lock`), false,
    'shutdownOwner must release the lock; a leftover lock blocks the next session');
  assert.ok(fs.existsSync(`${data}/memory.db`), 'the store survives the session that wrote it');
  a.kill();
});

// The one test that runs with the embedder on. Core measured the cold model load at 1.76 s on this
// host, paid once when the owner starts, so this is the slow test in the suite by design.
test('A8 with the embedder on: memory_store and memory_search take plain text', { timeout: 240000 }, async (t) => {
  const K = require('../../src/core/model-cache.cjs'), M = require('../../src/core/models.cjs');
  if (!K.packageDir() || !K.checkPresent(M.MODELS[M.DEFAULT_MODEL]).present) return t.skip('the embedding package or the default model is not installed/fetched here');
  const data = sandboxDir('real-embed');
  const a = launch({ role: 'orchestrator', data, noEmbed: false, fake: false });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const t0 = Date.now();
  const stored = await a.call('memory_store', {
    text: 'The belay adapter builds its identity from argv and never from a request.',
    type: 'fact',
    tags: ['adapter', 'identity'],
    provenance: 'tests/mcp/real-core.test.cjs',
  }, 110000); // the first vector call pays a cold model load, 30 s and more under a parallel phase
  const firstWriteMs = Date.now() - t0;
  assert.strictEqual(stored.isError, false, `memory_store refused: ${JSON.stringify(stored.structuredContent)}`);
  const row = stored.structuredContent;
  for (const k of ['id', 'action', 'namespace', 'worker_id', 'updated_at']) {
    assert.ok(Object.prototype.hasOwnProperty.call(row, k), `memory_store row names ${k}`);
  }
  assert.strictEqual(row.action, 'inserted');
  assert.strictEqual(row.namespace, 'run/run-1', 'the namespace defaults to this run');
  assert.strictEqual(row.worker_id, 'orchestrator', 'the row is attributed to the argv role');
  console.log(`real memory_store: ${firstWriteMs} ms including the cold model load`);

  const got = (await a.call('memory_retrieve', { id: row.id })).structuredContent;
  assert.strictEqual(got.found, true);
  assert.match(got.text, /identity from argv/);

  const t1 = Date.now();
  const found = await a.call('memory_search', { query: 'where does the adapter get its identity?', k: 5 }, 110000);
  assert.strictEqual(found.isError, false, `memory_search refused: ${JSON.stringify(found.structuredContent)}`);
  const s = found.structuredContent;
  for (const k of ['results', 'scanned', 'model', 'dim']) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, k), `memory_search names ${k}`);
  }
  assert.ok(s.results.length >= 1, 'the stored row is findable by meaning, not by substring');
  const hit = s.results[0];
  assert.strictEqual(hit.id, row.id);
  for (const k of ['score', 'worker_id', 'tags', 'provenance']) {
    assert.ok(Object.prototype.hasOwnProperty.call(hit, k), `a search result names ${k} (ADR 0010 §2)`);
  }
  assert.ok(hit.score > 0, 'the result carries a score');
  console.log(`real memory_search: ${Date.now() - t1} ms, dim ${s.dim}, model ${s.model}, score ${hit.score.toFixed(3)}`);

  const del = (await a.call('memory_delete', { id: row.id })).structuredContent;
  assert.strictEqual(del.deleted, true, 'memory_delete reports the row it deleted');
});
