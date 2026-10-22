'use strict';
// memory-note-contract.test.cjs — the paired write/search contract for notes. A note is written with a `when` (the task that
// would run into it); its vector is made from "{title}\nWhen: {when}" only (template v2), its keyword text carries the title,
// the When: line, subjects and applies_to; applies_to is derived from the worker's worktree diff and the evidence, never typed;
// every embedded row records the template its vector came from; `memory.embedNote { reembed: 'v2' }` rebuilds a v1 vector
// only where a `when` exists; the project's most used subjects are offered by `memory.noteSubjects`. A fake embedder gives
// vectors we choose and records the exact text it was asked to embed. The worktree is a real temporary git repository.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('./helpers.cjs');

const { Store } = core('store.cjs');
const { Engine } = core('engine.cjs');
const NT = core('memory-notes.cjs');
const NP = core('note-paths.cjs');

let dir, store, E, repo, baseSha;
let mode = 'required', embedderDown = false; // the run's on_embedder_failure, and whether the embedder is failing now
const hookCalls = [];
const RUN = 'r-contract';
const orch = callerFor('orchestrator', { run_id: RUN });
const operator = callerFor('operator', { run_id: 'cli' });
const worker = (id) => callerFor('worker', { run_id: RUN, worker_id: id });
const call = (method, caller, args = {}) => E.handle(method, { caller, ...args });
const rowOf = (id) => store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
const bodyOf = (id) => JSON.parse(rowOf(id).body);
let seq = 0;

// Axis by marker word, as in the hand-back tests: K<n> is the n-th axis, anything else the last.
const DIM = 16;
const asked = []; // every text the embedder was asked for, with its role
const vecOf = (text) => {
  const m = /\bK(\d+)\b/.exec(text);
  const v = new Array(DIM).fill(0);
  v[m ? Number(m[1]) : DIM - 1] = 1;
  if (text.includes('When:')) v[DIM - 2] = 0.5; // a v2 text sits a little off the axis its words name, so a rebuilt vector differs from the whole-text one
  return v;
};
const embedder = { embed: async (text, o) => { asked.push({ text, as: o && o.as }); if (embedderDown) throw Object.assign(new Error('the embedder is down'), { code: 'E_MODEL_ABSENT', detail: { embedder: true, cause: 'absent' } }); return { embedding: vecOf(text), embedding_model: 'fake', embedding_revision: 'r', dim: DIM }; } };

const git = (...a) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }).trim();
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };

const note = (marker, over = {}) => ({
  kind: 'lesson', title: `the ${marker} loader skips unlisted fixtures`, when: `load a ${marker} test fixture`, basis: 'observed',
  evidence: [{ where: `src/${marker}.js:12`, saw: 'the unlisted file was never read' }], subjects: [marker], ...over,
});
async function handBack(workerId, notes) {
  const t = await call('task.create', orch, { spec: `job ${++seq}` });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: workerId });
  return call('lease.release', worker(workerId), { lease_id: a.new_lease.id, notes });
}

