'use strict';
// report-env.cjs — shared scaffolding for the report and review tests: a real Engine on a sandbox store with a fake embedder, a real stream file per
// worker, a real git repository for file cites, and the helpers that drive the flow through real calls (a worker writes a note, another reports it
// wrong in `lease.release`, a review task hands back verdicts, belay applies them). Not a *.test.cjs file, so the runner does not execute it.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor, capturingCall } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

const DIM = 64;
const embed = async (text) => {
  const m = /\bK(\d+)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  v[m ? Number(m[1]) : DIM - 1] = 1;
  return { embedding: v, embedding_model: 'fake', embedding_revision: 'r', dim: DIM };
};

async function setup(RUN, levers = {}) {
  const env = {};
  const dir = sandbox(), repo = sandbox();
  fs.writeFileSync(`${repo}/loader.js`, "module.exports = function load() { return 'reads unlisted fixtures'; };\n");
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init');
  const head = git('rev-parse', 'HEAD').trim();
  const store = new Store(`${dir}/memory.db`, { stamp: true });
  // A deterministic seam on the embedder: while a stall is set, an embedding waits until the test releases it (preparation of a hand-back awaits it).
  const seam = { gate: null, reached: null };
  const stallingEmbed = async (text) => { if (seam.gate) { if (seam.reached) seam.reached(); await seam.gate; } return embed(text); };
  const E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed: stallingEmbed }), owner: null, establishedBy: 'test' });
  const stall = () => {
    let release, reached;
    seam.gate = new Promise((r) => { release = r; });
    const hit = new Promise((r) => { reached = r; });
    seam.reached = reached;
    return { reached: hit, release: () => { seam.gate = null; seam.reached = null; release(); } };
  };
  const orch = callerFor('orchestrator', { run_id: RUN });
  const harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
  const operator = callerFor('operator', { run_id: RUN });
  const worker = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
  const rawCall = (method, caller, args = {}) => E.handle(method, { caller, ...args });
  const call = capturingCall(rawCall, orch, harness); // a verdict call is preceded by the brief capture a run would have made
  const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
  const bodyOf = (id) => JSON.parse(rowOf(id).body);
  const events = (kind) => store.p('SELECT * FROM memory_event WHERE kind = ? ORDER BY seq').all(kind);
  let seq = 0, useSeq = 0;

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
  // Worker `w` worked a task and reported `noteId` wrong. Returns the task id (and, as `.out`, the release's answer).
  async function reported(w, noteId, why = 'the loader reads unlisted fixtures', extra = {}) {
    const s = await startTask(w, 'fixtures/unlisted.json was opened by the loader\n');
    const out = await call('lease.release', worker(w), { lease_id: s.lease, notes: [], reported_wrong: [{ id: noteId, why, ...extra }] });
    await call('task.evaluate', orch, { task_id: s.task, worktree: dir });
    reported.last = out;
    return s.task;
  }
  // The brief a reviewer of `taskId` would be shown: a throwaway review task over it.
  async function briefOf(taskId) {
    const t = await call('task.create', orch, { spec: `brief probe ${++seq}`, depends_on: [taskId], acceptance: { verdict: true } });
    return call('memory.reviewBrief', orch, { task_id: t.id });
  }
  // A review task over `taskId` assigned to reviewer `r`, released with `extra` in its result. `depends` may name several tasks.
  async function review(r, taskId, extra) {
    await call('worker.write', orch, { id: r, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${r}`, last_event_at: Date.now() });
    const t = await call('task.create', orch, { spec: `review ${++seq}`, depends_on: Array.isArray(taskId) ? taskId : [taskId], acceptance: { verdict: true } });
    const a = await call('task.assign', orch, { task_id: t.id, worker_id: r });
    await call('lease.release', worker(r), { lease_id: a.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', ...extra } });
    return t.id;
  }
  const cite = (quote, where = 'stream') => ({ where, quote });
  const rv = (id, v, cites, reason = 'what the stream shows', report) => ({ id, ...(report ? { report } : {}), verdict: v, cites, reason });
  const apply = (reviewTask) => call('memory.noteVerdicts', harness, { review_task_id: reviewTask });
  const heldRows = (id) => store.p("SELECT id, body FROM memory_entries WHERE type = 'held' AND json_extract(body, '$.note_id') = ? ORDER BY created_at, rowid").all(id).map((r) => ({ id: r.id, b: JSON.parse(r.body) }));
  const activeHold = (id) => heldRows(id).find((r) => r.b.state === 'held') || null;
  const heldCount = async () => (await call('memory.held', orch, {})).total;
  const UP = 'fixtures/unlisted.json was opened by the loader';

  Object.assign(env, { stall, E, store, dir, repo, head, RUN, orch, harness, operator, worker, rawCall, call, rowOf, bodyOf, events, note, startTask, written, reported, briefOf, review, cite, rv, apply, heldRows, activeHold, heldCount, UP, embed, cleanup: () => { store.close(); cleanup(dir); cleanup(repo); } });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true, ...levers }) });
  return env;
}

module.exports = { setup };
