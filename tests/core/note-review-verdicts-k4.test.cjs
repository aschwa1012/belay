'use strict';
// note-review-verdicts-k4.test.cjs — the verdict core of a note's review, against a real Engine and a real git repository:
//   K4-1  a file cite is read from the working tree of a worker that has not committed (workers do not commit; the head is recorded at settle)
//   K4-2  `confirmed` is refused for a note the reviewer was shown in part; `refuted` and the job route (which shows every field) are not
//   K4-3  a quote under six non-space characters must be a whole line
//   K4-4  a note that copied a printed line into its saw does not make that line an echo; a result that shows the title still is one
//   K4-5  a Codex worker's stream is evidence: command output and a non-belay MCP result count, prose and belay's own tools do not
//   K4-10 the checks that sit around those: a junction out of the worktree, a working-tree file that echoes the note, a printed `when`,
//         the title on the quote's line, a bracket line, a long stored text, and the saw cap on every shown entry

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor, capturingCall } = require('./helpers.cjs');
const CC = require('../../src/core/memory-citations.cjs');
const { hiddenParts } = require('../../src/core/note-shown.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');

let dir, repo, outside, store, E, head;
const RUN = 'r-k4';
const orch = callerFor('orchestrator', { run_id: RUN });
const harness = callerFor('orchestrator', { run_id: RUN, channel: 'harness' });
const worker = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
const rawCall = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const call = capturingCall(rawCall, orch, harness); // a verdict call is preceded by the brief capture a run would have made
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const statusOf = (id) => rowOf(id).status ?? 'unverified';
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
const item = (it) => `${JSON.stringify({ type: 'item.completed', item: it })}\n`;

// A worker `w` that worked a fresh task and handed back `note`; `stream` is its stream file's content. `withHead` false leaves head_sha unset,
// as it is while the worker lives. Returns { task, note }.
async function written(w, marker, { stream, note = baseNote(marker), many = null, withHead = true, substrate = 'claude-code' } = {}) {
  await call('worker.write', orch, { id: w, substrate, pid: process.pid, state: 'running', session_id: `s-${w}`, last_event_at: Date.now(), worktree: repo, ...(withHead ? { head_sha: head } : {}) });
  const t = await call('task.create', orch, { spec: `job ${++seq}`, acceptance: { commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeout_ms: 20000 }] } });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: w });
  await call('worker.write', orch, { id: w, task_id: t.id });
  fs.mkdirSync(`${dir}/workers/${w}`, { recursive: true });
  fs.writeFileSync(`${dir}/workers/${w}/stream.jsonl`, stream === undefined ? toolLines('loader.js read 3 files\nfixtures/unlisted.json was never opened\n') : stream);
  const out = await call('lease.release', worker(w), { lease_id: a.new_lease.id, notes: many || [note] });
  for (const x of out.notes) assert.strictEqual(x.state, 'stored', JSON.stringify(x));
  await call('task.evaluate', orch, { task_id: t.id, worktree: dir });
  return { task: t.id, note: out.notes[0].id, notes: out.notes.map((x) => x.id) };
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
  fs.writeFileSync(`${repo}/braces.js`, 'function a() {\n  return 1;\n}\nconst b = [\n  1,\n];\nf(\n  x\n);\n');
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init');
  head = git('rev-parse', 'HEAD').trim();
  // Work the writer has not committed: a new file, an edit to a tracked one, and an ignored file.
  fs.writeFileSync(`${repo}/fresh.js`, 'const PAGER_RETRIES = 7; // set by this task\n');
  fs.writeFileSync(`${repo}/loader.js`, "module.exports = function load() { return 'skips unlisted fixtures, now with a manifest'; };\n");
  fs.writeFileSync(`${repo}/secret.env`, 'API_TOKEN=hunter2-hunter2\n');
  // A junction to a directory outside the repository: git lists what is behind it, and the real path must be refused.
  outside = sandbox();
  fs.writeFileSync(`${outside}/leak.txt`, 'LEAKED-LINE-123456 from outside the repository\n');
  fs.symlinkSync(outside, `${repo}/linkout`, 'junction');
  fs.writeFileSync(`${repo}/draft.md`, 'notes draft: the pager timeout is thirty seconds in every environment we ship\nconst DRAFT_ONLY = 41;\n');
  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => ({ embed }), owner: null, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
});
after(() => {
  store.close(); cleanup(dir);
  try { fs.unlinkSync(`${repo}/linkout`); } catch { try { fs.rmdirSync(`${repo}/linkout`); } catch { /* the sandbox cleanup below follows what is left */ } }
  cleanup(repo); cleanup(outside);
});

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
  // Each of the three shown entries is capped, not only the first.
  for (const at of [0, 1, 2]) {
    const ev = [0, 1, 2].map((i) => ({ where: `w${i}`, saw: i === at ? 'y'.repeat(201) : 's' }));
    const hidden = hiddenParts({ text: 'x', evidence: ev });
    assert.deepStrictEqual(hidden.map((h) => h.split(' ')[0]), [`evidence[${at}].saw`], `entry ${at}`);
  }
  // The text of a note with a `when` is derived from fields the brief shows in full; a note without one keeps the text cap.
  assert.deepStrictEqual(hiddenParts({ text: 'x'.repeat(500), when: 'when the pager retries', evidence: [] }), []);
  assert.strictEqual(hiddenParts({ text: 'x'.repeat(500), when: '', evidence: [] }).length, 1);
  assert.strictEqual(hiddenParts({ text: 'x'.repeat(500), evidence: [] }).length, 1);
});