before(async () => {
  dir = sandbox();
  repo = path.join(dir, 'wt');
  fs.mkdirSync(repo, { recursive: true });
  git('init', '-q');
  put('a.txt', 'base\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  baseSha = git('rev-parse', 'HEAD');
  put('src/new.js', 'committed\n');
  git('add', '-A'); git('commit', '-qm', 'work');
  put('a.txt', 'edited, not committed\n');
  put('lib/u.md', 'untracked\n');

  store = new Store(`${dir}/memory.db`, { stamp: true });
  E = new Engine({ dataDir: dir, store, getEmbedder: async () => embedder, owner: { opts: { embedderMode: () => mode, onEmbedderFailure: (ev) => { hookCalls.push(ev); } } }, establishedBy: 'test' });
  await call('run.attach', orch, { adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', notes: true }) });
  const row = (id, extra) => call('worker.write', orch, { id, substrate: 'claude-code', pid: process.pid, state: 'running', session_id: `s-${id}`, last_event_at: Date.now(), model: 'claude-test-1', ...extra });
  await row('w1', { worktree: repo.replace(/\\/g, '/'), base_sha: baseSha });
  await row('w2', {}); // no worktree on its row
  await row('w3', { worktree: repo.replace(/\\/g, '/'), base_sha: baseSha });
});
after(() => { store.close(); cleanup(dir); });

test('a new note is embedded from exactly "{title}\\nWhen: {when}", keyword-indexed by the longer text, and records template v2', async () => {
  asked.length = 0;
  const out = await handBack('w1', [note('K1', { subjects: ['loader', 'fixtures'] })]);
  assert.strictEqual(out.notes[0].state, 'stored');
  const r = rowOf(out.notes[0].id);
  assert.deepStrictEqual(asked.map((a) => [a.text, a.as]), [['the K1 loader skips unlisted fixtures\nWhen: load a K1 test fixture', 'document']]);
  assert.ok(!asked[0].text.includes('src/K1.js'), 'evidence is not embedded');
  assert.ok(!asked[0].text.includes('subjects'), 'subjects are not embedded');
  assert.strictEqual(r.text_template, 'v2');
  assert.strictEqual(r.text, 'the K1 loader skips unlisted fixtures\nWhen: load a K1 test fixture\nsubjects: loader; fixtures\napplies to: src/K1.js');
  assert.strictEqual(r.text, NT.keywordText({ ...note('K1', { subjects: ['loader', 'fixtures'] }), applies_to: bodyOf(r.id).applies_to }));
  assert.strictEqual(bodyOf(r.id).when, 'load a K1 test fixture');
  assert.ok(r.embedding, 'embedded');
});

test('applies_to is the worker\'s paths, the evidence paths and only the diff files the note names; the whole diff is kept apart as task_files', async () => {
  const out = await handBack('w1', [note('K2', { applies_to: ['worker/chosen.js'], title: 'src/new.js is numbered by filename' })]);
  const b = bodyOf(out.notes[0].id);
  // worker first, then evidence (src/K2.js, the :12 stripped), then the one diff file the title names.
  assert.deepStrictEqual(b.applies_to, ['worker/chosen.js', 'src/K2.js', 'src/new.js']);
  assert.deepStrictEqual(b.applies_to_from, ['worker', 'evidence', 'diff']);
  assert.deepStrictEqual(out.notes[0].applies_to, { total: 3, worker: 1, evidence: 1, diff: 1, dropped: 0, task_files: 3 });
  // the whole diff (committed since the base, edited, untracked), sorted, with its source
  assert.deepStrictEqual(b.task_files, ['a.txt', 'lib/u.md', 'src/new.js']);
  assert.strictEqual(b.task_files_from, 'diff');
  // the worker never has to type a path; and two unrelated notes of one task do not share applies_to through the diff
  const t = await call('task.create', orch, { spec: `job ${++seq}` });
  const a = await call('task.assign', orch, { task_id: t.id, worker_id: 'w3' });
  const two = await call('lease.release', worker('w3'), { lease_id: a.new_lease.id, notes: [note('K3', { applies_to: undefined }), note('K13', { applies_to: undefined })] });
  const [x, y] = two.notes.map((n) => bodyOf(n.id));
  assert.deepStrictEqual(x.applies_to, ['src/K3.js']);
  assert.deepStrictEqual(y.applies_to, ['src/K13.js']);
  assert.deepStrictEqual(x.task_files, y.task_files, 'both know the task\'s files');
  assert.ok(!x.applies_to.some((p) => y.applies_to.includes(p)), 'but share no applies_to path');
});

test('a worktree that cannot be read is named in the result and the note is stored with its evidence paths only', async () => {
  const out = await handBack('w2', [note('K4')]);
  assert.strictEqual(out.notes[0].state, 'stored');
  assert.match(out.notes[0].applies_to.diff_error, /no worktree/);
  assert.deepStrictEqual(bodyOf(out.notes[0].id).applies_to, ['src/K4.js']);
  // a path that is not a repository
  const d = await NP.workerDiff(path.join(dir, 'nowhere'), baseSha);
  assert.deepStrictEqual(d.paths, []);
  assert.match(d.error, /does not exist/);
  const bare = path.join(dir, 'notarepo');
  fs.mkdirSync(bare);
  const e = await NP.workerDiff(bare, baseSha);
  assert.deepStrictEqual(e.paths, []);
  assert.ok(e.error, 'git said it is not a repository');
});

test('merge: worker paths first, only diff files the note names join them, the whole diff is kept apart, and evidence paths are read as paths', () => {
  const diff = { paths: Array.from({ length: 40 }, (_, i) => `d/${String(i).padStart(2, '0')}.js`) };
  const note = { title: 'd/05.js and 07.js disagree', applies_to: ['w/one.js'], evidence: [{ where: 'see `src/a.js:3:9`, lib/x.md#L4 and https://example.com/p.html', saw: 'x' }] };
  const m = NP.merge(note, diff);
  assert.deepStrictEqual(m.applies_to, ['w/one.js', 'src/a.js', 'lib/x.md', 'd/05.js', 'd/07.js']);
  assert.deepStrictEqual(m.applies_to_from, ['worker', 'evidence', 'evidence', 'diff', 'diff']);
  assert.deepStrictEqual(m.counts, { total: 5, worker: 1, evidence: 2, diff: 2, dropped: 0, task_files: 40 });
  assert.strictEqual(m.task_files.length, 40); assert.strictEqual(m.task_files_truncated, 0);
  const none = NP.merge({ title: 'nothing about the diff', evidence: [] }, diff);
  assert.deepStrictEqual(none.applies_to, [], 'a note that names no diff file gets none of them');
  assert.deepStrictEqual(NP.evidencePaths([{ where: 'C:/elsewhere/x.js', saw: '' }, { where: 'the loader', saw: '' }, { where: '../up.js', saw: '' }]), [], 'no absolute, outside or wordy path');
  assert.deepStrictEqual(NP.evidencePaths([{ where: 'D:/proj/wt/src/in.js:4', saw: '' }], 'D:/proj/wt'), ['src/in.js'], 'a worktree-absolute path is made relative');
});

test('the keyword text is searched: the When: line, a subject and a derived path all find the note', async () => {
  const out = await handBack('w1', [note('K5', { title: 'numbering is by filename', when: 'renumber the quarantined widgets', subjects: ['zebrafish'] })]);
  const id = out.notes[0].id;
  const find = async (q) => (await call('memory.search', orch, { query: q, namespace: 'project/acme', mode: 'keyword', view: 'index' })).results.map((r) => r.id);
  assert.ok((await find('quarantined widgets')).includes(id), 'by When');
  assert.ok((await find('zebrafish')).includes(id), 'by subject');
  assert.ok((await find('src/K5.js')).includes(id), 'by a derived path');
});

test('every embedded row records its template: v1 for plain text, v2 for a new note; an unembedded row records none', async () => {
  const stored = await call('memory.store', { ...orch, channel: 'harness' }, { text: 'a plain fact about releases K9', namespace: 'project/acme', type: 'fact' });
  assert.strictEqual(rowOf(stored.id).text_template, 'v1');
  const bare = await call('memory.store', { ...orch, channel: 'harness' }, { text: 'a fact stored without a vector', namespace: 'project/acme', type: 'fact', embed: false });
  assert.strictEqual(rowOf(bare.id).embedding, null);
  assert.strictEqual(rowOf(bare.id).text_template, null);
  const all = store.p("SELECT id, text_template FROM memory_entries WHERE embedding IS NOT NULL").all();
  assert.ok(all.length >= 5 && all.every((r) => r.text_template === 'v1' || r.text_template === 'v2'), 'no embedded row lacks a template');
});

// ---- search over a store that holds both templates; --reembed ------------------------------------------------------------

let v1Plain, v1WithWhen, v2Id;
const legacy = (marker) => `the ${marker} legacy note\napplies to: src/${marker}.js\nevidence: src/${marker}.js - saw it`;

test('a store holding v1 and v2 rows is searched as one; mixing is allowed', async () => {
  const mk = async (marker, body, template) => {
    const text = legacy(marker);
    const e = await embedder.embed(text, { as: 'document' });
    return E.store.store({ namespace: 'project/acme', worker_id: 'harness', type: 'note', text, title: `the ${marker} legacy note`, body, embedding: e.embedding, embedding_model: e.embedding_model, embedding_revision: e.embedding_revision, dim: e.dim, text_template: template, written_by: 'harness' }).id;
  };
  // an old note: no `when`; and one with a `when` whose vector is still the whole-text one
  v1Plain = await mk('K6', { kind: 'lesson', basis: 'observed', state: 'live', evidence: [], applies_to: ['src/K6.js'], subjects: [] }, undefined);
  v1WithWhen = await mk('K7', { kind: 'lesson', basis: 'observed', state: 'live', when: 'rebuild the K7 index', evidence: [], applies_to: [], subjects: [] }, 'v1');
  v2Id = (await handBack('w1', [note('K8')])).notes[0].id;
  assert.deepStrictEqual([rowOf(v1Plain).text_template, rowOf(v1WithWhen).text_template, rowOf(v2Id).text_template], ['v1', 'v1', 'v2']);
  const hits = async (marker) => (await call('memory.search', orch, { query: `K${marker}`, query_embedding: vecOf(`K${marker}`), embedding_model: 'fake', namespace: 'project/acme', mode: 'semantic', view: 'index', k: 20 })).results.map((r) => r.id);
  assert.ok((await hits(6)).includes(v1Plain) && (await hits(7)).includes(v1WithWhen) && (await hits(8)).includes(v2Id));
});

test('memory.retemplate names what can be rebuilt and what cannot, and is a read', async () => {
  const before = store.p('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM memory_entries').get();
  const r = await call('memory.retemplate', operator, { project: 'acme', template: 'v2' });
  assert.deepStrictEqual(r.eligible.map((x) => x.id), [v1WithWhen]);
  assert.deepStrictEqual(r.stays.map((x) => [x.id, x.reason]), [[v1Plain, 'no_when']]);
  assert.ok(r.already >= 4, 'the v2 notes are counted as already v2');
  assert.deepStrictEqual(store.p('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM memory_entries').get(), before, 'a read writes nothing');
  assert.ok(!r.eligible.concat(r.stays).some((x) => x.id === v2Id));
  await assert.rejects(call('memory.retemplate', operator, { project: 'acme', template: 'v1' }), (e) => e.code === 'E_ARGS');
  await assert.rejects(call('memory.retemplate', orch, { project: 'acme', template: 'v2' }), (e) => e.code === 'E_ROLE');
});

test('--reembed rebuilds a v1 vector from title and When: only where a when exists; a v1 note without one is untouched', async () => {
  const snap = (id) => { const r = rowOf(id); return { embedding: Buffer.from(r.embedding).toString('hex'), tpl: r.text_template, text: r.text, updated_at: r.updated_at }; };
  const plainBefore = snap(v1Plain);
  const whenBefore = snap(v1WithWhen);
  asked.length = 0;
  const skip = await call('memory.embedNote', operator, { id: v1Plain, reembed: 'v2' });
  assert.deepStrictEqual([skip.action, skip.reason, skip.from, skip.reembedded], ['skipped', 'no_when', 'v1', false]);
  assert.deepStrictEqual(snap(v1Plain), plainBefore, 'the v1 note without a when is byte for byte what it was');
  assert.deepStrictEqual(asked, [], 'and the embedder was not asked');

  const done = await call('memory.embedNote', operator, { id: v1WithWhen, reembed: 'v2' });
  assert.deepStrictEqual([done.action, done.from, done.to, done.reembedded], ['reembedded', 'v1', 'v2', true]);
  assert.deepStrictEqual(asked.map((a) => a.text), ['the K7 legacy note\nWhen: rebuild the K7 index'], 'built from the stored title and when, not the stored text');
  const after = snap(v1WithWhen);
  assert.strictEqual(after.tpl, 'v2');
  assert.notStrictEqual(after.embedding, whenBefore.embedding, 'the vector changed');
  assert.strictEqual(after.text, whenBefore.text, 'the keyword text is as it was');
  assert.strictEqual(after.updated_at, whenBefore.updated_at, 'a re-embed is not an edit');

  const again = await call('memory.embedNote', operator, { id: v1WithWhen, reembed: 'v2' });
  assert.deepStrictEqual([again.action, again.reason], ['skipped', 'already_v2']);
  const bareV2 = await call('memory.embedNote', operator, { id: v2Id, reembed: 'v2' });
  assert.strictEqual(bareV2.reason, 'already_v2');
  await assert.rejects(call('memory.embedNote', operator, { id: v1WithWhen, reembed: 'v1' }), (e) => e.code === 'E_ARGS');
  await assert.rejects(call('memory.embedNote', orch, { id: v1WithWhen, reembed: 'v2' }), (e) => e.code === 'E_ROLE');
  assert.deepStrictEqual((await call('memory.retemplate', operator, { project: 'acme', template: 'v2' })).eligible, [], 'nothing is left to rebuild');
});

test('embedding a note stored without a vector uses its own template: v2 from title and When:, an old note from its text', async () => {
  const mk = (marker, body) => E.store.store({ namespace: 'project/acme', worker_id: 'harness', type: 'note', text: legacy(marker), title: `the ${marker} legacy note`, body, written_by: 'harness' }).id;
  const withWhen = mk('K10', { kind: 'lesson', basis: 'observed', state: 'live', when: 'rotate the K10 keys', evidence: [], applies_to: [], subjects: [] });
  const without = mk('K11', { kind: 'lesson', basis: 'observed', state: 'live', evidence: [], applies_to: [], subjects: [] });
  asked.length = 0;
  await call('memory.embedNote', operator, { id: withWhen });
  await call('memory.embedNote', operator, { id: without });
  assert.deepStrictEqual(asked.map((a) => a.text), ['the K10 legacy note\nWhen: rotate the K10 keys', legacy('K11')]);
  assert.deepStrictEqual([rowOf(withWhen).text_template, rowOf(without).text_template], ['v2', 'v1']);
});

// ---- the subject list ---------------------------------------------------------------------------------------------------

test('memory.noteSubjects: the most used first, case folded, long and refuted ones left out, inside the number and byte caps', async () => {
  const mk = (subjects, status) => {
    const id = E.store.store({ namespace: 'project/subj', worker_id: 'harness', type: 'note', text: `note ${++seq} ${subjects.join(' ')}`, title: `n${seq}`, body: { kind: 'lesson', subjects }, written_by: 'harness' }).id;
    if (status) store.p('UPDATE memory_entries SET status = ? WHERE id = ?').run(status, id);
    return id;
  };
  mk(['migrations', 'db']); mk(['Migrations']); mk(['migrations', 'email']); mk(['email']); mk(['zeta']);
  mk(['ghost', 'ghost'], 'refuted'); mk(['x'.repeat(41)]);
  const r = await call('memory.noteSubjects', orch, { project: 'subj' });
  assert.deepStrictEqual(r.subjects, [{ subject: 'migrations', notes: 3 }, { subject: 'email', notes: 2 }, { subject: 'db', notes: 1 }, { subject: 'zeta', notes: 1 }]);
  assert.strictEqual(r.considered, 6, 'the refuted note is not counted');
  assert.strictEqual((await call('memory.noteSubjects', orch, { project: 'subj', limit: 2 })).subjects.length, 2);
  // twenty-five distinct subjects: at most 20 come back, and never more than 400 bytes of them
  for (let i = 0; i < 25; i++) mk([`topic-${String(i).padStart(2, '0')}-${'q'.repeat(30)}`]);
  const big = await call('memory.noteSubjects', orch, { project: 'subj' });
  assert.ok(big.subjects.length <= 20 && big.bytes <= 400, `${big.subjects.length} subjects, ${big.bytes} bytes`);
  assert.deepStrictEqual((await call('memory.noteSubjects', orch, { project: 'nothing-here' })).subjects, []);
  await assert.rejects(call('memory.noteSubjects', worker('w1'), { project: 'subj' }), (e) => e.code === 'E_ROLE');
  await assert.rejects(call('memory.noteSubjects', orch, {}), (e) => e.code === 'E_ARGS');
});

test('a hand-back with a note that has no when is refused by name and writes nothing', async () => {
  const before = store.count();
  const n = note('K12'); delete n.when;
  await assert.rejects(handBack('w1', [n]), (e) => e.code === 'E_NOTE_SHAPE' && /when is required/.test(e.message));
  await assert.rejects(handBack('w1', [note('K12', { when: 'w'.repeat(161) })]), (e) => e.code === 'E_NOTE_SHAPE' && /161 bytes/.test(e.message));
  await assert.rejects(handBack('w1', [note('K12', { subjects: ['a', 'b', 'c', 'd'] })]), (e) => e.code === 'E_NOTE_SHAPE' && /at most 3/.test(e.message));
  assert.strictEqual(store.count(), before);
});

// ---- review fixes: size check, path matching, evidence tokens, opening paragraph, retitle, no-optional-locks ----------------

test('belay\'s derived fields are bounded by bytes and never count against the hand-back size limit: 30 changed files of long paths still hand back', async () => {
  const long = Array.from({ length: 30 }, (_, i) => `packages/${'deep-directory-name/'.repeat(4)}file-${String(i).padStart(2, '0')}.js`);
  assert.ok(long[0].length > 90);
  const m = NP.merge({ title: 'x', evidence: [] }, { paths: long });
  assert.ok(m.task_files.length < 30 && m.task_files.length > 0, `${m.task_files.length} kept`);
  assert.strictEqual(m.task_files_truncated, 30 - m.task_files.length);
  assert.deepStrictEqual(m.task_files, long.slice(0, m.task_files.length), 'the first files in their stable order');
  assert.ok(Buffer.byteLength(JSON.stringify(m.task_files)) <= NP.TASK_FILES_BYTES + 100);
  const keep = NP.workerDiff;
  NP.workerDiff = async () => ({ paths: long, error: null });
  try {
    const out = await handBack('w1', [note('K14', { title: `${long[3]} is generated`, evidence: [{ where: long[4], saw: 'generated' }] })]);
    assert.strictEqual(out.notes[0].state, 'stored', 'the release was not refused for the size of the diff');
    const b = bodyOf(out.notes[0].id);
    assert.deepStrictEqual(b.applies_to.filter((_, k) => b.applies_to_from[k] === 'diff'), [long[3]]);
    assert.ok(b.applies_to.includes(long[4]), 'and the evidence path is there');
    assert.strictEqual(b.task_files_truncated, 30 - b.task_files.length);
    // what the worker wrote still counts: evidence over the limit is refused
    const big = note('K15', { evidence: Array.from({ length: 8 }, () => ({ where: 'w'.repeat(300), saw: 's'.repeat(500) })) });
    await assert.rejects(handBack('w1', [big]), (e) => e.code === 'E_NOTE_SHAPE' && /you wrote/.test(e.message));
  } finally { NP.workerDiff = keep; }
});

test('a diff file joins a note only on a path-segment or whole-token boundary; an ambiguous bare name attaches none and says so', () => {
  const named = (title, paths, evidence = []) => NP.namedFiles({ title, evidence }, paths);
  assert.deepStrictEqual(named('data.js is generated', ['a.js']).named, [], 'data.js does not name a.js');
  assert.deepStrictEqual(named('see a.json', ['a.js']).named, [], 'a.json does not name a.js');
  assert.deepStrictEqual(named('see a.js', ['a.json']).named, [], 'nor a.js a.json');
  assert.deepStrictEqual(named('data/src/a.js moved', ['src/a.js']).named, [], 'a longer path is not the repo path');
  assert.deepStrictEqual(named('look at src/a.js:12, then stop', ['src/a.js']).named, ['src/a.js'], 'a full repo path, with a line suffix and punctuation');
  assert.deepStrictEqual(named('the lib.js file', ['src/lib.js']).named, ['src/lib.js'], 'a bare name equal to a whole token, when it is the only such file');
  const amb = named('index.cjs is slow', ['x/index.cjs', 'y/index.cjs', 'z/other.cjs']);
  assert.deepStrictEqual(amb.named, [], 'two changed index.cjs: none attached');
  assert.deepStrictEqual(amb.ambiguous, ['index.cjs'], 'and the ambiguity is recorded');
  assert.deepStrictEqual(named('x/index.cjs is slow', ['x/index.cjs', 'y/index.cjs']).named, ['x/index.cjs'], 'a full path settles it');
  const m = NP.merge({ title: 'index.cjs is slow', evidence: [] }, { paths: ['x/index.cjs', 'y/index.cjs'] });
  assert.deepStrictEqual([m.applies_to, m.counts.ambiguous], [[], ['index.cjs']]);
});

test('only path-shaped tokens are evidence paths: words, numbers, versions and abbreviations are not', () => {
  const where = (w) => NP.evidencePaths([{ where: w, saw: '' }]);
  assert.deepStrictEqual(where('e.g the loader, i.e. the cache'), []);
  assert.deepStrictEqual(where('22.1 and v1.2.3 and 3.14'), []);
  assert.deepStrictEqual(where('see src/a.js:3, README.md and lib/x'), ['src/a.js', 'README.md', 'lib/x']);
  assert.deepStrictEqual(where('Makefile'), [], 'a bare word without an extension is not a path');
});

test('the spawn query skips leading markdown headings, so a spec opening with a title still embeds its first paragraph', () => {
  const { openingParagraph } = core('methods-embed-query.cjs');
  assert.strictEqual(openingParagraph('# Title\n\n## Part\nAdd a migration\nfor users\n\nConstraints'), 'Add a migration for users');
  assert.strictEqual(openingParagraph('# Only a title'), 'Only a title', 'headings and nothing else: the heading\'s words');
  assert.strictEqual(openingParagraph('#hashtag is not a heading\n\nx'), '#hashtag is not a heading');
});

test('resolving a pending note as new with a changed title re-embeds it under its own template, so a v2 vector never goes stale', async () => {
  const first = await handBack('w1', [note('K0')]);
  const second = await handBack('w1', [note('K0', { title: 'the K0 loader also skips unlisted fixtures' })]);
  const pid = second.notes[0].id;
  assert.strictEqual(second.notes[0].state, 'pending');
  const before = Buffer.from(rowOf(pid).embedding).toString('hex');
  asked.length = 0;
  const out = await call('memory.noteResolve', worker('w1'), { resolutions: [{ id: pid, resolve: 'new', title: 'the K12 loader reads fixtures from the index' }] });
  assert.strictEqual(out.resolved[0].state, 'live');
  assert.deepStrictEqual(asked.map((a) => a.text), ['the K12 loader reads fixtures from the index\nWhen: load a K0 test fixture'], 'embedded from the new title and the stored when');
  const row = rowOf(pid);
  assert.strictEqual(row.text_template, 'v2');
  assert.notStrictEqual(Buffer.from(row.embedding).toString('hex'), before, 'the vector changed with the title');
  assert.strictEqual(row.title, 'the K12 loader reads fixtures from the index');
  assert.ok(row.text.startsWith('the K12 loader reads fixtures from the index\nWhen: load a K0 test fixture'));
  assert.ok(first.notes[0].id !== pid);
});

test('git status is read without optional locks, so reading a worktree cannot make a lock under a worker', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'note-paths.cjs'), 'utf8');
  assert.match(src, /'git', '--no-optional-locks', 'status'/);
});

