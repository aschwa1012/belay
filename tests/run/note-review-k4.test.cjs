'use strict';
// note-review-k4.test.cjs — the run manager's side of a note's review:
//   K4-6  the job's wait is asked again while MCP_TOOL_TIMEOUT caps it, and a timeout names the wall really used (waitJob)
//   K4-7  a job that refused a verdict or left a note unjudged writes a partial receipt, not an ok one, and names the notes it left
//   K4-8  the sweep names a task whose notes no review judged, once
//   K4-9  the run-close stages sweep before the scrub, and `belay run` hands them the sweep
//   K4-11 that sweep applies finished work only and writes no receipt, so a job whose row is not yet settled is applied by the run-end sweep
//   K4-12 the job is shown every field of every note, and the reviewer's brief says which notes it was shown in part
// A real engine on a sandbox store and a fake run manager; every ordering is forced by the test, never by a sleep.

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core: coreMod, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const { Store } = coreMod('store.cjs');
const { Engine } = coreMod('engine.cjs');
const NR = require('../../src/run/note-review.cjs');
const T = require('../../src/run/note-review-text.cjs');
const { closeStages } = require('../../src/run/close-stages.cjs');
const { DEFAULTS } = require('../../src/core/memory-levers.cjs');

let dir, store, E, core;
const RUN = 'r-k4run';
const orch = callerFor('orchestrator', { run_id: RUN });
const harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
const wcaller = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const receipts = (key) => store.p("SELECT * FROM memory_event WHERE kind = 'review_job' AND key = ? ORDER BY seq").all(key);
const LV = { ...DEFAULTS, project: 'acme', notes: true, note_review: true };
const STREAM_LINE = 'fixtures/unlisted.json was never opened';
let seq = 0, k = 0;

const DIM = 64;
const embed = async (text) => {
  const m = /\bK(\d+)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  v[m ? Number(m[1]) : DIM - 1] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};
