'use strict';
// continuity.test.cjs — the two briefing artefacts and their byte budgets (api.md §3, ADR 0007 §2, §7).
// Both are derived from rows only, both label worker-stated content as stated and unverified, and
// neither may exceed its budget measured with Buffer.byteLength.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { core, sandbox, cleanup, callerFor, listDataDir } = require('./helpers.cjs');

const { openCore } = core('index.cjs');
const { teardown } = require('../helpers/teardown.cjs');
const LINE_MAX = 400;
const DOC_MAX = 4096;

let dir, orch, worker, taskId, leaseId;
const wid = 'w-continuity';

before(async () => {
  dir = sandbox();
  orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  await orch.run.attach({ adapter_pid: process.pid });
  await orch.worker.write({ id: wid, substrate: 'claude-code', pid: process.pid, state: 'running' });
  const t = await orch.task.create({
    spec: 'Lift the prototype store into src/core and keep its measured behaviour.',
    files_owned: ['src/core', 'tests/core'],
    acceptance: { commands: [{ argv: ['node', '--test', 'tests/core'] }], files_within_owned: true },
  });
  taskId = t.id;
  const a = await orch.task.assign({ task_id: taskId, worker_id: wid });
  leaseId = a.new_lease.id;
  await orch.worker.write({ id: wid, task_id: taskId });
  worker = await openCore({ dataDir: dir, caller: callerFor('worker', { worker_id: wid }), embed: false });
});

after(async () => {
  // Every step runs even if an earlier one fails (a before hook that failed part-way leaves some unset); the first failure is thrown.
  await teardown(null, [
    () => worker && worker.close(),
    () => orch && orch.shutdownOwner(),
    () => orch && orch.close(),
    () => cleanup(dir),
  ]);
});

test('resumeLine names the task, its state, the lease and the store query, inside 400 bytes', async () => {
  const l = await orch.continuity.resumeLine({ task_id: taskId });
  assert.ok(l.bytes <= LINE_MAX, `${l.bytes} bytes exceeds the ${LINE_MAX}-byte hook budget`);
  assert.strictEqual(l.bytes, Buffer.byteLength(l.text, 'utf8'));
  assert.strictEqual(l.task_id, taskId);
  assert.strictEqual(l.task_state, 'assigned');
  assert.strictEqual(l.lease_id, leaseId);
  assert.ok(l.text.includes(taskId));
  assert.ok(l.text.includes('assigned'));
  assert.ok(l.text.includes(leaseId));
  assert.ok(l.text.includes(`memory_search "${taskId}"`), 'the line must carry the query that recovers context');
  assert.strictEqual(l.checkpoint_id, null, 'no checkpoint exists yet');
});

test('a worker-stated next step is carried and labelled, and an overlong one is truncated to fit', async () => {
  await worker.continuity.checkpoint({ task_id: taskId, turn: 1, summary: 'short summary', next_step: 'write the tests' });
  let l = await orch.continuity.resumeLine({ worker_id: wid });
  assert.ok(l.bytes <= LINE_MAX);
  assert.ok(l.text.includes('write the tests'));
  assert.ok(/stated/i.test(l.text) && /unverified/i.test(l.text), 'a worker claim must be labelled as one');
  assert.ok(l.checkpoint_id, 'the line names the checkpoint it came from');

  const huge = 'x'.repeat(5000);
  await worker.continuity.checkpoint({ task_id: taskId, turn: 2, next_step: huge });
  l = await orch.continuity.resumeLine({ task_id: taskId });
  assert.ok(l.bytes <= LINE_MAX, `${l.bytes} bytes: an overlong claim must be truncated, never allowed to overflow`);
  assert.ok(l.text.includes('xxxxx'));
  assert.ok(l.text.endsWith(`memory_search "${taskId}".`), 'truncation trims the claim, not the store query');
});

test('multi-byte text never splits a character or overflows the budget', async () => {
  await worker.continuity.checkpoint({ task_id: taskId, turn: 3, next_step: '「日本語のテキスト」'.repeat(200) });
  const l = await orch.continuity.resumeLine({ task_id: taskId });
  assert.ok(l.bytes <= LINE_MAX, `${l.bytes} bytes`);
  assert.ok(!l.text.includes('�'), 'a truncated multi-byte sequence is dropped, not shipped as a replacement char');
});

