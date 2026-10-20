'use strict';
// note-review-capture-k4.test.cjs — the verdict core of a note's review, K4 class fixes:
//   C1  the notes a review may judge are the ones its brief listed, captured when the brief was rendered; a later review, an edit or a
//       note written since changes nothing about what this review was shown, and a review with no capture judges nothing
//   C2  the citation echo exemption works on spans: a saw that appears inside any of the writer's other fields, embedded in a longer
//       sentence or not, is the writer's prose there and is never exempt

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core, sandbox, cleanup, callerFor, captureBrief, capturingCall } = require('./helpers.cjs');
const CC = require('../../src/core/memory-citations.cjs');
const { shownHash } = require('../../src/core/note-shown.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, store, E;
const RUN = 'r-k4c';
const orch = callerFor('orchestrator', { run_id: RUN });
const harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
const worker = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
const raw = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const call = capturingCall(raw, orch, harness);
const statusOf = (id) => store.p('SELECT status FROM memory_entries WHERE id = ?').get(id).status ?? 'unverified';
let seq = 0, useSeq = 0;

const DIM = 128;
const embed = async (text) => {
  const m = /\bK(\d+)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  v[m ? Number(m[1]) : DIM - 1] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};
const baseNote = (marker, over = {}) => ({
  kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `add a ${marker} test fixture`, basis: 'observed',
  evidence: [{ where: `src/${marker}.js`, saw: 'the unlisted file was never opened' }], applies_to: [`src/${marker}.js`], subjects: [marker], ...over,
});
const toolLines = (text, name = 'Bash') => {
  const id = `tu${++useSeq}`;
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } })}\n`;
};
const PRINTED = 'loader.js read 3 files\nfixtures/unlisted.json was never opened\n';

async function written(w, marker, { stream = toolLines(PRINTED), many = null, note = baseNote(marker) } = {}) {
  await raw('worker.write', orch, { id: w, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${w}`, last_event_at: Date.now(), worktree: dir });
  const t = await raw('task.create', orch, { spec: `job ${++seq}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const a = await raw('task.assign', orch, { task_id: t.id, worker_id: w });
  await raw('worker.write', orch, { id: w, task_id: t.id });
  fs.mkdirSync(`${dir}/workers/${w}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${w}/stream.jsonl`, stream);
  const out = await raw('lease.release', worker(w), { lease_id: a.new_lease.id, notes: many || [note] });
  for (const x of out.notes) assert.strictEqual(x.state, 'stored', JSON.stringify(x));
  await raw('task.evaluate', orch, { task_id: t.id, worktree: dir });
  return { task: t.id, note: out.notes[0].id, notes: out.notes.map((x) => x.id) };
}
async function review(r, taskId, verdicts) {
  await raw('worker.write', orch, { id: r, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${r}`, last_event_at: Date.now() });
  const t = await raw('task.create', orch, { spec: `review ${++seq}`, depends_on: [taskId], acceptance: { verdict: true } });
  const a = await raw('task.assign', orch, { task_id: t.id, worker_id: r });
  await raw('lease.release', worker(r), { lease_id: a.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', memory_verdicts: verdicts } });
  return t.id;
}
const verdict = (id, v, cites, reason = 'what the evidence shows') => ({ id, verdict: v, cites, reason });
const cite = (quote, where = 'stream') => ({ where, quote });
const Q = cite('fixtures/unlisted.json was never opened');

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await raw('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
});
after(() => { store.close(); cleanup(dir); });

test('C1a: a note the brief did not list stays unreviewed after another review confirmed one the brief did list', async () => {
  const many = Array.from({ length: 9 }, (_, i) => baseNote(`K${110 + i}`));
  const w = await written('w-c1a', 'K110', { many });
  const order = (await raw('memory.reviewBrief', orch, { reviewed_task_id: w.task })).notes.map((n) => n.id);
  assert.strictEqual(order.length, 9);
  // Review 1's brief is rendered now: it lists the first eight. Its reviewer will answer for the eighth and the ninth.
  const r1 = await review('rev-c1a-1', w.task, [verdict(order[7], 'confirmed', [Q]), verdict(order[8], 'confirmed', [Q])]);
  const cap = await captureBrief(raw, orch, harness, { review_task_id: r1 });
  assert.strictEqual(cap.notes, 8);
  // Another review confirms the first note. Recomputed now, the ninth note would be the eighth one listed.
  const r2 = await review('rev-c1a-2', w.task, [verdict(order[0], 'confirmed', [Q])]);
  assert.strictEqual((await call('memory.noteVerdicts', harness, { review_task_id: r2 })).applied.length, 1);
  assert.strictEqual(statusOf(order[0]), 'verified');
  const out = await raw('memory.noteVerdicts', harness, { review_task_id: r1 });
  assert.deepStrictEqual(out.applied.map((a) => a.id), [order[7]]);
  const refused = out.refused.find((r) => r.id === order[8]);
  assert.ok(refused && refused.detail && refused.detail.reason === 'not_shown', JSON.stringify(out.refused));
  assert.strictEqual(statusOf(order[8]), 'unverified', 'the ninth note was never in the brief');
});