const note = (marker) => ({ kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `add a ${marker} test fixture`, basis: 'observed', evidence: [{ where: `src/${marker}.js`, saw: 'never read' }], applies_to: ['fixtures'] });
const toolResult = (text) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: {} }] } })}\n${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: text }] } })}\n`;
const verdictsFor = (ids, quote = STREAM_LINE) => JSON.stringify({ memory_verdicts: ids.map((id) => ({ id, verdict: 'confirmed', cites: [{ where: 'stream', quote }], reason: 'the stream shows it' })) });

async function written(w, n = 1, make = note) {
  await call('worker.write', orch, { id: w, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${w}`, last_event_at: Date.now(), worktree: dir });
  const t = await call('task.create', orch, { spec: `k4 ${++seq}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: w });
  await call('worker.write', orch, { id: w, task_id: t.id });
  fs.mkdirSync(`${dir}/workers/${w}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${w}/stream.jsonl`, toolResult(STREAM_LINE));
  const out = await call('lease.release', wcaller(w), { lease_id: a.new_lease.id, notes: Array.from({ length: n }, () => make(`K${++k}`)), result: { summary: 'done' } });
  await call('task.evaluate', orch, { task_id: t.id, worktree: dir });
  return { task: { ...(await call('task.get', orch, { task_id: t.id })), state: 'released' }, notes: out.notes.map((x) => x.id), worker: w };
}

function fakeManager(answer, waits = null) {
  const m = { spawned: [], waited: [], flags: { closed: false, ownerGone: false }, recs: new Map() };
  m.spawn = async (a) => {
    m.spawned.push(a);
    await call('worker.write', orch, { id: a.worker_id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now(), worktree: a.worktree });
    m.recs.set(a.worker_id, { lastAssistantText: answer, costUsd: 0.01 });
    return {};
  };
  m.wait = async (a) => { m.waited.push(a.timeout_ms); return waits && waits.length ? waits.shift() : { event: 'turn_end', is_error: false, timed_out: false }; };
  m.stop = async () => {};
  m._worker = (id) => m.recs.get(id);
  m._closed = () => m.flags.closed;
  m._killSurvivor = async () => {};
  return m;
}
const ctxFor = (m, extra = {}) => ({ core, runId: RUN, dataDir: dir, memoryLevers: LV, worktree: dir, manager: m, shutdownFlags: m ? m.flags : { closed: false }, ...extra });
const J = (ctx) => ({ ctx, core: ctx.core, lv: LV, w: null, gate: { aborted: false }, s: {}, turnPath: false });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  core = new Proxy({}, { get: (_, g) => (g === 'caller' ? harness : new Proxy({}, { get: (__, n) => (args) => call(`${g}.${n}`, harness, args || {}) })) });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, note_review: true }) });
});
after(() => { store.close(); cleanup(dir); });

// ---- K4-6 (D46) ------------------------------------------------------------------------------------------------------------
test('K4-6: waitJob asks again while MCP_TOOL_TIMEOUT caps the wait, with the wall that is left; an uncapped timeout is final', async () => {
  let t = 0;
  const now = () => t;
  const asked = [];
  const answers = [{ timed_out: true, timeout_capped: { used_ms: 50000 } }, { timed_out: true, timeout_capped: { used_ms: 50000 } }, { event: 'turn_end', timed_out: false }];
  const manager = { wait: async (a) => { asked.push(a.timeout_ms); t += 50000; return answers.shift(); } };
  const r = await NR.waitJob(manager, 'notereview-x', 180000, now);
  assert.deepStrictEqual(asked, [180000, 130000, 80000]);
  assert.strictEqual(r.got.event, 'turn_end');
  assert.strictEqual(r.waited_ms, 150000);
  // Capped waits forever: it stops when the wall is spent, and says how long it really waited.
  t = 0; asked.length = 0;
  const forever = { wait: async (a) => { asked.push(a.timeout_ms); t += 110000; return { timed_out: true, timeout_capped: { used_ms: 110000 } }; } };
  const spent = await NR.waitJob(forever, 'notereview-x', 180000, now);
  assert.deepStrictEqual([asked, spent.got.timed_out, spent.waited_ms], [[180000, 70000], true, 220000]);
  // An uncapped timeout is the job's own and is not asked again.
  t = 0; asked.length = 0;
  const plain = { wait: async (a) => { asked.push(a.timeout_ms); t += 1000; return { timed_out: true }; } };
  await NR.waitJob(plain, 'notereview-x', 180000, now);
  assert.deepStrictEqual(asked, [180000]);
});

test('K4-6b: runJob survives a capped wait and finishes the job; a timeout receipt names the wall used, not the wall asked for', async () => {
  const w = await written('wr-k46');
  const m = fakeManager(verdictsFor(w.notes), [{ timed_out: true, timeout_capped: { used_ms: 1 } }]);
  await NR.onTaskEnded(J(ctxFor(m)), w.task);
  assert.strictEqual(m.waited.length, 2, 'the capped wait was asked again');
  assert.strictEqual(rowOf(w.notes[0]).status, 'verified');
  const ok = receipts(`task:${w.task.id}`)[0];
  assert.strictEqual(ok.ok, 1);
  const w2 = await written('wr-k46b');
  const m2 = fakeManager('', [{ timed_out: true }]);
  await NR.onTaskEnded(J(ctxFor(m2)), w2.task);
  const r = receipts(`task:${w2.task.id}`)[0];
  assert.deepStrictEqual([r.ok, r.code], [0, 'E_TIMEOUT']);
  const waited = /waited (\d+) ms of a 180000 ms wall/.exec(r.message);
  assert.ok(waited && Number(waited[1]) < 10000, r.message);
});

test('K4-6c: a timeout receipt names the wall really waited, exactly', async () => {
  const w = await written('wr-k46c');
  let clock = Date.now();
  const m = fakeManager('', []);
  m.wait = async (a) => { m.waited.push(a.timeout_ms); clock += 4321; return { timed_out: true }; };
  const clockSpy = mock.method(Date, 'now', () => clock);
  try { await NR.onTaskEnded(J(ctxFor(m)), w.task); } finally { clockSpy.mock.restore(); }
  const r = receipts(`task:${w.task.id}`)[0];
  assert.deepStrictEqual([r.ok, r.code], [0, 'E_TIMEOUT']);
  assert.match(r.message, /waited 4321 ms of a 180000 ms wall/);
});

// ---- K4-7 (D15) ------------------------------------------------------------------------------------------------------------
test('K4-7: a verdict refused for its cite makes the receipt partial, naming the note it left; a clean job is ok', async () => {
  const w = await written('wr-k47', 2);
  const m = fakeManager(JSON.stringify({ memory_verdicts: [
    { id: w.notes[0], verdict: 'confirmed', cites: [{ where: 'stream', quote: STREAM_LINE }], reason: 'shown' },
    { id: w.notes[1], verdict: 'confirmed', cites: [{ where: 'stream', quote: 'a line no tool ever printed' }], reason: 'invented' },
  ] }));
  await NR.onTaskEnded(J(ctxFor(m)), w.task);
  const r = receipts(`task:${w.task.id}`)[0];
  assert.deepStrictEqual([r.ok, r.code, JSON.parse(r.row_ids)], [0, 'E_PARTIAL', [w.notes[0]]]);
  assert.ok(r.message.includes(`left unreviewed: ${w.notes[1]}`), r.message);
  assert.strictEqual(rowOf(w.notes[1]).status ?? 'unverified', 'unverified');
  const clean = await written('wr-k47b', 2);
  await NR.onTaskEnded(J(ctxFor(fakeManager(verdictsFor(clean.notes)))), clean.task);
  const c = receipts(`task:${clean.task.id}`)[0];
  assert.deepStrictEqual([c.ok, c.code], [1, null]);
  assert.doesNotMatch(c.message, /partly/);
});

test('K4-7c: a report the job gave no verdict on also makes the receipt partial, and names the reported note', async () => {
  const a = await written('wr-k47c');
  await call('worker.write', orch, { id: 'wr-k47d', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's-d', last_event_at: Date.now(), worktree: dir });
  const t = await call('task.create', orch, { spec: `k4 report ${++seq}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const as = await call('task.assign', orch, { task_id: t.id, worker_id: 'wr-k47d' });
  await call('worker.write', orch, { id: 'wr-k47d', task_id: t.id });
  fs.mkdirSync(`${dir}/workers/wr-k47d`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/wr-k47d/stream.jsonl`, toolResult('the loader opened it'));
  await call('lease.release', wcaller('wr-k47d'), { lease_id: as.new_lease.id, notes: [], reported_wrong: [{ id: a.notes[0], why: 'the loader does open it' }], result: { summary: 'done' } });
  await call('task.evaluate', orch, { task_id: t.id, worktree: dir });
  const task = { ...(await call('task.get', orch, { task_id: t.id })), state: 'released' };
  await NR.onTaskEnded(J(ctxFor(fakeManager('{"memory_verdicts": [], "report_verdicts": []}'))), task);
  const r = receipts(`task:${t.id}`)[0];
  assert.deepStrictEqual([r.ok, r.code], [0, 'E_PARTIAL'], r.message);
  assert.ok(r.message.includes(`left unreviewed: ${a.notes[0]}`), r.message);
});

// ---- K4-8 (D15) ------------------------------------------------------------------------------------------------------------
const sweepNow = async () => NR.sweep(J(ctxFor(null)), (await call('task.list', orch, {})).tasks, (await call('worker.list', orch, {})).workers);

test('K4-8: the sweep names the notes written after a clean job, once, under their own key', async () => {
  const w = await written('wr-k48', 2);
  await core.memory.recordEvent({ kind: 'review_job', ok: true, key: `task:${w.task.id}`, task_id: w.task.id, message: 'applied 0, refused 0' }); // a job that judged what existed then
  await sweepNow();
  const left = receipts(`left:${w.task.id}`);
  assert.deepStrictEqual(left.map((r) => [r.ok, r.code, JSON.parse(r.row_ids).sort()]), [[0, 'E_PARTIAL', [...w.notes].sort()]]);
  assert.match(left[0].message, /written after its review job/);
  await sweepNow();
  assert.strictEqual(receipts(`left:${w.task.id}`).length, 1, 'a second sweep adds nothing');
  assert.strictEqual(receipts(`task:${w.task.id}`).length, 1);
});

test('K4-8b: the sweep names nothing for a task fully judged; a task with no receipt gets the owed receipt only, however often it runs', async () => {
  const done = await written('wr-k48b');
  await NR.onTaskEnded(J(ctxFor(fakeManager(verdictsFor(done.notes)))), done.task);
  const lost = await written('wr-k48c');
  await sweepNow();
  await sweepNow();
  assert.strictEqual(receipts(`left:${done.task.id}`).length, 0, 'every note was judged');
  assert.strictEqual(receipts(`left:${lost.task.id}`).length, 0, 'the owed receipt is its record, and the second sweep does not add to it');
  assert.deepStrictEqual(receipts(`task:${lost.task.id}`).map((r) => r.code), ['E_TIMEOUT']);
});

test('K4-8c: a partial job\'s receipt already names the notes it left, and a failed job\'s receipt is its own record: neither gets a second receipt', async () => {
  const partial = await written('wr-k48d', 2);
  await NR.onTaskEnded(J(ctxFor(fakeManager(verdictsFor([partial.notes[0]])))), partial.task);
  const p = receipts(`task:${partial.task.id}`);
  assert.deepStrictEqual([p.length, p[0].code], [1, 'E_PARTIAL']);
  assert.ok(p[0].message.includes(partial.notes[1]), p[0].message);
  const failed = await written('wr-k48e');
  await NR.onTaskEnded(J(ctxFor(fakeManager('', [{ timed_out: true }]))), failed.task);
  assert.deepStrictEqual(receipts(`task:${failed.task.id}`).map((r) => r.code), ['E_TIMEOUT']);
  await sweepNow();
  assert.strictEqual(receipts(`left:${partial.task.id}`).length, 0);
  assert.strictEqual(receipts(`left:${failed.task.id}`).length, 0);
  assert.strictEqual(rowOf(failed.notes[0]).status ?? 'unverified', 'unverified');
});

// ---- K4-9 (D45) ------------------------------------------------------------------------------------------------------------
test('K4-9: closeStages sweeps first, before the scrub reads the store; a fast close does not sweep; the sweep is optional', async () => {
  const log = [];
  const spy = new Proxy({}, { get: (_, g) => new Proxy({}, { get: (__, n) => async () => { log.push(`${g}.${n}`); return { items: [], notes: [], reports: [], pending: [], nominated: [], scope: { items: [] } }; } }) });
  const sweep = async () => { log.push('sweep'); return { swept: true }; };
  const lv = { ...LV };
  await closeStages({ core: spy, runId: RUN, levers: lv, dataDir: dir, review: false, sweep });
  assert.strictEqual(log[0], 'sweep');
  assert.ok(log.length > 1 && log.slice(1).every((x) => x !== 'sweep'), log.join(','));
  log.length = 0;
  await closeStages({ core: spy, runId: RUN, levers: lv, dataDir: dir, review: false, sweep, fast: () => true });
  assert.ok(!log.includes('sweep'), 'a fast close spawns and sweeps nothing');
  log.length = 0;
  const out = await closeStages({ core: spy, runId: RUN, levers: lv, dataDir: dir, review: false, sweep: async () => { throw new Error('boom'); } });
  assert.strictEqual(out.sweep.ran, false, 'a failed sweep is named and the stages still run');
  assert.ok(log.length > 0);
});

test('K4-9b: reviewSweep applies the answer of a finished job and is the sweep belay run hands the stages', async () => {
  const w = await written('wr-k49');
  const id = `notereview-${w.task.id}`;
  await call('worker.write', orch, { id, substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: 's', last_event_at: Date.now(), cost_usd: 0.01 });
  fs.mkdirSync(`${dir}/workers/${id}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${id}/stream.jsonl`, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: verdictsFor(w.notes) }] } })}\n`);
  assert.strictEqual(await NR.reviewSweep({ core, runId: RUN, levers: { ...LV, notes: false } }), null, 'notes off: nothing');
  const got = await NR.reviewSweep({ core, runId: RUN, levers: LV });
  assert.strictEqual(got.swept, true);
  assert.strictEqual(rowOf(w.notes[0]).status, 'verified', 'applied from the stream');
  const { runCloseStages } = require('../../src/cli/run-close-stages.cjs');
  let handed = null;
  const withHarness = new Proxy(core, { get: (t, p) => (p === 'harness' ? () => core : t[p]) });
  await runCloseStages({ core: withHarness, runId: RUN, levers: { memory_levers: LV }, dataDir: dir, stages: { closeStages: async (a) => { handed = a; return {}; } } });
  assert.strictEqual(typeof handed.sweep, 'function', 'belay run hands the stages the sweep');
});

