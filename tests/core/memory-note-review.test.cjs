'use strict';
// memory-note-review.test.cjs — wave 4: a reviewer other than the writer judges each note, belay checks the citations and
// applies the verdict with a review: receipt. Real core against a sandbox store, a real stream file and a real git repo
// for the citations. Nothing here starts a model.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, repo, store, E, head;
const RUN = 'r-nrev';
const orch = callerFor('orchestrator', { run_id: RUN });
const harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
const worker = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const bodyOf = (id) => JSON.parse(rowOf(id).body);
const events = (kind) => store.p('SELECT * FROM memory_event WHERE kind = ? ORDER BY seq').all(kind);
let seq = 0;

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
let useSeq = 0;
// A tool call and its result, as the stream records them: the result only counts as evidence when its tool_use is there and is not belay's.
const toolResultLine = (text, name = 'Bash') => {
  const id = `tu${++useSeq}`;
  return `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } })}\n`;
};

// A worker `w` that worked a fresh task and handed back one note; the worker row carries a worktree and head commit,
// and its stream holds one tool result. Returns { task, note }.
async function written(w, marker, stream = 'loader.js read 3 files\nfixtures/unlisted.json was never opened\n') {
  await call('worker.write', orch, { id: w, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${w}`, last_event_at: Date.now(), worktree: repo, head_sha: head });
  const t = await call('task.create', orch, { spec: `job ${++seq}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: w });
  await call('worker.write', orch, { id: w, task_id: t.id });
  fs.mkdirSync(`${dir}/workers/${w}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${w}/stream.jsonl`, toolResultLine(stream));
  const out = await call('lease.release', worker(w), { lease_id: a.new_lease.id, notes: [note(marker)] });
  assert.strictEqual(out.notes[0].state, 'stored');
  await call('task.evaluate', orch, { task_id: t.id, worktree: dir });
  return { task: t.id, note: out.notes[0].id };
}

