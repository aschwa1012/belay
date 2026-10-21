'use strict';
// ended-run-in-flight-memory.test.cjs — a memory write that awaited something (git for a commit receipt, a file for a review's
// citation check) is refused when its run ended meanwhile, and writes nothing (audit D42). Each wait is a gate the test opens or
// the real citation check's own test seam: the run ends inside the wait, then the write meets its guard. Removing a guard makes
// its test fail, because the write then lands in the ended run.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const CC = core('memory-citations.cjs');
const EV = core('evaluate.cjs');

let dir, repo, store, E, head, n = 0;
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const events = (kind) => store.p('SELECT * FROM memory_event WHERE kind = ?').all(kind);
const DIM = 64;
// One axis per marker word, so two notes of different markers do not look like duplicates and stay live.
let axis = 0;
const axes = new Map();
let embedWaiting = null, embedGate = null; // set by a test that parks the embedder; null otherwise
const embed = async (text) => {
  if (embedWaiting) embedWaiting();
  if (embedGate) await embedGate;
  const m = /the (\w+) loader/.exec(text);
  const key = m ? m[1] : text;
  if (!axes.has(key)) axes.set(key, axis++ % DIM);
  const v = new Array(DIM).fill(0);
  v[axes.get(key)] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};
const ended = (p) => assert.rejects(p, (e) => { assert.strictEqual(e.code, 'E_ARGS', e.message); assert.match(e.message, /has already ended/); return true; });
let useSeq = 0;
const toolResultLine = (text) => {
  const id = `tu${++useSeq}`;
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } })}\n`;
};

// A live run with its own callers and a worker `w` working in the sandbox repository.
async function world(tag) {
  const run = `r-fm-${tag}-${++n}`;
  const w = `w-${tag}`;
  const orch = callerFor('orchestrator', { run_id: run });
  const c = {
    run, w, orch,
    harness: callerFor('orchestrator', { run_id: run, channel: 'harness' }),
    operator: callerFor('operator', { run_id: run }),
    worker: callerFor('worker', { run_id: run, worker_id: w }),
  };
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  await call('worker.write', orch, { id: w, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${w}`, last_event_at: Date.now(), worktree: repo, head_sha: head });
  return c;
}
// Worker `workerId` works one task whose stream holds one tool result, releases it with `release`, and the task is evaluated done.
async function work(c, workerId, stream, release) {
  const t = await call('task.create', c.orch, { spec: `job ${++n}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const a = await call('task.assign', c.orch, { task_id: t.id, worker_id: workerId });
  await call('worker.write', c.orch, { id: workerId, task_id: t.id });
  fs.mkdirSync(`${dir}/workers/${workerId}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${workerId}/stream.jsonl`, toolResultLine(stream));
  const out = await call('lease.release', callerFor('worker', { run_id: c.run, worker_id: workerId }), { lease_id: a.new_lease.id, notes: [], ...release });
  await call('task.evaluate', c.orch, { task_id: t.id, worktree: dir });
  return { task: t.id, out };
}
const note = (marker) => ({
  kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `add a ${marker} test fixture`, basis: 'observed',
  evidence: [{ where: `src/${marker}.js`, saw: 'the unlisted file was never read' }], applies_to: [`src/${marker}.js`], subjects: [marker],
});
async function reviewTask(c, taskId, result) {
  const r = `rev-${c.w}`;
  await call('worker.write', c.orch, { id: r, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${r}`, last_event_at: Date.now() });
  const t = await call('task.create', c.orch, { spec: `review ${++n}`, depends_on: [taskId], acceptance: { verdict: true } });
  const a = await call('task.assign', c.orch, { task_id: t.id, worker_id: r });
  await call('lease.release', callerFor('worker', { run_id: c.run, worker_id: r }), { lease_id: a.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', ...result } });
  return t.id;
}
const cite = (quote, where = 'stream') => ({ where, quote });
const endDuringCheck = (c) => { CC.seam.afterCheck = async () => { CC.seam.afterCheck = null; await call('run.end', c.operator, { exit_reason: 'test' }); }; };

before(() => {
  dir = sandbox();
  repo = sandbox();
  fs.writeFileSync(`${repo}/loader.js`, "module.exports = function load() { return 'skips unlisted fixtures'; };\n");
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init');
  head = git('rev-parse', 'HEAD').trim();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
});
after(() => { CC.seam.afterCheck = null; store.close(); cleanup(dir); cleanup(repo); });

test('a memory.setStatus waiting on git for its commit receipt is refused when the run ends meanwhile, and the status stays as it was', async () => {
  const c = await world('st');
  const stored = await call('memory.store', c.worker, { text: 'the loader skips unlisted fixtures', embed: false });
  let open, waiting;
  const gate = new Promise((r) => { open = r; });
  const parked = new Promise((r) => { waiting = r; });
  const real = EV.runCommand;
  EV.runCommand = async (...args) => {
    if (args[0][0] !== 'git') return real(...args);
    waiting();
    await gate;
    return { exit_code: 0, stdout: head };
  };
  try {
    const settled = ended(call('memory.setStatus', c.orch, { id: stored.id, status: 'verified', receipt: `commit:${head}` }));
    await parked; // the real event: the check is inside the git call
    await call('run.end', c.operator, { exit_reason: 'test' });
    open();
    await settled;
  } finally { EV.runCommand = real; }
  assert.strictEqual(rowOf(stored.id).status ?? 'unverified', 'unverified', 'no status was written into the ended run');
  assert.strictEqual(rowOf(stored.id).status_receipt, null);
});

test('a note verdict whose citation check outlasts run.end is refused and writes nothing, not even a refusal receipt', async () => {
  const c = await world('nv');
  const w = await work(c, c.w, 'fixtures/unlisted.json was never opened\n', { notes: [note('nv')] });
  const id = w.out.notes[0].id;
  const rt = await reviewTask(c, w.task, { memory_verdicts: [{ id, verdict: 'confirmed', cites: [cite('fixtures/unlisted.json was never opened')], reason: 'the stream shows it' }] });
  const reviewEvents = events('note_review').length;
  endDuringCheck(c);
  try {
    await ended(call('memory.noteVerdicts', c.harness, { review_task_id: rt }));
  } finally { CC.seam.afterCheck = null; }
  assert.strictEqual(rowOf(id).status ?? 'unverified', 'unverified', 'the verdict was not applied');
  assert.strictEqual(events('note_review').length, reviewEvents, 'no note_review receipt, applied or refused, was written');
});

test('a report verdict whose citation check outlasts run.end is refused and writes nothing', async () => {
  const c = await world('rv');
  const a = await work(c, c.w, 'the loader worked as the note says\n', { notes: [note('rv')] });
  const id = a.out.notes[0].id;
  const w2 = 'w-rv-b';
  await call('worker.write', c.orch, { id: w2, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-b', last_event_at: Date.now(), worktree: repo, head_sha: head });
  const b = await work(c, w2, 'fixtures/unlisted.json was opened by the loader\n', { reported_wrong: [{ id, why: 'the loader reads unlisted fixtures' }] });
  const rt = await reviewTask(c, b.task, { report_verdicts: [{ id, verdict: 'upheld', cites: [cite('fixtures/unlisted.json was opened by the loader')], reason: 'the stream shows the file was opened' }] });
  const reviewEvents = events('note_review').length;
  endDuringCheck(c);
  try {
    await ended(call('memory.noteVerdicts', c.harness, { review_task_id: rt }));
  } finally { CC.seam.afterCheck = null; }
  assert.strictEqual(store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").get(id).n, 0, 'no hold was written');
  assert.strictEqual(events('note_review').length, reviewEvents, 'no receipt was written');
});

test('a pending note resolved with a new title, whose re-embedding outlasts run.end, is refused and stays pending, unchanged', async () => {
  const c = await world('nr');
  await work(c, c.w, 'the loader skips them\n', { notes: [note('nr')] });
  const second = await work(c, c.w, 'again, the loader skips them\n', { notes: [note('nr', { title: 'the nr loader also skips unlisted fixtures' })] });
  const pid = second.out.notes[0].id;
  assert.strictEqual(second.out.notes[0].state, 'pending', 'a near-duplicate of a live note waits for its resolution');
  const before = rowOf(pid);
  let open, waiting;
  embedGate = new Promise((r) => { open = r; });
  const parked = new Promise((r) => { embedWaiting = r; });
  try {
    const settled = ended(call('memory.noteResolve', c.worker, { resolutions: [{ id: pid, resolve: 'new', title: 'the nr2 loader reads fixtures from the index' }] }));
    await parked; // the real event: freshVectors is inside the embedder
    await call('run.end', c.operator, { exit_reason: 'test' });
    open();
    await settled;
  } finally { embedGate = null; embedWaiting = null; }
  const after = rowOf(pid);
  assert.strictEqual(after.namespace, before.namespace, 'still in the pending namespace');
  assert.strictEqual(after.title, before.title, 'the title was not changed');
  assert.strictEqual(after.text, before.text);
  assert.strictEqual(JSON.parse(after.body).state, 'pending');
});

test('a note verdict whose citation check fails while the run ends in it is an ended run, and writes no refusal receipt', async () => {
  const c = await world('nvf');
  const w = await work(c, c.w, 'fixtures/unlisted.json was never opened\n', { notes: [note('nvf')] });
  const id = w.out.notes[0].id;
  const rt = await reviewTask(c, w.task, { memory_verdicts: [{ id, verdict: 'confirmed', cites: [cite('a line the stream never printed')], reason: 'invented' }] });
  const reviewEvents = events('note_review').length;
  endDuringCheck(c);
  try {
    await ended(call('memory.noteVerdicts', c.harness, { review_task_id: rt }));
  } finally { CC.seam.afterCheck = null; }
  assert.strictEqual(events('note_review').length, reviewEvents, 'no note_review receipt, not even an ok:false refusal, was written into the ended run');
});

test('a report verdict whose citation check fails while the run ends in it is an ended run, and writes no refusal receipt', async () => {
  const c = await world('rvf');
  const a = await work(c, c.w, 'the loader worked as the note says\n', { notes: [note('rvf')] });
  const id = a.out.notes[0].id;
  const w2 = 'w-rvf-b';
  await call('worker.write', c.orch, { id: w2, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-b', last_event_at: Date.now(), worktree: repo, head_sha: head });
  const b = await work(c, w2, 'fixtures/unlisted.json was opened by the loader\n', { reported_wrong: [{ id, why: 'the loader reads unlisted fixtures' }] });
  const rt = await reviewTask(c, b.task, { report_verdicts: [{ id, verdict: 'upheld', cites: [cite('a line the stream never printed')], reason: 'invented' }] });
  const reviewEvents = events('note_review').length;
  endDuringCheck(c);
  try {
    await ended(call('memory.noteVerdicts', c.harness, { review_task_id: rt }));
  } finally { CC.seam.afterCheck = null; }
  assert.strictEqual(events('note_review').length, reviewEvents, 'no receipt, applied or refused, was written');
});
