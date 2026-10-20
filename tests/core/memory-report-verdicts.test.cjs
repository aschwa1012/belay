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
  kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `add a ${marker} test fixture`, basis: 'observed',
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
  assert.deepStrictEqual(out.report_verdicts.unjudged, [], 'refused once, not also unjudged');
  assert.deepStrictEqual(out.report_verdicts.refused_open, [a.note], 'the report stays open and is named for the next review');
  // D16: the review ran and its verdict was refused, so the report is still unjudged and stays on the operator's list.
  assert.ok((await call('memory.held', orch, { reports: true })).unjudged_reports.some((r) => r.id === a.note && r.task_id === tb), 'a refused verdict leaves the report on the operator list');
});

test('P4b: an ok review-job receipt for the reporter\'s task judges nothing: the report stays on the operator list until a verdict is applied', async () => {
  const a = await written('w-a4b', 'K40');
  const tb = await reported('w-b4b', a.note);
  const listed = async () => (await call('memory.held', orch, { reports: true })).unjudged_reports.filter((r) => r.id === a.note && r.task_id === tb).length;
  assert.strictEqual(await listed(), 1, 'listed before the job');
  await call('memory.recordEvent', harness, { kind: 'review_job', ok: true, worker_id: 'notereview-x', task_id: tb, key: `task:${tb}`, message: 'reports applied 0, refused 1' });
  assert.strictEqual(await listed(), 1, 'still listed after a job that left the report unjudged');
  const rt = await review('rev-4b', tb, { report_verdicts: [rv(a.note, 'rejected', [cite('fixtures/unlisted.json was opened by the loader')])] });
  const out = await apply(rt);
  assert.strictEqual(out.report_verdicts.applied.length, 1, JSON.stringify(out.report_verdicts.refused));
  assert.strictEqual(await listed(), 0, 'a verdict applied is what takes it off');
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

const mark = (id, status) => store.p('UPDATE memory_entries SET status = ? WHERE id = ?').run(status, id);
const heldFor = (id) => store.p("SELECT COUNT(*) AS n FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").get(id).n;
const UPHELD = (id) => [rv(id, 'upheld', [cite('fixtures/unlisted.json was opened by the loader')], 'the stream shows the file was opened')];
const keyed = (rt, id) => events('note_review').filter((e) => e.key.endsWith(`:report:${id}`) && e.key.includes(rt));

test('P8: a second application of a rejected report answers already and adds no second entry or receipt', async () => {
  const a = await written('w-a9', 'K9');
  const tb = await reported('w-b9', a.note);
  const rt = await review('rev-9', tb, { report_verdicts: [rv(a.note, 'rejected', [cite('fixtures/unlisted.json was opened by the loader')], 'only in a test')] });
  const first = await apply(rt);
  assert.strictEqual(first.report_verdicts.applied.length, 1);
  const second = await apply(rt);
  assert.deepStrictEqual([second.report_verdicts.applied.length, second.report_verdicts.already.length], [0, 1]);
  assert.strictEqual(bodyOf(a.note).report_rejected.length, 1);
  assert.strictEqual(keyed(rt, a.note).length, 1);
});

test('P9: two applications of one review in flight write one entry and one receipt (the check is inside the transaction)', async () => {
  const a = await written('w-a10', 'K10');
  const tb = await reported('w-b10', a.note);
  const rt = await review('rev-10', tb, { report_verdicts: [rv(a.note, 'rejected', [cite('fixtures/unlisted.json was opened by the loader')], 'only in a test')] });
  const [x, y] = await Promise.all([apply(rt), apply(rt)]);
  assert.strictEqual(x.report_verdicts.applied.length + y.report_verdicts.applied.length, 1, JSON.stringify([x.report_verdicts, y.report_verdicts]));
  assert.strictEqual(x.report_verdicts.already.length + y.report_verdicts.already.length, 1);
  assert.strictEqual(bodyOf(a.note).report_rejected.length, 1);
  assert.strictEqual(keyed(rt, a.note).length, 1);
});

test('P10: a reviewer that made the report, or held a lease on the reporting task, cannot judge it (E_ROLE independence)', async () => {
  const a = await written('w-a11', 'K11');
  const tb = await reported('w-b11', a.note);
  const rt = await review('w-b11', tb, { report_verdicts: UPHELD(a.note) }); // the reporter itself reviews
  const out = await apply(rt);
  assert.deepStrictEqual([out.report_verdicts.applied.length, out.report_verdicts.refused[0].code], [0, 'E_ROLE']);
  assert.match(out.report_verdicts.refused[0].message, /made the report|held lease/);
  assert.strictEqual(heldFor(a.note), 0);
  // A worker that held a lease on the reporting task but did not make the report is refused the same way.
  const a2 = await written('w-a12', 'K12');
  const tb2 = await reported('w-b12', a2.note);
  const lease = store.p("SELECT id FROM lease WHERE task_id = ? AND holder = 'w-b12'").get(tb2);
  assert.ok(lease);
  store.p("UPDATE lease SET holder = 'w-b12x' WHERE id = ?").run(lease.id);
  const rt2 = await review('w-b12x', tb2, { report_verdicts: UPHELD(a2.note) });
  const out2 = await apply(rt2);
  assert.deepStrictEqual([out2.report_verdicts.applied.length, out2.report_verdicts.refused[0].code], [0, 'E_ROLE']);
  assert.match(out2.report_verdicts.refused[0].message, /held lease/);
  assert.strictEqual(heldFor(a2.note), 0);
});

test('P11: an upheld report against a review-verified note: the task reviewer holds it, the Haiku job only recommends', async () => {
  const a = await written('w-a13', 'K13');
  const tb = await reported('w-b13', a.note);
  mark(a.note, 'verified');
  const job = `notereview-${tb}`;
  await call('worker.write', orch, { id: job, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${job}`, last_event_at: Date.now() });
  const via = () => call('memory.noteVerdicts', harness, { job: { worker_id: job, reviewed_task_id: tb }, verdicts: [], report_verdicts: UPHELD(a.note) });
  const r = (await via()).report_verdicts;
  assert.deepStrictEqual([r.applied.length, r.applied[0].recommended_only, r.applied[0].receipt, heldFor(a.note)], [1, true, 'report_recommended', 0], JSON.stringify(r));
  const b = bodyOf(a.note);
  assert.deepStrictEqual([b.held, b.report_recommended.length, b.report_judgments[0].verdict], [undefined, 1, 'recommended']);
  const listed = (await call('memory.held', orch, { reports: true })).unjudged_reports.filter((x) => x.id === a.note);
  assert.deepStrictEqual(listed.map((x) => x.recommended), [true]);
  assert.strictEqual((await via()).report_verdicts.already.length, 1);
  // The same situation with a task's reviewer: the hold is made.
  const c = await written('w-a14', 'K14');
  const tc = await reported('w-b14', c.note);
  mark(c.note, 'verified');
  const o2 = await apply(await review('rev-14', tc, { report_verdicts: UPHELD(c.note) }));
  assert.deepStrictEqual([o2.report_verdicts.applied.length, heldFor(c.note), o2.report_verdicts.applied[0].recommended_only], [1, 1, undefined]);
});

test('P12: a malformed report_verdicts list is refused whole, before any note verdict is written', async () => {
  const a = await written('w-a15', 'K15');
  const good = { id: a.note, verdict: 'confirmed', cites: [cite('the loader worked as the note says')], reason: 'the stream shows it' };
  const rt = await review('rev-15', a.task, { memory_verdicts: [good], report_verdicts: {} });
  await assert.rejects(apply(rt), (e) => e.code === 'E_ARGS' && /report_verdicts/.test(e.message));
  assert.strictEqual(rowOf(a.note).status ?? 'unverified', 'unverified');
  assert.strictEqual(events('note_review').filter((e) => e.key.includes(rt)).length, 0);
  const lists = [
    new Array(17).fill(0).map((_, i) => rv(`m-${i}`, 'upheld', [cite('x')])),
    [{ id: a.note, verdict: 'maybe', cites: [], reason: 'r' }],
    [rv(a.note, 'rejected', [cite('x')]), rv(a.note, 'rejected', [cite('x')])],
  ];
  for (const [i, list] of lists.entries()) {
    const r2 = await review(`rev-15-${i}`, a.task, { memory_verdicts: [good], report_verdicts: list });
    await assert.rejects(apply(r2), (e) => e.code === 'E_ARGS', `list ${i}`);
    assert.strictEqual(rowOf(a.note).status ?? 'unverified', 'unverified');
  }
});

test('P13: two tasks reporting one note: only the newest report is judged by the review of its task', async () => {
  const a = await written('w-a16', 'K16');
  await reported('w-b16', a.note, 'first report');
  const t2 = await reported('w-c16', a.note, 'second report');
  const rt = await review('rev-16', t2, { report_verdicts: [rv(a.note, 'rejected', [cite('fixtures/unlisted.json was opened by the loader')], 'only in a test')] });
  const out = await apply(rt);
  assert.strictEqual(out.report_verdicts.applied.length, 1, JSON.stringify(out.report_verdicts));
  assert.strictEqual(bodyOf(a.note).report_rejected[0].why, 'second report');
  assert.strictEqual(bodyOf(a.note).report_judgments.length, 1);
});

// ---- the `unsupported` verdict (operator, 2026-10-17): a normal unverified note in its own on-demand queue kind -------------------------
const UNS = (id, over = {}) => ({ id, verdict: 'unsupported', reason: 'no single place proves or disproves it', ...over });
const queued = (id) => store.p("SELECT id, body FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ?").all(id).map((r) => ({ id: r.id, b: JSON.parse(r.body) }));
const streamOf = (w) => `${dir}/workers/${w}/stream.jsonl`.replace(/\\/g, '/');
const applyReview = (verdicts, files) => call('memory.reviewApply', harness, { verdicts, evidence_files: files, worktree: repo });
async function unsupportedNote(w, marker) {
  const a = await written(w, marker);
  const rt = await review(`rev-${w}`, a.task, { memory_verdicts: [UNS(a.note)] });
  const out = await apply(rt);
  return { ...a, rt, out };
}

test('U1: a reviewer answers unsupported with a reason and no cites: the note stays unverified with no warning, and is queued as its own kind', async () => {
  const u = await unsupportedNote('w-u1', 'K20');
  assert.deepStrictEqual([u.out.applied.length, u.out.applied[0].verdict, u.out.applied[0].status, u.out.refused.length], [1, 'unsupported', 'unverified', 0], JSON.stringify(u.out));
  const n = rowOf(u.note), b = bodyOf(u.note);
  assert.deepStrictEqual([n.status ?? 'unverified', n.namespace, b.held, b.unsupported.state], ['unverified', 'project/acme', undefined, 'open']);
  const q = queued(u.note);
  assert.deepStrictEqual([q.length, q[0].b.kind, q[0].b.state, q[0].b.ground, q[0].b.cites], [1, 'unsupported', 'held', 'unsupported', []]);
  assert.strictEqual(events('note_refuted').filter((e) => e.key === `refuted:${u.note}`).length, 0, 'no wake');
  const queue = await call('memory.reviewQueue', harness, {});
  assert.ok(queue.held.some((h) => h.id === u.note && h.kind === 'unsupported' && h.note.run_id));
  const held = await call('memory.held', orch, {});
  assert.ok(held.unsupported >= 1 && held.unsupported_by_project.acme >= 1 && held.total >= held.unsupported);
  const again = await apply(u.rt);
  assert.strictEqual(again.already.length, 1);
  assert.strictEqual(queued(u.note).length, 1, 'a second application queues nothing more');
  const brief = await call('memory.reviewBrief', orch, { reviewed_task_id: u.task });
  assert.ok(!brief.notes.some((x) => x.id === u.note), 'an unsupported note is not offered to a note review again');
});

test('U2: the Haiku job route takes unsupported too; cites are optional but checked when given; a bad cite drops the verdict', async () => {
  const a = await written('w-u2', 'K21');
  const job = `notereview-${a.task}`;
  await call('worker.write', orch, { id: job, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${job}`, last_event_at: Date.now() });
  const via = (verdicts) => call('memory.noteVerdicts', harness, { job: { worker_id: job, reviewed_task_id: a.task }, verdicts });
  const bad = await via([UNS(a.note, { cites: [cite('a line nobody ever saw in any stream')] })]);
  assert.deepStrictEqual([bad.applied.length, bad.refused[0].code], [0, 'E_CITATION']);
  const ok = await via([UNS(a.note, { cites: [cite('the loader worked as the note says')] })]);
  assert.deepStrictEqual([ok.applied.length, ok.applied[0].status], [1, 'unverified']);
  assert.strictEqual(queued(a.note)[0].b.cites.length, 1);
});

test('U3: the Opus reviewer verifies an unsupported note on cites: verified, receipt returned, off the queue', async () => {
  const u = await unsupportedNote('w-u3', 'K22');
  const r = await applyReview([{ id: u.note, verdict: 'verify', reason: 'the stream shows the loader works as stated', cites: [{ where: `stream:${streamOf('w-u3')}`, quote: 'the loader worked as the note says' }] }], [streamOf('w-u3')]);
  assert.deepStrictEqual([r.applied.length, r.refused.length, r.applied[0].outcome, r.applied[0].status], [1, 0, 'verified', 'verified'], JSON.stringify(r));
  assert.match(r.applied[0].receipt, /^review:r-rep:/);
  const n = rowOf(u.note);
  assert.deepStrictEqual([n.status, n.status_receipt, bodyOf(u.note).unsupported.state, queued(u.note)[0].b.state], ['verified', r.applied[0].receipt, 'verified', 'verified']);
  assert.ok(!(await call('memory.reviewQueue', harness, {})).held.some((h) => h.id === u.note));
});

test('U4: refute marks the note refuted with the wake receipt; still_unsupported leaves the queue and the note unverified', async () => {
  const u = await unsupportedNote('w-u4', 'K23');
  const r = await applyReview([{ id: u.note, verdict: 'refute', reason: 'the stream shows the opposite', cites: [{ where: `stream:${streamOf('w-u4')}`, quote: 'the loader worked as the note says' }] }], [streamOf('w-u4')]);
  assert.deepStrictEqual([r.applied[0].outcome, rowOf(u.note).status, bodyOf(u.note).unsupported.state], ['refuted', 'refuted', 'refuted']);
  assert.strictEqual(events('note_refuted').filter((e) => e.key === `refuted:${u.note}`).length, 1, 'the orchestrator wake source');
  const s = await unsupportedNote('w-u5', 'K24');
  const r2 = await applyReview([{ id: s.note, verdict: 'still_unsupported', reason: 'the evidence does not settle it' }], []);
  assert.deepStrictEqual([r2.applied[0].outcome, r2.applied[0].receipt.startsWith('review:r-rep:')], ['still_unsupported', true]);
  assert.deepStrictEqual([rowOf(s.note).status ?? 'unverified', bodyOf(s.note).unsupported.state, bodyOf(s.note).held], ['unverified', 'still_unsupported', undefined]);
  assert.ok(!(await call('memory.reviewQueue', harness, {})).held.some((h) => h.id === s.note));
  const brief = await call('memory.reviewBrief', orch, { reviewed_task_id: s.task });
  assert.ok(!brief.notes.some((x) => x.id === s.note), 'it is not offered to a note review again');
});

test('U5: wrong answers for the kind are refused with a reason; a verify without a real cite is refused and written on the row', async () => {
  const u = await unsupportedNote('w-u6', 'K25');
  const wrongKind = await applyReview([{ id: u.note, verdict: 'archive', reason: 'x', cites: [] }], []);
  assert.deepStrictEqual([wrongKind.applied.length, wrongKind.refused[0].code], [0, 'E_PRECONDITION']);
  const noCite = await applyReview([{ id: u.note, verdict: 'verify', reason: 'looks right' }], []);
  assert.deepStrictEqual([noCite.refused[0].code, noCite.refused[0].outcome], ['E_CITATION', 'refused']);
  const fake = await applyReview([{ id: u.note, verdict: 'refute', reason: 'wrong', cites: [{ where: `stream:${streamOf('w-u6')}`, quote: 'a line that was never in the stream' }] }], [streamOf('w-u6')]);
  assert.strictEqual(fake.refused[0].code, 'E_CITATION');
  assert.strictEqual(rowOf(u.note).status ?? 'unverified', 'unverified');
  assert.strictEqual(queued(u.note)[0].b.reviews.length, 2, 'both refusals are on the row');
  assert.strictEqual(queued(u.note)[0].b.state, 'held', 'still in the queue');
});

test('U6: a hold with a warning takes archive or release only', async () => {
  const a = await written('w-a30', 'K26');
  const tb = await reported('w-b30', a.note);
  await apply(await review('rev-30', tb, { report_verdicts: UPHELD(a.note) }));
  const r = await applyReview([{ id: a.note, verdict: 'verify', reason: 'x', cites: [cite('the loader worked as the note says')] }], []);
  assert.deepStrictEqual([r.applied.length, r.refused[0].code], [0, 'E_PRECONDITION']);
});

test('U7: verify or refute cites only TOOL RESULTS of non-belay tools: the note itself, belay tool inputs, assistant prose and the task brief are refused', async () => {
  const u = await unsupportedNote('w-u7', 'K27');
  const note = rowOf(u.note);
  const BRIEF = 'The loader is known to be fine with empty input per the maintainer';
  const PROSE = 'loadConfig handles empty files by returning defaults, I checked it';
  const INPUT = 'belay-input-only-phrase-for-the-lease-release';
  const REAL = 'REAL-TOOL-OUTPUT: the loader returned defaults for the empty file';
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(streamOf('w-u7'),
    line({ type: 'user', message: { role: 'user', content: BRIEF } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: PROSE }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tb1', name: 'mcp__belay__lease_release', input: { notes: [{ title: note.title, text: INPUT }] } }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tr1', name: 'Bash', input: { command: 'run-it' } }] } })
    + line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tr1', content: [{ type: 'text', text: REAL }] }] } }));
  const forbidden = [['the note itself', note.title], ['the task brief', BRIEF], ['assistant prose', PROSE], ['a belay tool input', INPUT]];
  for (const [what, quote] of forbidden) {
    for (const verdict of ['verify', 'refute']) {
      const r = await applyReview([{ id: u.note, verdict, reason: 'x', cites: [{ where: `stream:${streamOf('w-u7')}`, quote }] }], [streamOf('w-u7')]);
      assert.deepStrictEqual([r.applied.length, r.refused[0] && r.refused[0].code], [0, 'E_CITATION'], `${what} / ${verdict}: ${JSON.stringify(r.refused)}`);
    }
  }
  assert.strictEqual(rowOf(u.note).status ?? 'unverified', 'unverified');
  assert.strictEqual(events('note_refuted').filter((e) => e.key === `refuted:${u.note}`).length, 0, 'no wake from a refused refute');
  const ok = await applyReview([{ id: u.note, verdict: 'refute', reason: 'the tool output shows defaults', cites: [{ where: `stream:${streamOf('w-u7')}`, quote: REAL }] }], [streamOf('w-u7')]);
  assert.deepStrictEqual([ok.applied.length, rowOf(u.note).status], [1, 'refuted'], 'a real tool result is evidence');
});