// ---- a retitle needs the embedder ---------------------------------------------------------------------------------------------

// A pending note: a v2 near-duplicate of the first note of the same marker (the fake vectors make equal markers identical).
async function pendingNote(marker, title) {
  await handBack('w1', [note(marker)]);
  const out = await handBack('w1', [note(marker, { title })]);
  assert.strictEqual(out.notes[0].state, 'pending');
  return out.notes[0].id;
}
const resolveNew = (id, title) => call('memory.noteResolve', worker('w1'), { resolutions: [{ id, resolve: 'new', title }] });

test('retitle under required: the embedder failing fails the resolve loudly, tells the run\'s guard, and changes nothing', async () => {
  const id = await pendingNote('K1', 'the K1 loader also skips unlisted fixtures, again');
  const before = { ...rowOf(id) };
  mode = 'required'; embedderDown = true; hookCalls.length = 0;
  try {
    await assert.rejects(resolveNew(id, 'the K6 loader reads fixtures from the index'), (e) => e.code === 'E_MODEL_ABSENT');
  } finally { embedderDown = false; }
  assert.ok(hookCalls.length >= 1, 'the failure reached the run\'s embedder-failure hook');
  const after = rowOf(id);
  assert.deepStrictEqual([after.title, after.text_template, after.namespace, Buffer.from(after.embedding).toString('hex')], [before.title, 'v2', 'pending/acme', Buffer.from(before.embedding).toString('hex')]);
});