test('K4-2c: a note whose stored text is over the brief cap but whose every field was shown is confirmable on the review-task route', async () => {
  const long = (n, c) => c.repeat(n);
  const note = baseNote('K14', {
    title: `the K14 loader skips unlisted fixtures ${long(120, 'a')}`, when: `add a K14 test fixture ${long(120, 'b')}`,
    applies_to: ['src/loader/fixtures/manifest-reader.js', 'src/loader/fixtures/unlisted-files.js', 'tests/loader/fixtures/unlisted.test.js', 'guides/loader/fixtures.md'],
  });
  const w = await written('w-k42c', 'K14', { note });
  assert.ok(Buffer.byteLength(rowOf(w.note).text) > 400, `the stored text is ${Buffer.byteLength(rowOf(w.note).text)} bytes`);
  const out = await run1(w, 'confirmed', [cite('fixtures/unlisted.json was never opened')]);
  assert.strictEqual(out.applied.length, 1, JSON.stringify(out.refused));
  assert.strictEqual(statusOf(w.note), 'verified');
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
  const listing = CC.streamCite(file('l1', `- note [lesson] ${T}\n${LINE}`), 'const DEFAULT_TIMEOUT_MS = 30000;', own, T, [LINE]);
  assert.strictEqual(listing.found, false);
  assert.match(listing.reason, /also shows the note's own text/);
  assert.doesNotMatch(listing.reason, /^the quote is the note's own text, which cannot/);
  const other = 'the second long sentence of the note that a worker printed on another line of the same output';
  const beside = CC.streamCite(file('l2', `${LINE}\n${other}`), 'const DEFAULT_TIMEOUT_MS = 30000;', [T, LINE, other], T, [LINE]);
  assert.strictEqual(beside.found, false, 'a different own sentence in the result keeps the result an echo');
  assert.strictEqual(CC.streamCite(file('l3', `${LINE}\nconst RETRIES = 3;`), 'const DEFAULT_TIMEOUT_MS = 30000;', own, T, [LINE]).found, true);
  const none = CC.streamCite(file('l4', 'nothing relevant'), 'const DEFAULT_TIMEOUT_MS = 30000;', own, T, [LINE]);
  assert.match(none.reason, /note's own text, which cannot be evidence/, 'a quote no tool result holds keeps the old reason');
});

test('K4-4c: a sentence the writer put in its `when` as well as its saw is exempt as neither: a tool that printed it is an echo of the note', async () => {
  const T = 'the pager timeout is thirty seconds';
  const quote = 'const DEFAULT_TIMEOUT_MS = 30000;';
  const f = `${dir}/k44c.jsonl`;
  fs.writeFileSync(f, toolLines(LINE));
  const both = CC.streamCite(f, quote, [T, LINE, LINE], T, [LINE]); // the same long sentence in the when and in the saw
  assert.strictEqual(both.found, false, 'the writer own prose does not become evidence because a saw holds the same words');
  assert.match(both.reason, /also shows the note's own text/);
  assert.strictEqual(CC.streamCite(f, quote, [T, LINE], T, [LINE]).found, true, 'a saw alone is still exempt');
  const w = await written('w-k44c', 'K24', { stream: toolLines(readResult, 'Read'), note: baseNote('K24', { title: T, when: LINE, evidence: [{ where: 'src/pager.cjs', saw: LINE }] }) });
  const out = await run1(w, 'confirmed', [cite(quote)]);
  assert.deepStrictEqual([out.applied.length, out.refused[0] && out.refused[0].code], [0, 'E_CITATION']);
  assert.strictEqual(statusOf(w.note), 'unverified');
});

// ---- K4-5 (D54) ------------------------------------------------------------------------------------------------------------
test('K4-5: a Codex stream is evidence: command output and a non-belay MCP result count; prose, belay\'s tools and an unnamed server do not', async () => {
  const stream = [
    item({ id: 'i0', type: 'agent_message', text: 'the manifest lists mb_1021 and mb_1022 both' }),
    item({ id: 'i1', type: 'command_execution', command: 'cat manifest.json', aggregated_output: 'manifest lists mb_2044 for sam.reed\n', exit_code: 0, status: 'completed' }),
    item({ id: 'i2', type: 'mcp_tool_call', server: 'wiki', tool: 'search', result: { content: [{ type: 'text', text: 'the wiki page says retries default to 5' }] }, status: 'completed' }),
    item({ id: 'i3', type: 'mcp_tool_call', server: 'belay', tool: 'memory_search', result: { content: [{ type: 'text', text: 'belay says mb_9999 exists' }] }, status: 'completed' }),
    item({ id: 'i4', type: 'mcp_tool_call', tool: 'mystery', result: 'an unnamed server said mb_7777 exists', status: 'completed' }),
    item({ id: 'i5', type: 'mcp_tool_call', server: 'x', tool: 'belay_search', result: { content: [{ type: 'text', text: 'a belay tool under another server said mb_5555 exists' }] }, status: 'completed' }),
  ].join('');
  const w = await written('w-k45', 'K10', { stream, substrate: 'codex' });
  for (const quote of ['the manifest lists mb_1021 and mb_1022 both', 'belay says mb_9999 exists', 'an unnamed server said mb_7777 exists', 'a belay tool under another server said mb_5555 exists']) {
    const out = await run1(w, 'confirmed', [cite(quote)]);
    assert.deepStrictEqual([out.applied.length, out.refused[0].code], [0, 'E_CITATION'], quote);
  }
  assert.strictEqual(statusOf(w.note), 'unverified');
  const ok = await run1(w, 'confirmed', [cite('manifest lists mb_2044 for sam.reed'), cite('the wiki page says retries default to 5')]);
  assert.strictEqual(ok.applied.length, 1, JSON.stringify(ok.refused));
});

// ---- K4-13 (D13): a note the brief leaves out ----------------------------------------------------------------------------------
test('K4-13: a verdict on a note the review task brief did not list is refused, whatever the order of the verdicts; the notes listed are judged', async () => {
  const many = Array.from({ length: 9 }, (_, i) => baseNote(`K${100 + i}`)); // markers 100 to 108: no other note of this file has a vector near these
  const w = await written('w-k413m', 'K100', { many });
  assert.strictEqual(w.notes.length, 9);
  const brief = await call('memory.reviewBrief', orch, { reviewed_task_id: w.task });
  const tail = require('../../src/run/note-review-text.cjs').reviewerTail(brief, []);
  const order = brief.notes.map((n) => n.id); // the brief's own order (created, then id), which the notes written in one millisecond do not keep
  assert.deepStrictEqual(order.slice().sort(), w.notes.slice().sort());
  assert.deepStrictEqual(w.notes.filter((id) => tail.includes(`- ${id} [`)).sort(), order.slice(0, 8).sort(), 'the brief lists the first eight notes');
  const q = cite('fixtures/unlisted.json was never opened');
  // The first note is judged first; judging it must not pull the ninth into the list.
  const out = await apply(await review('rev-k413m', w.task, [verdict(order[0], 'confirmed', [q]), verdict(order[8], 'confirmed', [q]), verdict(order[7], 'refuted', [q])]));
  assert.deepStrictEqual(out.applied.map((a) => a.id).sort(), [order[0], order[7]].sort());
  assert.strictEqual(statusOf(order[0]), 'verified');
  assert.strictEqual(statusOf(order[8]), 'unverified', 'a note the reviewer was not shown is not verified');
  const refused = out.refused.find((r) => r.id === order[8]);
  assert.ok(refused && refused.detail && refused.detail.reason === 'not_shown', JSON.stringify(out.refused));
});

// ---- K4-10 -----------------------------------------------------------------------------------------------------------------
test('K4-10a: a bracket line is not a citation: `}` and `);` are refused in a code file and in a Read result, `done.` and a numbered short line are accepted', async () => {
  const w = await written('w-k410', 'K15', { stream: toolLines('     1\u2192function a() {\n     2\u2192  return 1;\n     3\u2192}\n     4\u2192);\n     5\u2192done.\nok\n', 'Read') });
  for (const [quote, where] of [['}', 'stream'], [');', 'stream'], ['}', 'braces.js'], [');', 'braces.js'], ['];', 'braces.js']]) {
    const out = await run1(w, 'confirmed', [cite(quote, where)]);
    assert.deepStrictEqual([out.applied.length, out.refused[0].code], [0, 'E_CITATION'], `${where}:${quote}`);
  }
  assert.strictEqual(statusOf(w.note), 'unverified');
  // A short whole line with a line number in front (a Read result) is still a whole line; `ok` is a word.
  const ok = await run1(w, 'confirmed', [cite('done.'), cite('ok')]);
  assert.strictEqual(ok.applied.length, 1, JSON.stringify(ok.refused));
  const six = await written('w-k410b', 'K16');
  assert.strictEqual((await run1(six, 'confirmed', [cite('return 1;', 'braces.js')])).applied.length, 1, 'a real line of the same file is citable');
});

test('K4-10b: a worker with a recorded head still reads the working tree for what it has not committed', async () => {
  const w = await written('w-k411', 'K17'); // head is the initial commit, which has neither fresh.js nor the edit to loader.js
  const out = await run1(w, 'confirmed', [cite('const PAGER_RETRIES = 7;', 'fresh.js'), cite('now with a manifest', 'loader.js')]);
  assert.strictEqual(out.applied.length, 1, JSON.stringify(out.refused));
});

test('K4-10c: a path that resolves outside the worktree through a junction is refused', async () => {
  const w = await written('w-k412', 'K18', { withHead: false });
  const out = await run1(w, 'confirmed', [cite('LEAKED-LINE-123456', 'linkout/leak.txt')]);
  assert.deepStrictEqual([out.applied.length, out.refused[0] && out.refused[0].code], [0, 'E_CITATION']);
  assert.match(JSON.stringify(out.refused), /resolves outside the worktree/);
});

test('K4-10d: a working-tree file that holds the note\'s title or a long sentence of its own text is an echo, not evidence; a file that does not is', async () => {
  const draftTitle = 'the pager timeout is thirty seconds in every environment we ship';
  const byTitle = await written('w-k413', 'K19', { withHead: false, note: baseNote('K19', { title: draftTitle }) });
  const t = await run1(byTitle, 'confirmed', [cite('const DRAFT_ONLY = 41;', 'draft.md')]);
  assert.deepStrictEqual([t.applied.length, t.refused[0] && t.refused[0].code], [0, 'E_CITATION']);
  assert.match(JSON.stringify(t.refused), /also holds the note's own text/);
  const byWhen = await written('w-k413b', 'K20', { withHead: false, note: baseNote('K20', { title: 'K20 draft pager timeout', when: 'notes draft: the pager timeout is thirty seconds in every environment we ship' }) });
  const wh = await run1(byWhen, 'confirmed', [cite('const DRAFT_ONLY = 41;', 'draft.md')]);
  assert.deepStrictEqual([wh.applied.length, wh.refused[0] && wh.refused[0].code], [0, 'E_CITATION']);
  const plain = await written('w-k413c', 'K21', { withHead: false });
  assert.strictEqual((await run1(plain, 'confirmed', [cite('const DRAFT_ONLY = 41;', 'draft.md')])).applied.length, 1, 'the same file for a note that does not echo it');
});

test('K4-10e: the writer\'s own `when`, printed by a tool, is an echo even on the line that holds the quote', async () => {
  const when = 'changing the pager retry loop, whose DEFAULT_RETRIES is 7 in src/pager.cjs and is read once at start';
  const note = baseNote('K22', { title: 'K22 pager retries', when, evidence: [{ where: 'src/pager.cjs', saw: 'the retry count' }] });
  const w = await written('w-k414', 'K22', { note, stream: toolLines(when, 'Bash') });
  const out = await run1(w, 'confirmed', [cite('DEFAULT_RETRIES is 7')]);
  assert.deepStrictEqual([out.applied.length, out.refused[0].code], [0, 'E_CITATION']);
  assert.match(JSON.stringify(out.refused), /also shows the note's own text/);
  assert.strictEqual(statusOf(w.note), 'unverified');
});

test('K4-10f: a result that shows the title on the very line that holds the quote is an echo, for a title the prefix rule covers and for one it does not', () => {
  // 64 characters: also caught by the 32-character prefix clause. 30 characters: only the whole-title clause holds it.
  for (const T of ['the pager timeout is thirty seconds in every environment we ship', 'the pager waits thirty seconds']) {
    const quote = T.slice(T.indexOf('thirty'), T.indexOf('thirty') + 20);
    const f = `${dir}/k410f.jsonl`;
    fs.writeFileSync(f, toolLines(`see: ${T}`));
    const r = CC.streamCite(f, quote, [T], T);
    assert.strictEqual(r.found, false, T);
    assert.match(r.reason, /also shows the note's own text/);
    fs.writeFileSync(f, toolLines(`timeout: ${quote}`));
    assert.strictEqual(CC.streamCite(f, quote, [T], T).found, true, 'a line that does not show the title is evidence');
  }
  // A listing that cuts the title shows its first 32 characters; that is the clause that catches it.
  const long = 'the pager timeout is thirty seconds in every environment we ship';
  fs.writeFileSync(`${dir}/k410f.jsonl`, toolLines(`see: ${long.slice(0, 40)}...`));
  assert.strictEqual(CC.streamCite(`${dir}/k410f.jsonl`, 'pager timeout is thirty', [long], long).found, false);
});
