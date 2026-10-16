'use strict';
// memory-report-verdicts.test.cjs — a worker's report that a note is WRONG is judged by the task's reviewer (or the review job), with
// cites: an upheld report creates a `wrong` hold (the note stays visible), a rejected one leaves a report_rejected receipt on the note.
// Real core against a sandbox store, a real stream file and a real git repo. Nothing here starts a model.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, repo, store, E, head;
const RUN = 'r-rep';
const orch = callerFor('orchestrator', { run_id: RUN });
const harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
const worker = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const bodyOf = (id) => JSON.parse(rowOf(id).body);
const events = (kind) => store.p('SELECT * FROM memory_event WHERE kind = ? ORDER BY seq').all(kind);
let seq = 0, useSeq = 0;

const DIM = 64;
const embed = async (text) => {
  const m = /\bK(\d+)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  v[m ? Number(m[1]) : DIM - 1] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};
const note = (marker) => ({
  kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, basis: 'observed',
  evidence: [{ where: `src/${marker}.js`, saw: 'the unlisted file was never read' }], applies_to: [`src/${marker}.js`], subjects: [marker],
});
const toolResultLine = (text) => {
  const id = `tu${++useSeq}`;
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } })}\n`;
};

async function startTask(w, stream) {
  await call('worker.write', orch, { id: w, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${w}`, last_event_at: Date.now(), worktree: repo, head_sha: head });
  const t = await call('task.create', orch, { spec: `job ${++seq}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: w });
  await call('worker.write', orch, { id: w, task_id: t.id });
  fs.mkdirSync(`${dir}/workers/${w}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${w}/stream.jsonl`, toolResultLine(stream));
  return { task: t.id, lease: a.new_lease.id };
}
// Worker `w` wrote one note.
async function written(w, marker) {
  const s = await startTask(w, 'the loader worked as the note says\n');
  const out = await call('lease.release', worker(w), { lease_id: s.lease, notes: [note(marker)] });
  await call('task.evaluate', orch, { task_id: s.task, worktree: dir });
  return { task: s.task, note: out.notes[0].id };
}
// Worker `w` worked a task and reported `noteId` wrong.
async function reported(w, noteId, why = 'the loader reads unlisted fixtures') {
  const s = await startTask(w, 'fixtures/unlisted.json was opened by the loader\n');
  await call('lease.release', worker(w), { lease_id: s.lease, notes: [], reported_wrong: [{ id: noteId, why }] });
  await call('task.evaluate', orch, { task_id: s.task, worktree: dir });
  return s.task;
}
async function review(r, taskId, extra) {
  await call('worker.write', orch, { id: r, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${r}`, last_event_at: Date.now() });
  const t = await call('task.create', orch, { spec: `review ${++seq}`, depends_on: [taskId], acceptance: { verdict: true } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: r });
  await call('lease.release', worker(r), { lease_id: a.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', ...extra } });
  return t.id;
}
const cite = (quote, where = 'stream') => ({ where, quote });
const rv = (id, v, cites, reason = 'what the stream shows') => ({ id, verdict: v, cites, reason });
const apply = (reviewTask) => call('memory.noteVerdicts', harness, { review_task_id: reviewTask });

before(async () => {
  dir = sandbox();
  repo = sandbox();
  fs.writeFileSync(`${repo}/loader.js`, "module.exports = function load() { return 'reads unlisted fixtures'; };\n");
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init');
  head = git('rev-parse', 'HEAD').trim();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
});
after(() => { store.close(); cleanup(dir); cleanup(repo); });

test('P1: a review task\'s brief carries the reports its task made about other notes: the row, the why, the replacement and the head sha', async () => {
  const a = await written('w-a1', 'K1');
  const tb = await reported('w-b1', a.note, 'the loader reads unlisted fixtures');
  const t = await call('task.create', orch, { spec: 'review', depends_on: [tb], acceptance: { verdict: true } });
  const brief = await call('memory.reviewBrief', orch, { task_id: t.id });
  assert.strictEqual(brief.reports.length, 1, JSON.stringify(brief.reports));
  const r = brief.reports[0];
  assert.deepStrictEqual([r.note.id, r.note.written_by, r.report.task_id, r.report.why, r.report.replaced_by, r.head_sha], [a.note, 'worker:w-a1', tb, 'the loader reads unlisted fixtures', null, head]);
  const job = await call('memory.reviewBrief', orch, { reviewed_task_id: tb });
  assert.strictEqual(job.reports.length, 1, 'the review job form carries them too');
  const text = require('../../src/run/note-review-text.cjs').reviewerTail(brief, []);
  assert.match(text, /REPORTS TO JUDGE/);
  assert.match(text, /reporter-stated: the loader reads unlisted fixtures/);
  assert.match(text, /"report_verdicts"/);
  assert.ok(Buffer.byteLength(text) < 3000);
});

test('P2: an upheld report creates a wrong hold: the held row, the pointer on the note, the note stays live and unchanged', async () => {
  const a = await written('w-a2', 'K2');
  const tb = await reported('w-b2', a.note);
  const rt = await review('rev-2', tb, { report_verdicts: [rv(a.note, 'upheld', [cite('fixtures/unlisted.json was opened by the loader')], 'the stream shows the file was opened')] });
  const out = await apply(rt);
  const res = out.report_verdicts;
  assert.strictEqual(res.applied.length, 1, JSON.stringify(res));
  const held = res.applied[0].held;
  assert.deepStrictEqual([held.namespace, held.type, held.written_by, held.body.kind, held.body.ground, held.body.state, held.body.note_id, held.body.head_sha], ['held/acme', 'held', 'harness', 'wrong', 'report_confirmed', 'held', a.note, head]);
  assert.match(held.body.cites[0].where, /^stream:.*workers\/w-b2\/stream\.jsonl$/);
  const n = rowOf(a.note);
  assert.deepStrictEqual([n.namespace, n.status ?? 'unverified'], ['project/acme', 'unverified']);
  assert.strictEqual(bodyOf(a.note).held.row, held.id);
  assert.strictEqual(bodyOf(a.note).report_judgments[0].verdict, 'upheld');
  const q = await call('memory.reviewQueue', harness, {});
  assert.ok(q.held.some((h) => h.id === a.note && h.kind === 'wrong'));
  const ev = events('note_review').find((e) => e.key.endsWith(`:report:${a.note}`));
  assert.deepStrictEqual([ev.ok, ev.worker_id], [1, 'rev-2']);
  const again = await apply(rt);
  assert.strictEqual(again.report_verdicts.already.length, 1, 'a second application is a no-op');
  assert.strictEqual(store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").get(a.note).n, 1);
  const brief = await call('memory.reviewBrief', orch, { reviewed_task_id: tb });
  assert.deepStrictEqual(brief.reports, [], 'a judged report is not offered again');
});

test('P3: a rejected report leaves a report_rejected receipt on the note and no hold', async () => {
  const a = await written('w-a3', 'K3');
  const tb = await reported('w-b3', a.note);
  const rt = await review('rev-3', tb, { report_verdicts: [rv(a.note, 'rejected', [cite('fixtures/unlisted.json was opened by the loader')], 'the loader opens it only in a test')] });
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.applied[0].receipt], [1, 'report_rejected']);
  const b = bodyOf(a.note);
  assert.deepStrictEqual([b.report_rejected[0].by, b.report_rejected[0].ref, b.report_rejected[0].why], ['rev-3', rt, 'the loader reads unlisted fixtures']);
  assert.strictEqual(b.held, undefined);
  assert.strictEqual(store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").get(a.note).n, 0);
});

test('P4: a cite that is not in the reporter task\'s evidence is E_CITATION and nothing changes; the report stays open', async () => {
  const a = await written('w-a4', 'K4');
  const tb = await reported('w-b4', a.note);
  const rt = await review('rev-4', tb, { report_verdicts: [rv(a.note, 'upheld', [cite('a line nobody ever saw in any stream')])] });
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.refused[0].code], [0, 'E_CITATION']);
  assert.strictEqual(bodyOf(a.note).held, undefined);
  assert.deepStrictEqual(out.report_verdicts.unjudged, [a.note]);
});

