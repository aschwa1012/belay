'use strict';
// note-review-k4.test.cjs — the run manager's side of a note's review:
//   K4-9  the run-close stages sweep before the scrub, and `belay run` hands them the sweep
//   K4-12 the reviewer's brief says which notes it shows in part
// (The short review job and its cases were removed.) A real engine on a sandbox store.

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { core: coreMod, sandbox, cleanup, callerFor, captureBrief } = require('../core/helpers.cjs');

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
const LV = { ...DEFAULTS, project: 'acme', notes: true };
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

const ctxFor = (m, extra = {}) => ({ core, runId: RUN, dataDir: dir, memoryLevers: LV, worktree: dir, manager: m, shutdownFlags: { closed: false }, ...extra });
const J = (ctx) => ({ ctx, core: ctx.core, lv: LV, w: null, gate: { aborted: false }, s: {}, turnPath: false });

before(async () => {
  dir = sandbox();
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  core = new Proxy({}, { get: (_, g) => (g === 'caller' ? harness : new Proxy({}, { get: (__, n) => (args) => call(`${g}.${n}`, harness, args || {}) })) });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
});
after(() => { store.close(); cleanup(dir); });

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

test('K4-9b: reviewSweep applies the hand-back of an ended review task and is the sweep belay run hands the stages', async () => {
  const w = await written('wr-k49');
  await call('worker.write', orch, { id: 'rv-k49', substrate: 'claude-code', pid: process.pid, state: 'running', session_id: 's', last_event_at: Date.now() });
  const rt = await call('task.create', orch, { spec: 'review', depends_on: [w.task.id], acceptance: { verdict: true } });
  const ra = await call('task.assign', orch, { task_id: rt.id, worker_id: 'rv-k49' });
  await call('lease.release', wcaller('rv-k49'), { lease_id: ra.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', memory_verdicts: JSON.parse(verdictsFor(w.notes)).memory_verdicts } });
  await captureBrief(call, orch, harness, { review_task_id: rt.id }); // the reviewer was launched with this brief
  assert.strictEqual(await NR.reviewSweep({ core, runId: RUN, levers: { ...LV, notes: false } }), null, 'notes off: nothing');
  const got = await NR.reviewSweep({ core, runId: RUN, levers: LV });
  assert.strictEqual(got.swept, true);
  assert.strictEqual(rowOf(w.notes[0]).status, 'verified', 'applied from the hand-back');
  const { runCloseStages } = require('../../src/cli/run-close-stages.cjs');
  let handed = null;
  const withHarness = new Proxy(core, { get: (t, p) => (p === 'harness' ? () => core : t[p]) });
  await runCloseStages({ core: withHarness, runId: RUN, levers: { memory_levers: LV }, dataDir: dir, stages: { closeStages: async (a) => { handed = a; return {}; } } });
  assert.strictEqual(typeof handed.sweep, 'function', 'belay run hands the stages the sweep');
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