test('C1b: a note edited after its brief was rendered is not the note the reviewer judged', async () => {
  const w = await written('w-c1b', 'K120');
  const r = await review('rev-c1b', w.task, [verdict(w.note, 'confirmed', [Q])]);
  await captureBrief(raw, orch, harness, { review_task_id: r });
  store.p("UPDATE memory_entries SET text = text || ' and the loader now also skips manifests' WHERE id = ?").run(w.note);
  const out = await raw('memory.noteVerdicts', harness, { review_task_id: r });
  assert.strictEqual(out.applied.length, 0);
  assert.strictEqual(out.refused[0].detail.reason, 'changed_since_shown', JSON.stringify(out.refused));
  assert.strictEqual(statusOf(w.note), 'unverified');
});

test('C1c: a review with no captured brief judges nothing, and only belay captures one', async () => {
  const w = await written('w-c1c', 'K121');
  const r = await review('rev-c1c', w.task, [verdict(w.note, 'confirmed', [Q])]);
  const out = await raw('memory.noteVerdicts', harness, { review_task_id: r });
  assert.deepStrictEqual([out.applied.length, out.refused[0].detail.reason], [0, 'not_shown']);
  assert.match(out.refused[0].message, /no brief was captured/);
  assert.strictEqual(statusOf(w.note), 'unverified');
  await assert.rejects(raw('memory.noteBriefCapture', orch, { review_task_id: r, notes: [{ id: w.note, hash: shownHash({}) }] }), (e) => e.code === 'E_ROLE');
  await assert.rejects(raw('memory.noteBriefCapture', harness, { review_task_id: r, notes: [{ id: w.note, hash: 'nothex' }] }), (e) => e.code === 'E_ARGS');
});

test('C1d: the job route judges the notes its notes file held, not a note written for the task since', async () => {
  const w = await written('w-c1d', 'K122', { many: [baseNote('K122'), baseNote('K123')] });
  const [a, b] = (await raw('memory.reviewBrief', orch, { reviewed_task_id: w.task })).notes;
  const job = { worker_id: `notereview-${w.task}`, reviewed_task_id: w.task };
  await raw('worker.write', orch, { id: job.worker_id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-job', last_event_at: Date.now() });
  await raw('memory.noteBriefCapture', harness, { job, notes: [{ id: a.id, hash: shownHash(a) }] });
  const out = await raw('memory.noteVerdicts', harness, { job, verdicts: [verdict(a.id, 'confirmed', [Q]), verdict(b.id, 'confirmed', [Q])] });
  assert.deepStrictEqual(out.applied.map((x) => x.id), [a.id]);
  assert.strictEqual(out.refused[0].id, b.id);
  assert.strictEqual(out.refused[0].detail.reason, 'not_shown');
  assert.strictEqual(statusOf(b.id), 'unverified');
});

// ---- C2 --------------------------------------------------------------------------------------------------------------------
const S = 'the pager sets DEFAULT_TIMEOUT_MS to 3000 milliseconds in every build we ship';
test('C2a: a saw embedded in a longer sentence of the writer\'s own prose is not exempt: a tool that printed it is an echo', () => {
  const f = `${dir}/c2a.jsonl`;
  fs.writeFileSync(f, toolLines(S));
  const quote = 'DEFAULT_TIMEOUT_MS to 3000 milliseconds';
  const embedded = CC.streamCite(f, quote, ['the pager timeout', `Editing the pager. ${S}`, S], 'the pager timeout', [S]);
  assert.strictEqual(embedded.found, false);
  assert.match(embedded.reason, /also shows the note's own text/);
  // Embedded in the middle of a field, not at its end, is no different.
  assert.strictEqual(CC.streamCite(f, quote, ['the pager timeout', `Editing the pager first. ${S} Then restart.`, S], 'the pager timeout', [S]).found, false);
  // A saw that appears in no other field is still exempt.
  assert.strictEqual(CC.streamCite(f, quote, ['the pager timeout', 'Editing the pager.', S], 'the pager timeout', [S]).found, true);
});

test('C2b: end to end, a false note whose saw is also embedded in its `when` cannot be confirmed by a tool that printed the saw; without the embedding it can', async () => {
  const stream = toolLines(S);
  const bad = await written('w-c2b1', 'K124', { stream, note: baseNote('K124', { when: `Editing the pager. ${S}`, evidence: [{ where: 'src/pager.cjs', saw: S }] }) });
  const r1 = await review('rev-c2b1', bad.task, [verdict(bad.note, 'confirmed', [cite('DEFAULT_TIMEOUT_MS to 3000 milliseconds')])]);
  const o1 = await call('memory.noteVerdicts', harness, { review_task_id: r1 });
  assert.deepStrictEqual([o1.applied.length, o1.refused[0] && o1.refused[0].code], [0, 'E_CITATION'], JSON.stringify(o1));
  assert.strictEqual(statusOf(bad.note), 'unverified');
  const ok = await written('w-c2b2', 'K125', { stream, note: baseNote('K125', { when: 'editing the pager timeout', evidence: [{ where: 'src/pager.cjs', saw: S }] }) });
  const r2 = await review('rev-c2b2', ok.task, [verdict(ok.note, 'confirmed', [cite('DEFAULT_TIMEOUT_MS to 3000 milliseconds')])]);
  const o2 = await call('memory.noteVerdicts', harness, { review_task_id: r2 });
  assert.strictEqual(o2.applied.length, 1, JSON.stringify(o2.refused));
});
