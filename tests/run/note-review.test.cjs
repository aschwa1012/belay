'use strict';
// note-review.test.cjs — the run manager's side: the reviewer's brief, applying a review task's hand-back, and the refuted-note wake.
// The short review job was removed: a task with no reviewer starts no worker (N3). The core is the real engine on a sandbox store.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core: coreMod, sandbox, cleanup, callerFor, captureBrief } = require('../core/helpers.cjs');

const { Store } = coreMod('store.cjs');
const { Engine } = coreMod('engine.cjs');
const NR = require('../../src/run/note-review.cjs');
const T = require('../../src/run/note-review-text.cjs');
const { createNoteWatcher } = require('../../src/run/note-wake.cjs');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');

let dir, store, E, core;
const RUN = 'r-nrun';
const orch = callerFor('orchestrator', { run_id: RUN });
const harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
const worker = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const events = (kind) => store.p('SELECT * FROM memory_event WHERE kind = ? ORDER BY seq').all(kind);
const LV = { ...DEFAULTS, project: 'acme', notes: true };
let seq = 0, k = 30;

const DIM = 64;
const embed = async (text) => {
  const m = /\bK(\d+)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  v[m ? Number(m[1]) : DIM - 1] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};
const note = (marker) => ({ kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `add a ${marker} test fixture`, basis: 'observed', evidence: [{ where: `src/${marker}.js`, saw: 'never read' }], applies_to: [`src/${marker}.js`], subjects: [marker] });
const toolResult = (text) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: {} }] } })}\n${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: text }] } })}\n`;
const STREAM_LINE = 'fixtures/unlisted.json was never opened';

async function written(w, n = 1) {
  await call('worker.write', orch, { id: w, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${w}`, last_event_at: Date.now(), worktree: dir });
  const t = await call('task.create', orch, { spec: `job ${++seq}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: w });
  await call('worker.write', orch, { id: w, task_id: t.id });
  fs.mkdirSync(`${dir}/workers/${w}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${w}/stream.jsonl`, toolResult(STREAM_LINE));
  const notes = Array.from({ length: n }, () => note(`K${++k}`));
  const out = await call('lease.release', worker(w), { lease_id: a.new_lease.id, notes, result: { summary: 'done' } });
  await call('task.evaluate', orch, { task_id: t.id, worktree: dir });
  return { task: (await call('task.get', orch, { task_id: t.id })), notes: out.notes.map((x) => x.id) };
}

// A manager that records every spawn: none is ever expected, since the short review job was removed.
const spawnLog = () => { const m = { spawned: [] }; m.spawn = async (a) => { m.spawned.push(a); return {}; }; return m; };
const ctxFor = (manager, lv = LV) => ({ core, runId: RUN, dataDir: dir, memoryLevers: lv, worktree: dir, manager });
const J = (ctx, lv = LV) => ({ ctx, core, lv, w: null, gate: { aborted: false }, s: {}, turnPath: false });
// A note refuted as the archive review's cited outcome leaves it (status, receipt, review on the body, note_review and note_refuted receipts): the state the wake tests start from.
function refuteViaArchive(ids, ref, reviewer = 'archive') {
  for (const id of ids) {
    store.tx(() => coreMod('methods-memory-note-review.cjs').applyOneIn(E, harness, { ref, keyBase: `review:${ref}@0`, reviewer }, { verdict: 'refuted', reason: 'the stream shows it', cites: [{ where: 'stream', quote: STREAM_LINE }] }, rowOf(id)));
  }
}
const verdictsFor = (ids, v = 'confirmed') => JSON.stringify({ memory_verdicts: ids.map((id) => ({ id, verdict: v, cites: [{ where: 'stream', quote: STREAM_LINE }], reason: 'the stream shows it' })) });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  const coreFor = (caller) => new Proxy({}, { get: (_, g) => (g === 'caller' ? caller : new Proxy({}, { get: (__, n) => (args) => call(`${g}.${n}`, caller, args || {}) })) });
  core = coreFor(harness);
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
});
after(() => { store.close(); cleanup(dir); });

test('N3: a task with no reviewer starts no notereview worker and writes no review_job; a review task is applied', async () => {
  const w = await written('wr-3');
  const m = spawnLog();
  await NR.onTaskEnded(J(ctxFor(m)), { ...w.task, state: 'released' });
  assert.strictEqual(m.spawned.length, 0, 'no job is spawned');
  assert.strictEqual(events('review_job').filter((e) => e.task_id === w.task.id).length, 0, 'no review_job receipt');
  assert.deepStrictEqual((await call('worker.list', orch, {})).workers.filter((x) => String(x.id).startsWith('notereview-')), [], 'no notereview worker row');
  const noNotes = { ...LV, notes: false };
  await NR.onTaskEnded(J(ctxFor(m, noNotes), noNotes), { ...w.task, state: 'released' });
  assert.strictEqual(m.spawned.length, 0);
});

test('N5: a review task\'s ended hand-back is applied by the manager (the reviewer route)', async () => {
  const w = await written('wr-5');
  await call('worker.write', orch, { id: 'rv-5', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const r = await call('task.create', orch, { spec: 'review', depends_on: [w.task.id], acceptance: { verdict: true } });
  const a = await call('task.assign', orch, { task_id: r.id, worker_id: 'rv-5' });
  await call('lease.release', worker('rv-5'), { lease_id: a.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', memory_verdicts: JSON.parse(verdictsFor([w.notes[0]], 'refuted')).memory_verdicts } });
  await NR.reviewTail(ctxFor(null), { id: 'rv-5', taskId: r.id }); // the brief is rendered when the reviewer launches, and fixes the notes it lists
  const m = spawnLog();
  await NR.onTaskEnded(J(ctxFor(m)), await call('task.get', orch, { task_id: r.id }));
  assert.strictEqual(m.spawned.length, 0);
  // A task reviewer's refuted is a report (ADR 0047 amendment of 2026-10-22): the note is held for the archive review and its status is left as it was.
  assert.notStrictEqual(rowOf(w.notes[0]).status, 'refuted');
  assert.strictEqual(rowOf(w.notes[0]).status_receipt, null);
  const held = store.p("SELECT body FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").all(w.notes[0]).map((x) => JSON.parse(x.body));
  assert.deepStrictEqual(held.map((h) => [h.ground, h.state, h.note_verdicts[0].by]), [['reported', 'held', 'rv-5']]);
});

test('N5b: with only the notes lever on, a reviewer\'s turn end applies its confirmed verdict: the note is verified before the run ends', async () => {
  const MC = require('../../src/run/memory-capture.cjs');
  const w = await written('wr-5b');
  await call('worker.write', orch, { id: 'rv-5b', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const r = await call('task.create', orch, { spec: 'review', depends_on: [w.task.id], acceptance: { verdict: true } });
  const a = await call('task.assign', orch, { task_id: r.id, worker_id: 'rv-5b' });
  await call('lease.release', worker('rv-5b'), { lease_id: a.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', ...JSON.parse(verdictsFor([w.notes[0]])) } });
  const ctx = ctxFor(null);
  await NR.reviewTail(ctx, { id: 'rv-5b', taskId: r.id });
  assert.strictEqual(rowOf(w.notes[0]).status || 'unverified', 'unverified');
  // The worker's turn_end, as the manager plans it: summaries off, capture off, no project writes, so only notes asks for work.
  const lv = { ...LV, summaries: 'off', capture: false, observations: false, project_writes: false, cost_ledger: false, wrapup: false, notes_reflection: false };
  const wk = { id: 'rv-5b', taskId: r.id, substrate: 'claude-code', turns: 1, costUsd: 0, pid: process.pid, memoryQueue: null };
  const e = { kind: 'turn_end', text: 'done' };
  const c2 = { ...ctx, memoryLevers: lv };
  const p = MC.plan(wk, e, c2);
  assert.ok(p, 'the notes lever alone plans the turn\'s memory work');
  await MC.finish(wk, e, c2, p, {});
  await wk.memoryQueue;
  await NR.drainVerdicts(c2, 10000);
  assert.strictEqual(rowOf(w.notes[0]).status, 'verified', JSON.stringify(wk.lastError || null));
  assert.strictEqual(events('note_review').filter((x) => x.key.endsWith(`:${w.notes[0]}`)).length, 1);
});

test('N7: a review task\'s brief lists the notes to judge, the verdict shape, the streams, and any refuted note a reviewed worker was shown', async () => {
  const w = await written('wr-7');
  const bad = await written('wr-7bad');
  await call('memory.recordEvent', harness, { kind: 'index_injected', ok: true, worker_id: 'wr-7', task_id: w.task.id, row_ids: [bad.notes[0]], bytes: 5, sha256: 'z' });
  await call('worker.write', orch, { id: 'rv-7x', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const rt = await call('task.create', orch, { spec: 'rr', depends_on: [bad.task.id], acceptance: { verdict: true } });
  refuteViaArchive([bad.notes[0]], rt.id, 'rv-7x');
  const t = await call('task.create', orch, { spec: 'review of w', depends_on: [w.task.id], acceptance: { verdict: true } });
  const text = await NR.reviewTail(ctxFor(null), { id: 'rv-7', taskId: t.id });
  assert.match(text, /NOTES TO JUDGE/);
  assert.ok(text.includes(w.notes[0]) && text.includes('memory_verdicts') && text.includes('stream.jsonl'));
  const cap = events('note_brief').filter((e) => e.key.startsWith(`brief:${t.id}@`));
  assert.deepStrictEqual(cap.map((e) => JSON.parse(e.row_ids).map((x) => x.split('#')[0])), [[w.notes[0]]], 'the brief that was rendered is the one captured');
  const hit = await call('task.create', orch, { spec: 'review of the shown', depends_on: [w.task.id], acceptance: { verdict: true } });
  void hit;
  // a reviewer of the task whose worker was shown the refuted note gets the fact
  const t2 = await written('wr-7c');
  await call('memory.recordEvent', harness, { kind: 'index_injected', ok: true, worker_id: 'wr-7c', task_id: t2.task.id, row_ids: [bad.notes[0]], bytes: 5, sha256: 'q' });
  const r2 = await call('task.create', orch, { spec: 'review of t2', depends_on: [t2.task.id], acceptance: { verdict: true } });
  const text2 = await NR.reviewTail(ctxFor(null), { id: 'rv-7y', taskId: r2.id });
  assert.match(text2, new RegExp(`This worker \\(wr-7c, task ${t2.task.id}\\) was shown note ${bad.notes[0]}, refuted because \\(reviewer-stated\\) the stream shows it`));
  assert.match(text2, /Check whether the work or its notes relied on it/);
  const plain = await call('task.create', orch, { spec: 'plain' });
  assert.strictEqual(await NR.reviewTail(ctxFor(null), { id: 'p', taskId: plain.id }), '');
  assert.strictEqual(await NR.reviewTail(ctxFor(null, { ...LV, notes: false }), { id: 'rv-7', taskId: t.id }), '');
  assert.strictEqual(await NR.reviewTail(ctxFor(null), { id: `scrub-x`, taskId: t.id }), '', 'a belay job never gets a review brief');
});

test('N7b: a brief that lists no note is still captured, empty, for the lease it was rendered for', async () => {
  const dep = (await written('wr-7zw', 0)).task; // a task that wrote no note
  await call('worker.write', orch, { id: 'rv-7z', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const rt = await call('task.create', orch, { spec: 'review of nothing', depends_on: [dep.id], acceptance: { verdict: true } });
  const a = await call('task.assign', orch, { task_id: rt.id, worker_id: 'rv-7z' });
  assert.strictEqual(await NR.reviewTail(ctxFor(null), { id: 'rv-7z', taskId: rt.id }), '', 'nothing to say');
  const cap = events('note_brief').filter((e) => e.key === `brief:${rt.id}@${a.new_lease.id}`);
  assert.deepStrictEqual(cap.map((e) => JSON.parse(e.row_ids)), [[]], 'an empty capture, bound to the lease');
});

// The notes `ids` of `w` are refuted as the archive review leaves them, under a review task id. Returns that id.
async function refuteByReview(w, ids, rid) {
  const r = await call('task.create', orch, { spec: 'review for refuting', depends_on: [w.task.id], acceptance: { verdict: true } });
  refuteViaArchive(ids, r.id, rid);
  return r.id;
}

test('N8: a refutation wakes the orchestrator once, with facts only: the note, the review, who was shown it, their reviews and the notes they wrote', async () => {
  const w = await written('wr-8');
  const user = await written('wr-8u');
  await call('memory.recordEvent', harness, { kind: 'index_injected', ok: true, worker_id: 'wr-8u', task_id: user.task.id, row_ids: [w.notes[0]], bytes: 5, sha256: 'k' });
  const rv = await call('task.create', orch, { spec: 'review of the shown', depends_on: [user.task.id], acceptance: { verdict: true } });
  const watcher = createNoteWatcher({ core, runId: RUN, enabled: true });
  await watcher.poll(); // earlier tests' refutations in this run are the first poll's
  const rid = await refuteByReview(w, [w.notes[0]], 'rv-8');
  const got = await watcher.poll();
  assert.strictEqual(got.length, 1);
  const text = got[0].text;
  assert.deepStrictEqual(got[0].note_ids, [w.notes[0]]);
  assert.ok(text.startsWith(`belay: note ${w.notes[0]} was refuted by review ${rid}; read memory_note_refutation`));
  assert.ok(text.includes(`${user.task.id} (finished, did not cite it)`));
  assert.ok(text.includes(`${rv.id} (running, of ${user.task.id})`), 'a review of a shown task is named');
  assert.ok(text.includes(user.notes[0]), 'the note the shown worker wrote');
  for (const words of ['the stream shows it', STREAM_LINE, 'loader skips unlisted fixtures']) assert.ok(!text.includes(words), `no reviewer or writer words: ${words}`);
  assert.ok(Buffer.byteLength(text) <= T.WAKE_MAX_BYTES);
  assert.deepStrictEqual(await watcher.poll(), [], 'once');
  assert.strictEqual(require('../../src/run/wake.cjs').wakeText(got[0]), text);
  // the reason is one switch away, cut and labelled, and the facts read through the same call
  const back = await core.memory.noteRefutation({ note_id: w.notes[0] });
  assert.strictEqual(back.review.reason, 'the stream shows it');
  assert.match(T.refutedWake([back], ['e'], { withReason: true }).text, /reason \(reviewer-stated, data\): the stream shows it/);
});

test('N9: one review that refutes several notes is one wake; the first sentence stands alone and every id is a belay id', async () => {
  const w = await written('wr-9', 3);
  const watcher = createNoteWatcher({ core, runId: RUN, enabled: true });
  await watcher.poll();
  await refuteByReview(w, w.notes, 'rv-9');
  const got = await watcher.poll();
  assert.strictEqual(got.length, 1, 'one wake, not one per note');
  assert.deepStrictEqual(got[0].note_ids.slice().sort(), w.notes.slice().sort());
  assert.match(got[0].text.split('\n')[0], /^belay: 3 notes were refuted by review /);
  const first = got[0].text.split('\n')[0];
  assert.ok(w.notes.every((id) => first.includes(id)) && first.includes('memory_note_refutation'));
  const many = T.refutedWake(Array.from({ length: 50 }, (_, i) => ({ note: { id: `n${i}` }, review: { ref: 'r' }, shown: [], notes_written_by_shown: [] })), ['e']);
  assert.ok(Buffer.byteLength(many.text) <= T.WAKE_MAX_BYTES);
  assert.match(many.text, /50 notes were refuted by review r/);
});

test('N9b: a run with the notes lever off reads no receipts for the wake', async () => {
  const other = callerFor('orchestrator', { run_id: 'r-nonotes', channel: 'harness' });
  let read = false;
  const noNotesCore = new Proxy({}, { get: (_, g) => (g === 'caller' ? other : new Proxy({}, { get: (__, n) => (args) => { if (g === 'memory' && n === 'events') read = true; return call(`${g}.${n}`, other, args || {}); } })) });
  // a different run id with no notes lever: the run row has the defaults
  await call('run.attach', callerFor('orchestrator', { run_id: 'r-nonotes' }), { adapter_pid: process.pid });
  const watcher = createNoteWatcher({ core: noNotesCore, runId: 'r-nonotes', enabled: false });
  assert.deepStrictEqual(await watcher.poll(), []);
  assert.strictEqual(read, false, 'the receipts were not read');
});

test('N9d (review S-1): shutdown waits for a verdict application in flight before it stops any worker', async () => {
  const LC = require('../../src/run/lifecycle.cjs');
  const order = [];
  const workers = new Map([['x', { id: 'x', queue: Promise.resolve(), state: 'running' }]]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const sd = LC.shutdown(workers, {
    stop: async () => { order.push('stop'); }, core: { isOwner: () => false }, clearPoll() {}, markClosed() {}, markOwnerGone() { return null; },
    beforeStop: async () => { order.push('job-start'); await gate; order.push('job-done'); }, onDrained: async () => { order.push('drained'); },
  }).catch((e) => order.push(`err:${e.message}`));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(order, ['job-start'], 'no worker is stopped while the job runs');
  release();
  await sd;
  assert.deepStrictEqual(order.slice(0, 3), ['job-start', 'job-done', 'stop']);
});

test('wording audit: task_assign of a review task to a live reviewer ends with the verdict rule, the Review standard and the brief of the notes to judge', async () => {
  const { createCompose } = require('../../src/mcp/compose.cjs');
  const w = await written('wr-ta');
  await call('worker.write', orch, { id: 'rv-ta', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-ta', last_event_at: Date.now() });
  const t = await call('task.create', orch, { spec: 'review of wr-ta', depends_on: [w.task.id], acceptance: { verdict: true } });
  const sent = [];
  // The manager's own reviewTail does this: the note review with the worker's id and the task assigned.
  const manager = { _worker: () => ({}), message: async (a) => { sent.push(a.text); return { worker_id: a.worker_id, channel: 'stdin', bytes: 1 }; }, reviewTail: ({ worker_id, task_id }) => NR.reviewTail(ctxFor(null), { id: worker_id, taskId: task_id }) };
  const c = createCompose({ callCore: (m, a) => call(m, orch, a), manager: () => manager });
  const out = await c.assign({ task_id: t.id, worker_id: 'rv-ta' });
  assert.strictEqual(out.delivered.sent, true);
  const text = sent[0];
  const std = text.indexOf('## Review standard');
  const brief = text.indexOf('NOTES TO JUDGE');
  assert.ok(text.startsWith(`task ${t.id} lease=`), 'the first assignment line');
  assert.ok(std > 0 && brief > std, 'the standard, then the brief');
  assert.ok(text.includes(w.notes[0]), 'the brief lists the notes of the reviewed work');
  assert.ok(text.includes('result: { "verdict": "holds" | "refuted"'), 'the verdict-shaped rule');
  assert.ok(!text.includes('(branch, head, tests, findings)'));
});