// ---- K4-11 -----------------------------------------------------------------------------------------------------------------
test('K4-11: the sweep before the scrub writes no receipt for a job whose row is still idle, so the run-end sweep applies its answer once the row is dead', async () => {
  const w = await written('wr-k411');
  const id = `notereview-${w.task.id}`;
  await call('worker.write', orch, { id, substrate: 'claude-code', pid: process.pid, state: 'idle', session_id: 's', last_event_at: Date.now(), cost_usd: 0.01 });
  fs.mkdirSync(`${dir}/workers/${id}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${id}/stream.jsonl`, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: verdictsFor(w.notes) }] } })}\n`);
  await NR.reviewSweep({ core, runId: RUN, levers: LV });
  assert.deepStrictEqual(receipts(`task:${w.task.id}`), [], 'the pre-close sweep leaves the job alone');
  assert.strictEqual(rowOf(w.notes[0]).status ?? 'unverified', 'unverified');
  await call('worker.write', orch, { id, state: 'dead' }); // what run.end does to a killed job
  await sweepNow();
  assert.strictEqual(rowOf(w.notes[0]).status, 'verified', 'applied from its stream');
  assert.deepStrictEqual(receipts(`task:${w.task.id}`).map((r) => r.ok), [1]);
  // A task whose job never ran is owed a receipt only when the run ends, not by the sweep before the scrub.
  const lost = await written('wr-k411c');
  await NR.reviewSweep({ core, runId: RUN, levers: LV });
  assert.deepStrictEqual(receipts(`task:${lost.task.id}`), []);
  await sweepNow();
  assert.deepStrictEqual(receipts(`task:${lost.task.id}`).map((r) => r.code), ['E_TIMEOUT']);
  // The run-end sweep itself still names a job that is not settled: the receipt is its record.
  const late = await written('wr-k411b');
  await call('worker.write', orch, { id: `notereview-${late.task.id}`, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  await sweepNow();
  assert.deepStrictEqual(receipts(`task:${late.task.id}`).map((r) => r.code), ['E_SHUTDOWN']);
});

test('K4-11c: the sweep before the scrub applies the answer of a job whose process has closed but whose row still reads idle; anything less is left, with no receipt', async () => {
  const { spawnSync } = require('node:child_process');
  const gone = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid; // a process that has exited: its pid no longer answers
  assert.ok(Number.isInteger(gone));
  const idle = async (marker, { pid = gone, cost = 0.01, text = null } = {}) => {
    const w = await written(marker);
    const id = `notereview-${w.task.id}`;
    await call('worker.write', orch, { id, substrate: 'claude-code', pid, state: 'idle', session_id: 's', last_event_at: Date.now(), ...(cost === null ? {} : { cost_usd: cost }) });
    fs.mkdirSync(`${dir}/workers/${id}`, { recursive: true });
    fs.writeFileSync(`${dir}/workers/${id}/stream.jsonl`, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: text === null ? verdictsFor(w.notes) : text }] } })}
`);
    return w;
  };
  const done = await idle('wr-k411d');
  const alive = await idle('wr-k411e', { pid: process.pid });
  const free = await idle('wr-k411f', { cost: null });
  const half = await idle('wr-k411g', { text: 'I am still reading the diff' });
  await NR.reviewSweep({ core, runId: RUN, levers: LV });
  assert.strictEqual(rowOf(done.notes[0]).status, 'verified', 'a closed process with a whole answer is applied before the scrub');
  assert.deepStrictEqual(receipts(`task:${done.task.id}`).map((r) => r.ok), [1]);
  for (const w of [alive, free, half]) {
    assert.strictEqual(rowOf(w.notes[0]).status ?? 'unverified', 'unverified');
    assert.deepStrictEqual(receipts(`task:${w.task.id}`), [], 'no receipt, so the run-end sweep still decides');
  }
});