test('retitle under keyword: it succeeds, the old vector is dropped (no stale v2 vector), the row records no template, and the result says so', async () => {
  const id = await pendingNote('K2', 'the K2 loader also skips unlisted fixtures, again');
  mode = 'keyword'; embedderDown = true;
  let out;
  try { out = await resolveNew(id, 'the K7 loader reads fixtures from the index'); } finally { embedderDown = false; mode = 'required'; }
  assert.strictEqual(out.resolved[0].state, 'live');
  assert.strictEqual(out.resolved[0].embedded, false);
  assert.strictEqual(out.resolved[0].embedder_failure.code, 'E_MODEL_ABSENT');
  assert.match(out.resolved[0].note, /belay memory embed/);
  const row = rowOf(id);
  assert.deepStrictEqual([row.embedding, row.embedding_model, row.dim, row.text_template, row.namespace, row.title], [null, null, null, null, 'project/acme', 'the K7 loader reads fixtures from the index']);
  // it now shows as unembedded, and the operator's embed picks it up and embeds it as v2 from the new title and its when
  assert.ok((await call('memory.unembedded', operator, { project: 'acme', list: true })).notes.some((n) => n.id === id));
  asked.length = 0;
  const done = await call('memory.embedNote', operator, { id });
  assert.strictEqual(done.embedded, true);
  assert.deepStrictEqual(asked.map((a) => a.text), ['the K7 loader reads fixtures from the index\nWhen: load a K2 test fixture']);
  assert.strictEqual(rowOf(id).text_template, 'v2');
});