// A review task over `taskId`, assigned to reviewer `r`, released with `memory_verdicts`.
async function review(r, taskId, verdicts, extra = {}) {
  await call('worker.write', orch, { id: r, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${r}`, last_event_at: Date.now() });
  const t = await call('task.create', orch, { spec: `review ${++seq}`, depends_on: [taskId], acceptance: { verdict: true } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: r });
  await call('lease.release', worker(r), { lease_id: a.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', ...(verdicts === undefined ? {} : { memory_verdicts: verdicts }), ...extra } });
  return t.id;
}
const cite = (quote, where = 'stream') => ({ where, quote });
const verdict = (id, v, cites, reason = 'what the stream shows') => ({ id, verdict: v, cites, reason });
const apply = (reviewTask) => call('memory.noteVerdicts', harness, { review_task_id: reviewTask });

before(async () => {
  dir = sandbox();
  repo = sandbox();
  fs.writeFileSync(`${repo}/loader.js`, "module.exports = function load() { return 'skips unlisted fixtures'; };\n");
  fs.mkdirSync(`${repo}/pkg`);
  fs.writeFileSync(`${repo}/pkg/a-rather-long-file-name-for-listing.js`, 'x = 1;\n');
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init');
  head = git('rev-parse', 'HEAD').trim();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
});
after(() => { store.close(); cleanup(dir); cleanup(repo); });

test('R1: a confirmed verdict marks the note verified with a review: receipt, and the proof is the row', async () => {
  const w = await written('w-a', 'K1');
  const rt = await review('rev-a', w.task, [verdict(w.note, 'confirmed', [cite('fixtures/unlisted.json was never opened')])]);
  const out = await apply(rt);
  assert.strictEqual(out.applied.length, 1, JSON.stringify(out));
  assert.deepStrictEqual([out.applied[0].status, out.applied[0].previous_status, out.applied[0].status_receipt], ['verified', 'unverified', `review:${rt}`]);
  const row = rowOf(w.note);
  assert.deepStrictEqual([row.status, row.status_receipt, row.status_by], ['verified', `review:${rt}`, 'harness']);
  const b = bodyOf(w.note);
  assert.deepStrictEqual([b.review.verdict, b.review.by, b.review.ref], ['confirmed', 'rev-a', rt]);
  assert.strictEqual(b.review.cites[0].quote, 'fixtures/unlisted.json was never opened');
  const ev = events('note_review').find((e) => e.key.startsWith(`review:${rt}@`) && e.key.endsWith(`:${w.note}`));
  assert.deepStrictEqual([ev.ok, ev.task_id, ev.worker_id, ev.written_by], [1, w.task, 'rev-a', 'harness']);
});

test('R2: a refuted verdict marks the note refuted, writes the note_refuted receipt, and the index no longer lists it', async () => {
  const w = await written('w-b', 'K2');
  const before = await call('memory.index', orch, { max_bytes: 4096 });
  assert.ok(before.row_ids.includes(w.note), 'listed before the review');
  const rt = await review('rev-b', w.task, [verdict(w.note, 'refuted', [cite('fixtures/unlisted.json was never opened')], 'the stream shows it was opened later')]);
  const out = await apply(rt);
  assert.strictEqual(out.applied[0].status, 'refuted');
  assert.strictEqual(rowOf(w.note).status, 'refuted');
  assert.strictEqual(events('note_refuted').filter((e) => e.key === `refuted:${w.note}`).length, 1);
  const after = await call('memory.index', orch, { max_bytes: 4096 });
  assert.ok(!after.row_ids.includes(w.note), 'a refuted note never reaches a later run');
  assert.match(bodyOf(w.note).review.reason, /opened later/);
});

test('R3: a cite whose quote is not in the recorded evidence is E_CITATION; nothing changes', async () => {
  const w = await written('w-c', 'K3');
  const rt = await review('rev-c', w.task, [verdict(w.note, 'refuted', [cite('a line the worker never saw anywhere')])]);
  const out = await apply(rt);
  assert.deepStrictEqual([out.applied.length, out.refused[0].code, out.refused[0].id], [0, 'E_CITATION', w.note]);
  assert.strictEqual(rowOf(w.note).status ?? 'unverified', 'unverified');
  assert.ok(!('review' in bodyOf(w.note)));
  const ev = events('note_review').find((e) => e.key.startsWith(`review:${rt}@`) && e.key.endsWith(`:${w.note}`));
  assert.deepStrictEqual([ev.ok, ev.code], [0, 'E_CITATION']);
});

test('R4: a file cite is read at the worker\'s head commit; a path outside the repository or a missing file fails', async () => {
  const w = await written('w-d', 'K4');
  const ok = await review('rev-d1', w.task, [verdict(w.note, 'confirmed', [cite("return 'skips unlisted fixtures'", 'loader.js')])]);
  assert.strictEqual((await apply(ok)).applied.length, 1);
  const w2 = await written('w-d2', 'K5');
  for (const where of ['nope.js', '../etc/passwd', 'C:/Windows/win.ini']) {
    const rt = await review(`rev-d-${where.length}`, w2.task, [verdict(w2.note, 'confirmed', [cite("return 'skips unlisted fixtures'", where)])]);
    const out = await apply(rt);
    assert.strictEqual(out.refused[0].code, 'E_CITATION', where);
  }
  assert.strictEqual(rowOf(w2.note).status ?? 'unverified', 'unverified');
});

test('R5: a writer cannot review its own note, and neither can a worker that held a lease on the note\'s task', async () => {
  const w = await written('w-e', 'K6');
  // the writer reviews its own task's note through a review task it holds
  const t = await call('task.create', orch, { spec: 'self review', depends_on: [w.task], acceptance: { verdict: true } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: 'w-e' });
  await call('lease.release', worker('w-e'), { lease_id: a.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', memory_verdicts: [verdict(w.note, 'confirmed', [cite('fixtures/unlisted.json was never opened')])] } });
  const out = await apply(t.id);
  assert.deepStrictEqual([out.applied.length, out.refused[0].code, out.refused[0].detail.reason], [0, 'E_ROLE', 'independence']);
  assert.strictEqual(rowOf(w.note).status ?? 'unverified', 'unverified');
  // a job whose worker id equals the writer's lease holder is refused the same way
  await call('worker.write', orch, { id: `notereview-${w.task}`, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const j = await call('memory.noteVerdicts', harness, { job: { worker_id: `notereview-${w.task}`, reviewed_task_id: w.task }, verdicts: [verdict(w.note, 'confirmed', [cite('fixtures/unlisted.json was never opened')])] });
  assert.strictEqual(j.applied.length, 1, 'a different worker with no lease on the task may judge it');
});

test('R6: the orchestrator model cannot apply verdicts; only the harness channel can', async () => {
  const w = await written('w-f', 'K7');
  const rt = await review('rev-f', w.task, [verdict(w.note, 'confirmed', [cite('fixtures/unlisted.json was never opened')])]);
  await assert.rejects(call('memory.noteVerdicts', orch, { review_task_id: rt }), (e) => e.code === 'E_ROLE');
  await assert.rejects(call('memory.noteVerdicts', worker('rev-f'), { review_task_id: rt }), (e) => e.code === 'E_ROLE');
  assert.strictEqual(rowOf(w.note).status ?? 'unverified', 'unverified');
});

test('R7: setStatus refuses a review: receipt from anyone', async () => {
  const w = await written('w-g', 'K8');
  await assert.rejects(call('memory.setStatus', orch, { id: w.note, status: 'verified', receipt: 'review:anything' }), (e) => e.code === 'E_RECEIPT' && /only by belay/.test(e.message));
});

test('R7b: setStatus cannot make a note verified on a receipt the caller supplies, from the orchestrator or the operator', async () => {
  const w = await written('w-g2', 'K50');
  const operator = callerFor('operator', { run_id: RUN });
  for (const [who, receipt] of [[orch, 'test:claimed-pass'], [operator, 'test:claimed-pass'], [operator, `task:${w.task}`]]) {
    await assert.rejects(call('memory.setStatus', who, { id: w.note, status: 'verified', receipt }), (e) => e.code === 'E_RECEIPT' && e.detail && e.detail.reason === 'note_needs_review');
  }
  assert.ok(!rowOf(w.note).status || rowOf(w.note).status === 'unverified', 'the refused calls changed nothing');
  const refuted = await call('memory.setStatus', operator, { id: w.note, status: 'refuted', receipt: 'test:it-failed' });
  assert.strictEqual(refuted.status, 'refuted', 'refuting a note on the operator word stays open');
});

test('R8: scope and liveness: a note of another task, a pending note and an unknown id are refused by name', async () => {
  const w = await written('w-h', 'K9');
  const other = await written('w-h2', 'K10');
  const rt = await review('rev-h', w.task, [
    verdict(other.note, 'confirmed', [cite('fixtures/unlisted.json was never opened')]),
    verdict('no-such-note', 'confirmed', [cite('fixtures/unlisted.json was never opened')]),
    { id: w.note, verdict: 'maybe', cites: [], reason: 'x' },
  ]);
  const out = await apply(rt);
  assert.deepStrictEqual(out.refused.map((r) => r.code), ['E_ARGS', 'E_NOT_FOUND', 'E_ARGS']);
  assert.match(out.refused[0].message, /does not cover/);
  assert.deepStrictEqual(out.unjudged, [], 'a refused verdict is counted once, in refused, never also in unjudged');
  assert.deepStrictEqual(out.refused_open, [w.note], 'the refused note stays under review and is named for the next review');
  assert.ok(!rowOf(w.note).status || rowOf(w.note).status === 'unverified');
});

test('R8b: one note with a shape-refused verdict is refused 1 and unjudged 0, and a note given no verdict is still unjudged', async () => {
  const w = await written('w-h3', 'K9b');
  const bare = await apply(await review('rev-h3', w.task, [{ id: w.note, verdict: 'maybe', cites: [], reason: 'x' }]));
  assert.deepStrictEqual([bare.applied.length, bare.refused.length, bare.already.length, bare.unjudged.length], [0, 1, 0, 0]);
  const none = await apply(await review('rev-h4', w.task, []));
  assert.deepStrictEqual([none.refused.length, none.unjudged, none.refused_open], [0, [w.note], []]);
});

test('R9: applying the same review twice writes once', async () => {
  const w = await written('w-i', 'K11');
  const rt = await review('rev-i', w.task, [verdict(w.note, 'confirmed', [cite('fixtures/unlisted.json was never opened')])]);
  await apply(rt);
  const again = await apply(rt);
  assert.deepStrictEqual([again.applied.length, again.already.length], [0, 1]);
  assert.strictEqual(events('note_review').filter((e) => e.key.startsWith(`review:${rt}@`) && e.key.endsWith(`:${w.note}`)).length, 1);
});

test('R10: a refuted note stays refuted: a later confirmed verdict is refused', async () => {
  const w = await written('w-j', 'K12');
  await apply(await review('rev-j1', w.task, [verdict(w.note, 'refuted', [cite('fixtures/unlisted.json was never opened')])]));
  const out = await apply(await review('rev-j2', w.task, [verdict(w.note, 'confirmed', [cite('fixtures/unlisted.json was never opened')])]));
  assert.strictEqual(out.refused[0].code, 'E_ARGS');
  assert.strictEqual(rowOf(w.note).status, 'refuted');
});

test('R11: a hand-back with no memory_verdicts judges nothing and says so', async () => {
  const w = await written('w-k', 'K13');
  const out = await apply(await review('rev-k', w.task, undefined));
  assert.deepStrictEqual([out.no_verdicts, out.applied.length, out.unjudged], [true, 0, [w.note]]);
});

test('R12: reviewBrief names the notes a review task should judge, and nothing for a task that is not a review', async () => {
  const w = await written('w-l', 'K14');
  const t = await call('task.create', orch, { spec: 'a review', depends_on: [w.task], acceptance: { verdict: true } });
  const b = await call('memory.reviewBrief', orch, { task_id: t.id });
  assert.deepStrictEqual([b.review, b.notes.map((n) => n.id)], [true, [w.note]]);
  assert.strictEqual(b.notes[0].evidence[0].saw, 'the unlisted file was never read');
  const plain = await call('task.create', orch, { spec: 'plain', depends_on: [w.task] });
  assert.deepStrictEqual((await call('memory.reviewBrief', orch, { task_id: plain.id })).notes, []);
});

test('R13: the job route needs a notereview- worker row belay spawned', async () => {
  const w = await written('w-m', 'K15');
  const v = [verdict(w.note, 'confirmed', [cite('fixtures/unlisted.json was never opened')])];
  await assert.rejects(call('memory.noteVerdicts', harness, { job: { worker_id: `notereview-${w.task}`, reviewed_task_id: w.task }, verdicts: v }), (e) => e.code === 'E_NOT_FOUND');
  await assert.rejects(call('memory.noteVerdicts', harness, { job: { worker_id: 'w-m', reviewed_task_id: w.task }, verdicts: v }), (e) => e.code === 'E_ARGS');
});

test('R14: noteRefutation lists who was shown the note (running or finished, cited or not) and the notes they wrote', async () => {
  const w = await written('w-n', 'K20');
  // two later workers were handed the note in their first-message index; one finished and cited it, one is still running
  const mk = async (id, finish) => {
    await call('worker.write', orch, { id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now() });
    const t = await call('task.create', orch, { spec: `later ${id}` });
    const a = await call('task.assign', orch, { task_id: t.id, worker_id: id });
    await call('worker.write', orch, { id, task_id: t.id });
    await call('memory.recordEvent', harness, { kind: 'index_injected', ok: true, worker_id: id, task_id: t.id, row_ids: [w.note], bytes: 10, sha256: 'x' });
    if (finish) await call('lease.release', worker(id), { lease_id: a.new_lease.id, notes: [note('K21')], result: { summary: 'done', memory_ids: [w.note] } });
    return t.id;
  };
  const fin = await mk('user-fin', true);
  const run = await mk('user-run', false);
  const rt = await review('rev-n', w.task, [verdict(w.note, 'refuted', [cite('fixtures/unlisted.json was never opened')], 'the file is opened by the second pass')]);
  await apply(rt);
  const r = await call('memory.noteRefutation', harness, { note_id: w.note });
  assert.strictEqual(r.note.status, 'refuted');
  assert.deepStrictEqual([r.review.reason, r.review.by, r.review.cites[0].where], ['the file is opened by the second pass', 'rev-n', 'stream']);
  const by = Object.fromEntries(r.shown.map((s) => [s.task_id, s]));
  assert.deepStrictEqual([by[fin].state, by[fin].cited, by[fin].via], ['finished', true, 'index_injected']);
  assert.deepStrictEqual([by[run].state, by[run].cited], ['running', null]);
  assert.strictEqual(r.notes_written_by_shown.length, 1, 'the note the finished worker wrote');
  assert.strictEqual(r.notes_written_by_shown[0].task_id, fin);
  await assert.rejects(call('memory.noteRefutation', harness, { note_id: 'nope' }), (e) => e.code === 'E_NOT_FOUND');
});

test('R15: reviewBrief names a refuted note a reviewed task\'s worker was shown, before the review starts', async () => {
  const bad = await written('w-o', 'K22');
  await apply(await review('rev-o1', bad.task, [verdict(bad.note, 'refuted', [cite('fixtures/unlisted.json was never opened')], 'wrong about the loader')]));
  const victim = await written('w-o2', 'K23');
  await call('memory.recordEvent', harness, { kind: 'index_injected', ok: true, worker_id: 'w-o2', task_id: victim.task, row_ids: [bad.note], bytes: 10, sha256: 'y' });
  const t = await call('task.create', orch, { spec: 'review of victim', depends_on: [victim.task], acceptance: { verdict: true } });
  const b = await call('memory.reviewBrief', orch, { task_id: t.id });
  assert.deepStrictEqual(b.refuted_shown.map((x) => [x.note_id, x.task_id, x.worker_id, x.reason]), [[bad.note, victim.task, 'w-o2', 'wrong about the loader']]);
});

test('R16 (review B-1): a note cannot be confirmed by quoting itself: belay tool results and the note\'s own title or evidence are not evidence', async () => {
  const title = 'the K40 loader skips unlisted fixtures';
  const w = await written('w-p', 'K40', 'loader.js read 3 files in the fixtures dir\n');
  // what the adapter hands the worker as the lease_release result echoes the note's title; a search result echoes notes too
  fs.appendFileSync(`${dir}/workers/w-p/stream.jsonl`, toolResultLine(JSON.stringify({ notes: [{ title }] }), 'mcp__belay__lease_release'));
  fs.appendFileSync(`${dir}/workers/w-p/stream.jsonl`, toolResultLine(`grep hit: ${title} (from a file)`));
  const only = async (quote, where = 'stream') => {
    const rt = await review(`rev-p${++seq}`, w.task, [verdict(w.note, 'confirmed', [cite(quote, where)])]);
    return apply(rt);
  };
  const viaBelay = await only(title);
  assert.strictEqual(viaBelay.refused[0].code, 'E_CITATION');
  const viaHit = await only('grep hit: the K40 loader skips unlisted fixtures (from a file)');
  assert.strictEqual(viaHit.refused[0].code, 'E_CITATION', 'a quote that contains the note\'s title is the note quoting itself');
  const sub = await only('loader skips unlisted fixtures');
  assert.strictEqual(sub.refused[0].code, 'E_CITATION', 'a fragment of the title is too');
  const saw = await only('the unlisted file was never read');
  assert.strictEqual(saw.refused[0].code, 'E_CITATION', 'and so is what the note says it saw');
  assert.strictEqual(rowOf(w.note).status ?? 'unverified', 'unverified');
  const real = await only('loader.js read 3 files in the fixtures dir');
  assert.strictEqual(real.applied.length, 1, 'a line the world answered is still evidence');
});

test('R17 (review B-2): a confirm whose check was in flight when a refute landed is refused; a refuted note is never verified again', async () => {
  const w = await written('w-q', 'K41');
  await call('worker.write', orch, { id: `notereview-${w.task}`, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-job', last_event_at: Date.now() });
  const CC = core('memory-citations.cjs');
  CC.seam.afterCheck = async () => {
    CC.seam.afterCheck = null;
    const rt = await review('rev-q', w.task, [verdict(w.note, 'refuted', [cite('fixtures/unlisted.json was never opened')])]);
    assert.strictEqual((await apply(rt)).applied[0].status, 'refuted');
  };
  try {
    const c = await call('memory.noteVerdicts', harness, { job: { worker_id: `notereview-${w.task}`, reviewed_task_id: w.task }, verdicts: [verdict(w.note, 'confirmed', [cite("return 'skips unlisted fixtures'", 'loader.js')])] });
    assert.deepStrictEqual([c.applied.length, c.refused[0].code], [0, 'E_ARGS']);
    assert.match(c.refused[0].message, /refuted while this verdict was being checked/);
  } finally { CC.seam.afterCheck = null; }
  assert.strictEqual(rowOf(w.note).status, 'refuted');
  assert.match(rowOf(w.note).status_receipt, /^review:rev-q|^review:[0-9a-f-]{36}$/);
});

test('R19 (review S-A, X4): an observed note is confirmed by the file line that holds its own evidence text; the same words are refused from a stream no tool printed them in', async () => {
  const line = "return 'skips unlisted fixtures'";
  const w = await written('w-s', 'K43', 'a tool printed something else\n');
  store.patchBody(w.note, (b) => { b.evidence = [{ where: 'loader.js', saw: line }]; return b; });
  const stream = await review('rev-s1', w.task, [verdict(w.note, 'confirmed', [cite(line)])]);
  assert.strictEqual((await apply(stream)).refused[0].code, 'E_CITATION', 'a stream cite of the note\'s own evidence text proves nothing');
  const file = await review('rev-s2', w.task, [verdict(w.note, 'confirmed', [cite(line, 'loader.js')])]);
  const out = await apply(file);
  assert.deepStrictEqual([out.applied.length, rowOf(w.note).status], [1, 'verified'], JSON.stringify(out.refused));
});

test('R20: a quote not in the evidence, "./" and a directory are refused before anything is read', async () => {
  const w = await written('w-t', 'K44');
  for (const c of [cite('too short a quote'), cite('fixtures/unlisted.json was never opened', './'), cite('fixtures/unlisted.json was never opened', 'src/')]) {
    const out = await apply(await review(`rev-t${++seq}`, w.task, [verdict(w.note, 'confirmed', [c])]));
    assert.strictEqual(out.applied.length, 0);
    assert.ok(['E_ARGS', 'E_CITATION'].includes(out.refused[0].code), out.refused[0].code);
  }
  assert.strictEqual(rowOf(w.note).status ?? 'unverified', 'unverified');
});

test('R21 (review S-B, X5): a cite naming a directory is E_CITATION in both citation paths; a file name from a listing is not citable', async () => {
  const name = 'a-rather-long-file-name-for-listing.js';
  const w = await written('w-u', 'K45');
  for (const where of ['pkg', 'pkg/']) {
    const out = await apply(await review(`rev-u${++seq}`, w.task, [verdict(w.note, 'confirmed', [cite(name, where)])]));
    assert.strictEqual(out.refused[0].code, 'E_CITATION', where);
  }
  const out = await apply(await review(`rev-u${++seq}`, w.task, [verdict(w.note, 'confirmed', [cite(name, 'pkg')])]));
  assert.match(out.refused[0].message, /tree, not a file|path to a file/);
  assert.strictEqual(rowOf(w.note).status ?? 'unverified', 'unverified');
  // the scrub/review-apply path (checkCitations) refuses it too
  const MC = core('memory-citations.cjs');
  await assert.rejects(MC.checkCitations([{ where: 'pkg', quote: name }], { head_sha: head, worktree: repo }), (e) => e.code === 'E_CITATION' && /tree, not a file/.test(e.message));
  const ok = await MC.checkCitations([{ where: 'pkg/' + name, quote: 'x = 1;' }], { head_sha: head, worktree: repo });
  assert.strictEqual(ok[0].source.startsWith('pkg/'), true);
});

test('R22: a reported_wrong on a note that is no longer live is skipped and returned; the rest of the release goes ahead', async () => {
  const w = await written('w-v', 'K46');
  store.moveRow(w.note, 'project/acme', 'archive/acme');
  await call('worker.write', orch, { id: 'w-v2', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const t = await call('task.create', orch, { spec: `job ${++seq}` });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: 'w-v2' });
  const out = await call('lease.release', worker('w-v2'), { lease_id: a.new_lease.id, notes: [note('K47')], reported_wrong: [{ id: w.note, why: 'it is stale' }, { id: 'no-such-note', why: 'x' }] });
  assert.strictEqual(out.notes[0].state, 'stored', 'the release and its note went through');
  assert.deepStrictEqual(out.reported_wrong, [{ id: w.note, skipped: 'not_live', state: 'archive' }, { id: 'no-such-note', skipped: 'not_live', state: 'missing' }]);
  assert.strictEqual((await call('task.get', orch, { task_id: t.id })).state, 'released');
});

test('R18: the job route needs the review job\'s own id for the task', async () => {
  const w = await written('w-r', 'K42');
  await assert.rejects(call('memory.noteVerdicts', harness, { job: { worker_id: 'notereview-someone-else', reviewed_task_id: w.task }, verdicts: [] }), (e) => e.code === 'E_ARGS' && /not the review job of task/.test(e.message));
});

test('R20b: a short whole-line quote that is really there is accepted; empty, whitespace and over-long quotes are refused', async () => {
  const w = await written('w-sq', 'K46', 'done.\nbackup        59m59s\nloader.js read 3 files\n');
  for (const c of [cite(''), cite('   '), cite('x'.repeat(2001))]) {
    const out = await apply(await review(`rev-sq${++seq}`, w.task, [verdict(w.note, 'confirmed', [c])]));
    assert.strictEqual(out.applied.length, 0);
    assert.strictEqual(out.refused[0].code, 'E_ARGS', JSON.stringify(c.quote.slice(0, 5)));
  }
  const absent = await apply(await review(`rev-sq${++seq}`, w.task, [verdict(w.note, 'confirmed', [cite('nope()')])]));
  assert.strictEqual(absent.refused[0].code, 'E_CITATION');
  assert.strictEqual(rowOf(w.note).status ?? 'unverified', 'unverified');
  const ok = await apply(await review(`rev-sq${++seq}`, w.task, [verdict(w.note, 'confirmed', [cite('backup        59m59s'), cite('done.')])]));
  assert.deepStrictEqual([ok.applied.length, rowOf(w.note).status], [1, 'verified'], JSON.stringify(ok.refused));
});
