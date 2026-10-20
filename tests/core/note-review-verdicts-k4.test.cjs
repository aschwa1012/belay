'use strict';
// note-review-verdicts-k4.test.cjs — the verdict core of a note's review, against a real Engine and a real git repository:
//   K4-1  a file cite is read from the working tree of a worker that has not committed (workers do not commit; the head is recorded at settle)
//   K4-2  `confirmed` is refused for a note the reviewer was shown in part; `refuted` and the job route (which shows every field) are not
//   K4-3  a quote under six non-space characters must be a whole line
//   K4-4  a note that copied a printed line into its saw does not make that line an echo; a result that shows the title still is one
//   K4-5  a Codex worker's stream is evidence: command output and a non-belay MCP result count, prose and belay's own tools do not

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');
const CC = require('../../src/core/memory-citations.cjs');
const { hiddenParts } = require('../../src/core/note-shown.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, repo, store, E, head;
const RUN = 'r-k4';
const orch = callerFor('orchestrator', { run_id: RUN });
const harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
const worker = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const statusOf = (id) => rowOf(id).status ?? 'unverified';
let seq = 0, useSeq = 0;

const DIM = 64;
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
const item = (it) => `${JSON.stringify({ type: 'item.completed', item: it })}\n`;

// A worker `w` that worked a fresh task and handed back `note`; `stream` is its stream file's content. `withHead` false leaves head_sha unset,
// as it is while the worker lives. Returns { task, note }.
async function written(w, marker, { stream, note = baseNote(marker), withHead = true, substrate = 'claude-code' } = {}) {
  await call('worker.write', orch, { id: w, substrate, pid: process.pid, state: 'running', session_id: `s-${w}`, last_event_at: Date.now(), worktree: repo, ...(withHead ? { head_sha: head } : {}) });
  const t = await call('task.create', orch, { spec: `job ${++seq}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: w });
  await call('worker.write', orch, { id: w, task_id: t.id });
  fs.mkdirSync(`${dir}/workers/${w}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${w}/stream.jsonl`, stream === undefined ? toolLines('loader.js read 3 files\nfixtures/unlisted.json was never opened\n') : stream);
  const out = await call('lease.release', worker(w), { lease_id: a.new_lease.id, notes: [note] });
  assert.strictEqual(out.notes[0].state, 'stored', JSON.stringify(out.notes[0]));
  await call('task.evaluate', orch, { task_id: t.id, worktree: dir });
  return { task: t.id, note: out.notes[0].id };
}
async function review(r, taskId, verdicts) {
  await call('worker.write', orch, { id: r, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${r}`, last_event_at: Date.now() });
  const t = await call('task.create', orch, { spec: `review ${++seq}`, depends_on: [taskId], acceptance: { verdict: true } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: r });
  await call('lease.release', worker(r), { lease_id: a.new_lease.id, notes: [], result: { verdict: 'holds', summary: 'ok', memory_verdicts: verdicts } });
  return t.id;
}
const apply = (reviewTask) => call('memory.noteVerdicts', harness, { review_task_id: reviewTask });
const verdict = (id, v, cites, reason = 'what the evidence shows') => ({ id, verdict: v, cites, reason });
const cite = (quote, where = 'stream') => ({ where, quote });
const run1 = async (w, v, cites) => apply(await review(`rev-k4-${++seq}`, w.task, [verdict(w.note, v, cites)]));

before(async () => {
  dir = sandbox();
  repo = sandbox();
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(`${repo}/loader.js`, "module.exports = function load() { return 'skips unlisted fixtures'; };\n");
  fs.writeFileSync(`${repo}/.gitignore`, 'secret.env\n');
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init');
  head = git('rev-parse', 'HEAD').trim();
  // Work the writer has not committed: a new file, an edit to a tracked one, and an ignored file.
  fs.writeFileSync(`${repo}/fresh.js`, 'const PAGER_RETRIES = 7; // set by this task\n');
  fs.writeFileSync(`${repo}/loader.js`, "module.exports = function load() { return 'skips unlisted fixtures, now with a manifest'; };\n");
  fs.writeFileSync(`${repo}/secret.env`, 'API_TOKEN=hunter2-hunter2\n');
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
});
after(() => { store.close(); cleanup(dir); cleanup(repo); });

// ---- K4-1 (D12) ------------------------------------------------------------------------------------------------------------
test('K4-1: a file cite is checked in the working tree while the writer has no head commit; ignored files, .git and misses are refused', async () => {
  const w = await written('w-k41', 'K1', { withHead: false });
  const row = (await call('worker.get', orch, { worker_id: 'w-k41' })).worker || (await call('worker.get', orch, { worker_id: 'w-k41' }));
  assert.ok(!row.head_sha, 'the writer is live: no head commit is recorded');
  const none = await run1(w, 'confirmed', [cite('now with a manifest', 'loader.js')]);
  assert.strictEqual(none.applied.length, 1, JSON.stringify(none.refused));
  assert.strictEqual(statusOf(w.note), 'verified');
  // Untracked, not ignored: citable. Ignored: not (a secret is no oracle). Inside .git: not. A line that is not there: not.
  const w2 = await written('w-k41b', 'K2', { withHead: false });
  const untracked = await run1(w2, 'confirmed', [cite('const PAGER_RETRIES = 7;', 'fresh.js')]);
  assert.strictEqual(untracked.applied.length, 1, JSON.stringify(untracked.refused));
  for (const [where, quote] of [['secret.env', 'API_TOKEN=hunter2-hunter2'], ['.git/config', 'repositoryformatversion'], ['fresh.js', 'const PAGER_RETRIES = 99;']]) {
    const w3 = await written(`w-k41-${++seq}`, `K${40 + seq}`, { withHead: false });
    const out = await run1(w3, 'confirmed', [cite(quote, where)]);
    assert.deepStrictEqual([out.applied.length, out.refused[0] && out.refused[0].code], [0, 'E_CITATION'], where);
    assert.strictEqual(statusOf(w3.note), 'unverified');
  }
});

test('K4-1b: with a head commit the committed file still answers, and a path outside the repository is still refused', async () => {
  const w = await written('w-k41c', 'K3');
  const ok = await run1(w, 'confirmed', [cite("return 'skips unlisted fixtures'", 'loader.js')]);
  assert.strictEqual(ok.applied.length, 1, JSON.stringify(ok.refused));
  const w2 = await written('w-k41d', 'K4');
  const out = await run1(w2, 'confirmed', [cite('x', '../outside.js')]);
  assert.strictEqual(out.applied.length, 0);
});

// ---- K4-2 (D13) ------------------------------------------------------------------------------------------------------------
test('K4-2: hiddenParts names what a capped brief hides, and nothing for a note shown whole', () => {
  assert.deepStrictEqual(hiddenParts({ text: 'short', evidence: [{ where: 'a', saw: 'b' }] }), []);
  assert.strictEqual(hiddenParts({ text: 'x'.repeat(401), evidence: [] }).length, 1);
  assert.strictEqual(hiddenParts({ text: 'x'.repeat(400), evidence: [{ where: 'a', saw: 'y'.repeat(201) }] }).length, 1);
  assert.strictEqual(hiddenParts({ text: 'x', evidence: [1, 2, 3, 4].map((i) => ({ where: `w${i}`, saw: 's' })) }).length, 1);
});

test('K4-2b: a review task cannot confirm a note whose later evidence it was not shown, but can refute it; the job route confirms it whole', async () => {
  const fat = baseNote('K5', { evidence: [1, 2, 3, 4].map((i) => ({ where: `src/part-${i}.js`, saw: `entry ${i} of the loader evidence` })) });
  const w = await written('w-k42', 'K5', { note: fat });
  const out = await run1(w, 'confirmed', [cite('fixtures/unlisted.json was never opened')]);
  assert.deepStrictEqual([out.applied.length, out.refused[0].code, out.refused[0].detail.reason], [0, 'E_ARGS', 'hidden_fields']);
  assert.strictEqual(statusOf(w.note), 'unverified');
  assert.deepStrictEqual(out.refused_open, [w.note], 'it stays under review');
  const refuted = await run1(w, 'refuted', [cite('fixtures/unlisted.json was never opened')]);
  assert.strictEqual(refuted.applied.length, 1, JSON.stringify(refuted.refused));
  assert.strictEqual(statusOf(w.note), 'refuted');
  // The job route: the worker row is belay's, and the run shows the job every field.
  const w2 = await written('w-k42b', 'K6', { note: baseNote('K6', { evidence: [1, 2, 3, 4].map((i) => ({ where: `src/part-${i}.js`, saw: `entry ${i} of the loader evidence` })) }) });
  await call('worker.write', orch, { id: `notereview-${w2.task}`, substrate: 'claude-code', pid: process.pid, state: 'stopped', session_id: 's-job', last_event_at: Date.now() });
  const job = await call('memory.noteVerdicts', harness, { job: { worker_id: `notereview-${w2.task}`, reviewed_task_id: w2.task }, verdicts: [verdict(w2.note, 'confirmed', [cite('fixtures/unlisted.json was never opened')])] });
  assert.strictEqual(job.applied.length, 1, JSON.stringify(job.refused));
  assert.strictEqual(statusOf(w2.note), 'verified');
});

// ---- K4-3 (D49) ------------------------------------------------------------------------------------------------------------
test('K4-3: a one-character quote is refused in a stream and a file; a short whole line and a six-character span are accepted', async () => {
  const stream = toolLines('done.\nbackup        59m59s\nloader.js read 3 files\n');
  const w = await written('w-k43', 'K7', { stream });
  for (const [quote, where] of [['e', 'stream'], ['ad', 'stream'], ['e', 'loader.js']]) {
    const out = await run1(w, 'confirmed', [cite(quote, where)]);
    assert.deepStrictEqual([out.applied.length, out.refused[0].code], [0, 'E_CITATION'], `${where}:${quote}`);
  }
  assert.strictEqual(statusOf(w.note), 'unverified');
  // The boundary: five non-space characters of a line are a fragment, six are a span.
  const frag = await run1(w, 'confirmed', [cite('backu')]);
  assert.deepStrictEqual([frag.applied.length, frag.refused[0].code], [0, 'E_CITATION']);
  const ok = await run1(w, 'confirmed', [cite('done.'), cite('backup 59m')]);
  assert.strictEqual(ok.applied.length, 1, JSON.stringify(ok.refused));
  const six = await written('w-k43b', 'K11', { stream });
  assert.strictEqual((await run1(six, 'confirmed', [cite('backup')])).applied.length, 1, 'six non-space characters are a span');
});

// ---- K4-4 (D52) ------------------------------------------------------------------------------------------------------------
const LINE = 'const DEFAULT_TIMEOUT_MS = 30000; // the pager gives up after thirty seconds';
const readResult = `    40→'use strict';\n    41→${LINE}\n    42→const RETRIES = 3;\n`;

test('K4-4: a faithful long saw does not make its own source line uncitable: confirm and refute both work on the value span', async () => {
  assert.ok(LINE.length >= 60);
  const stream = toolLines(readResult, 'Read');
  const good = await written('w-k44', 'K8', { stream, note: baseNote('K8', { title: 'the pager timeout is thirty seconds', evidence: [{ where: 'src/pager.cjs', saw: LINE }] }) });
  const c = await run1(good, 'confirmed', [cite('const DEFAULT_TIMEOUT_MS = 30000;')]);
  assert.strictEqual(c.applied.length, 1, JSON.stringify(c.refused));
  const bad = await written('w-k44b', 'K9', { stream, note: baseNote('K9', { title: 'the pager timeout is three thousand milliseconds', evidence: [{ where: 'src/pager.cjs', saw: LINE }] }) });
  const r = await run1(bad, 'refuted', [cite('const DEFAULT_TIMEOUT_MS = 30000;')]);
  assert.strictEqual(r.applied.length, 1, JSON.stringify(r.refused));
  assert.strictEqual(statusOf(bad.note), 'refuted');
});

test('K4-4b: a result that lists the note\'s title, or holds a different own sentence beside the quote, is still an echo, with its own reason', () => {
  const T = 'the pager timeout is thirty seconds in every environment we ship';
  const own = [T, LINE];
  const file = (name, text) => { const f = `${dir}/${name}.jsonl`; fs.writeFileSync(f, toolLines(text)); return f; };
  const listing = CC.streamCite(file('l1', `- note [lesson] ${T}\n${LINE}`), 'const DEFAULT_TIMEOUT_MS = 30000;', own, T);
  assert.strictEqual(listing.found, false);
  assert.match(listing.reason, /also shows the note's own text/);
  assert.doesNotMatch(listing.reason, /^the quote is the note's own text, which cannot/);
  const other = 'the second long sentence of the note that a worker printed on another line of the same output';
  const beside = CC.streamCite(file('l2', `${LINE}\n${other}`), 'const DEFAULT_TIMEOUT_MS = 30000;', [T, LINE, other], T);
  assert.strictEqual(beside.found, false, 'a different own sentence in the result keeps the result an echo');
  assert.strictEqual(CC.streamCite(file('l3', `${LINE}\nconst RETRIES = 3;`), 'const DEFAULT_TIMEOUT_MS = 30000;', own, T).found, true);
  const none = CC.streamCite(file('l4', 'nothing relevant'), 'const DEFAULT_TIMEOUT_MS = 30000;', own, T);
  assert.match(none.reason, /note's own text, which cannot be evidence/, 'a quote no tool result holds keeps the old reason');
});

// ---- K4-5 (D54) ------------------------------------------------------------------------------------------------------------
test('K4-5: a Codex stream is evidence: command output and a non-belay MCP result count; prose, belay\'s tools and an unnamed server do not', async () => {
  const stream = [
    item({ id: 'i0', type: 'agent_message', text: 'the manifest lists mb_1021 and mb_1022 both' }),
    item({ id: 'i1', type: 'command_execution', command: 'cat manifest.json', aggregated_output: 'manifest lists mb_2044 for sam.reed\n', exit_code: 0, status: 'completed' }),
    item({ id: 'i2', type: 'mcp_tool_call', server: 'docs', tool: 'search', result: { content: [{ type: 'text', text: 'the docs page says retries default to 5' }] }, status: 'completed' }),
    item({ id: 'i3', type: 'mcp_tool_call', server: 'belay', tool: 'memory_search', result: { content: [{ type: 'text', text: 'belay says mb_9999 exists' }] }, status: 'completed' }),
    item({ id: 'i4', type: 'mcp_tool_call', tool: 'mystery', result: 'an unnamed server said mb_7777 exists', status: 'completed' }),
  ].join('');
  const w = await written('w-k45', 'K10', { stream, substrate: 'codex' });
  for (const quote of ['the manifest lists mb_1021 and mb_1022 both', 'belay says mb_9999 exists', 'an unnamed server said mb_7777 exists']) {
    const out = await run1(w, 'confirmed', [cite(quote)]);
    assert.deepStrictEqual([out.applied.length, out.refused[0].code], [0, 'E_CITATION'], quote);
  }
  assert.strictEqual(statusOf(w.note), 'unverified');
  const ok = await run1(w, 'confirmed', [cite('manifest lists mb_2044 for sam.reed'), cite('the docs page says retries default to 5')]);
  assert.strictEqual(ok.applied.length, 1, JSON.stringify(ok.refused));
});