test('retitle under keyword with the embedder up re-embeds as under required', async () => {
  const id = await pendingNote('K3', 'the K3 loader also skips unlisted fixtures, again');
  mode = 'keyword';
  try { const out = await resolveNew(id, 'the K8 loader reads fixtures from the index'); assert.ok(!('embedded' in out.resolved[0])); } finally { mode = 'required'; }
  assert.strictEqual(rowOf(id).text_template, 'v2');
  assert.ok(rowOf(id).embedding);
});

test('retitle under off: the resolve is refused by the memory-off gate, as every memory write is', async () => {
  const id = await pendingNote('K4', 'the K4 loader also skips unlisted fixtures, again');
  const was = E._memoryOffFn;
  E._memoryOffFn = () => 'refuse';
  try { await assert.rejects(resolveNew(id, 'the K9 loader reads fixtures from the index'), (e) => e.code === 'E_LEVER_OFF' || /memory is off/i.test(e.message)); } finally { E._memoryOffFn = was; }
  assert.strictEqual(rowOf(id).namespace, 'pending/acme');
});

test('a retitle that fails inside the transaction (a text clash) leaves the old vector and template untouched', async () => {
  const id = await pendingNote('K5', 'the K5 loader also skips unlisted fixtures, again');
  // a live row with exactly the text the retitle would make
  const target = 'the K10 loader reads fixtures from the index';
  const pending = rowOf(id);
  const text = [target, ...pending.text.split('\n').slice(1)].join('\n');
  E.store.store({ namespace: 'pending/acme', worker_id: 'harness', type: 'note', text, title: target, body: { kind: 'lesson', state: 'pending' }, written_by: 'harness' });
  const before = { hex: Buffer.from(pending.embedding).toString('hex'), tpl: pending.text_template, title: pending.title, text: pending.text };
  await assert.rejects(resolveNew(id, target), (e) => e.code === 'E_EXISTS');
  const after = rowOf(id);
  assert.deepStrictEqual([Buffer.from(after.embedding).toString('hex'), after.text_template, after.title, after.text], [before.hex, before.tpl, before.title, before.text]);
});

test('an absolute path in a title names the changed file once the worktree root is taken off', () => {
  assert.deepStrictEqual(NP.namedFiles({ title: 'C:/wt/src/a.js is slow', evidence: [] }, ['src/a.js'], 'C:/wt').named, ['src/a.js']);
  assert.deepStrictEqual(NP.namedFiles({ title: 'c:/WT/src/a.js is slow', evidence: [] }, ['src/a.js'], 'C:/wt/').named, ['src/a.js'], 'case and a trailing slash do not matter');
  assert.deepStrictEqual(NP.namedFiles({ title: 'D:/other/src/a.js is slow', evidence: [] }, ['src/a.js'], 'C:/wt').named, [], 'another root is not this worktree');
});