test('P5: a reviewer never judges a report about a note it wrote', async () => {
  const a = await written('w-a5', 'K5');
  const tb = await reported('w-b5', a.note);
  const rt = await review('w-a5', tb, { report_verdicts: [rv(a.note, 'upheld', [cite('fixtures/unlisted.json was opened by the loader')])] });
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.refused[0].code], [0, 'E_ROLE']);
  assert.strictEqual(bodyOf(a.note).held, undefined);
});

test('P6: a verdict on a note nobody from the reviewed task reported is refused, and the orchestrator model cannot apply verdicts', async () => {
  const a = await written('w-a6', 'K6');
  const other = await written('w-o6', 'K7');
  const tb = await reported('w-b6', a.note);
  const rt = await review('rev-6', tb, { report_verdicts: [rv(other.note, 'upheld', [cite('fixtures/unlisted.json was opened by the loader')])] });
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.refused[0].code], [0, 'E_ARGS']);
  await assert.rejects(call('memory.noteVerdicts', orch, { review_task_id: rt }), (e) => e.code === 'E_ROLE');
});

test('P7: held notes and reports no review will judge are counted by memory.held and shown by status.get', async () => {
  const before = await call('memory.held', orch, { reports: true });
  assert.ok(before.total >= 1);
  assert.ok(before.by_project.acme >= 1);
  assert.strictEqual(typeof before.oldest_age_runs, 'number');
  // A report from a task that ended with no review is listed for the operator.
  const a = await written('w-a8', 'K8');
  const tb = await reported('w-b8', a.note);
  const list = (await call('memory.held', orch, { reports: true })).unjudged_reports;
  assert.ok(list.some((r) => r.id === a.note && r.task_id === tb), JSON.stringify(list));
  const scoped = await call('memory.held', orch, { project: 'other', reports: true });
  assert.deepStrictEqual([scoped.total, scoped.unjudged_reports], [0, []]);
  const st = await call('status.get', orch, {});
  assert.deepStrictEqual([st.notes_held.total, st.notes_held.by_project.acme], [before.total, before.by_project.acme]);
  // Once a review judges it, it is no longer listed.
  const rt = await review('rev-8', tb, { report_verdicts: [rv(a.note, 'rejected', [cite('fixtures/unlisted.json was opened by the loader')])] });
  await apply(rt);
  assert.ok(!(await call('memory.held', orch, { reports: true })).unjudged_reports.some((r) => r.id === a.note));
});