test('resumeDoc has the named sections, labels the unverified one, and stays inside 4096 bytes', async () => {
  for (let i = 0; i < 14; i++) {
    await orch.memory.store({ namespace: `run/test-run`, text: `turn ${i}: the worker said something about the store`, tags: [taskId, wid, `turn:${i}`], embedding: [i + 1, 1], embedding_model: 'm', dim: 2 });
  }
  await orch.continuity.checkpoint({ task_id: taskId, worker_id: wid, turn: 3, files_touched: ['src/core/index.cjs'], tool_digest: [{ tool: 'Edit', args_sha256_12: 'abc123', result_bytes: 40, at: Date.now() }] });

  const d = await orch.continuity.resumeDoc({ task_id: taskId });
  assert.ok(d.bytes <= DOC_MAX, `${d.bytes} bytes exceeds the ${DOC_MAX}-byte budget`);
  assert.strictEqual(d.bytes, Buffer.byteLength(d.text, 'utf8'));
  for (const name of ['spec', 'acceptance', 'files owned', 'lease', 'last harness checkpoint']) {
    assert.ok(d.sections.some(s => s.startsWith(name)), `missing section ${name}: ${d.sections.join(' | ')}`);
  }
  const unverified = d.sections.find(s => s.includes('worker-stated'));
  assert.ok(unverified && /unverified/i.test(unverified), 'the worker-stated section heading must say it is unverified');
  assert.ok(d.text.includes('src/core'), 'the owned files are in the document');
  assert.ok(d.text.includes('Edit'), 'the harness tool digest is in the document, labelled as harness-derived');
  assert.ok(d.text.includes('turn 13') || d.text.includes('turn 1'), 'memory rows tagged with the task id are in the document');
});

test('the document carries the three orientation rules and truncation cannot drop them', async () => {
  const d = await orch.continuity.resumeDoc({ task_id: taskId });
  for (const rule of ['cannot see your peers', 'task_list and memory_search', 'a peer answers with a claim']) {
    assert.ok(d.text.includes(rule), `the brief states: ${rule} (ADR 0013 2)`);
  }
  // The rules are header, not a section, so the section budget can never eat them.
  const t = await orch.task.create({ spec: 'X'.repeat(30000) });
  const big = await orch.continuity.resumeDoc({ task_id: t.id });
  assert.ok(big.bytes <= DOC_MAX, `${big.bytes} bytes`);
  assert.ok(big.text.includes('a peer answers with a claim'), 'a runaway spec does not cost the worker its orientation');
});

test('an enormous spec is truncated to fit rather than overflowing', async () => {
  const t = await orch.task.create({ spec: 'S'.repeat(20000), files_owned: ['big/huge'] });
  await orch.task.assign({ task_id: t.id, worker_id: wid });
  const d = await orch.continuity.resumeDoc({ task_id: t.id });
  assert.ok(d.bytes <= DOC_MAX, `${d.bytes} bytes`);
  assert.ok(d.text.includes('truncated to fit'), 'the document says where it was cut');
  const l = await orch.continuity.resumeLine({ task_id: t.id });
  assert.ok(l.bytes <= LINE_MAX);
});

test('a briefing needs an id it can resolve, and resolves a worker through its lease', async () => {
  await assert.rejects(orch.continuity.resumeLine({}), e => e.code === 'E_ARGS');
  await assert.rejects(orch.continuity.resumeDoc({ task_id: 'no-such-task' }), e => e.code === 'E_NOT_FOUND');
  await assert.rejects(orch.continuity.resumeLine({ worker_id: 'no-such-worker' }), e => e.code === 'E_NOT_FOUND');
  const l = await worker.continuity.resumeLine({ worker_id: wid });
  assert.strictEqual(l.task_id, taskId);
});

test('reading a briefing writes nothing to the data dir', async (tcx) => {
  await orch.shutdownOwner();
  const reader = await openCore({ dataDir: dir, caller: callerFor('operator'), embed: false });
  tcx.after(() => Promise.resolve().then(() => reader.close()));
  const before = listDataDir(dir);
  await reader.continuity.resumeLine({ task_id: taskId });
  await reader.continuity.resumeDoc({ task_id: taskId });
  assert.deepStrictEqual(listDataDir(dir), before, 'a briefing is derived from rows and writes nothing');
  await reader.close();
  // Re-elect explicitly (a Core that shut its owner down never elects again by itself, ADR 0051) so the after() hook has an
  // owner to stop; the run manager writes resume.md, not the core.
  await orch.becomeOwner();
  await orch.run.attach({ adapter_pid: process.pid });
});

test('resumeDoc resolves the "project" namespace alias like memory.store does', async () => {
  await orch.run.attach({ adapter_pid: process.pid, project: 'demo' });
  await orch.memory.store({ namespace: 'project/demo', text: 'project-wide finding for the alias', tags: [taskId], embed: false });
  const viaAlias = await orch.continuity.resumeDoc({ task_id: taskId, namespace: 'project' });
  assert.ok(viaAlias.text.includes('project-wide finding for the alias'), 'the alias reaches project/demo');
  const viaName = await orch.continuity.resumeDoc({ task_id: taskId, namespace: 'project/demo' });
  assert.ok(viaName.text.includes('project-wide finding for the alias'));
});