// ---- K4-12 -----------------------------------------------------------------------------------------------------------------
const fatNote = (marker) => ({ ...note(marker), evidence: [1, 2, 3, 4].map((i) => ({ where: `src/${marker}-${i}.js`, saw: `entry ${i} ${'q'.repeat(300)}` })) });

test('K4-12: the review job is given every field of every note: its notes file holds all four evidence entries and each whole saw', async () => {
  const w = await written('wr-k412', 1, fatNote);
  const m = fakeManager(verdictsFor(w.notes));
  await NR.onTaskEnded(J(ctxFor(m)), w.task);
  const given = JSON.parse(fs.readFileSync(`${dir}/workers/notereview-${w.task.id}/inputs/notes.json`, 'utf8'));
  assert.strictEqual(given[0].evidence.length, 4);
  assert.ok(given[0].evidence.every((e) => e.saw.length > 300 && !e.saw.includes('[cut')), 'no saw is cut');
  assert.strictEqual(rowOf(w.notes[0]).status, 'verified', 'the job route confirms a note it was shown whole');
});

test('K4-12b: the reviewer\'s brief says which notes it shows in part, and says nothing for a note shown whole', () => {
  const base = (id, over = {}) => ({ id, kind: 'lesson', basis: 'observed', task_id: 't1', written_by: 'w1', title: 'a title', when: 'a situation', text: 'a title', evidence: [{ where: 'a.js', saw: 'x' }], applies_to: [], subjects: [], ...over });
  const fat = base('n-fat', { evidence: [1, 2, 3, 4].map((i) => ({ where: `f${i}.js`, saw: 's' })) });
  const whole = base('n-whole');
  const long = base('n-derived', { text: 'z'.repeat(500) }); // a note with a when: its long text is derived from fields shown in full
  const tail = T.reviewerTail({ notes: [fat, whole, long], refuted_shown: [] }, []);
  const line = tail.split('\n').find((l) => l.startsWith('Shown in part'));
  assert.ok(line && line.includes('n-fat') && !line.includes('n-whole') && !line.includes('n-derived'), line);
  assert.doesNotMatch(T.reviewerTail({ notes: [whole, long], refuted_shown: [] }, []), /Shown in part/);
});
