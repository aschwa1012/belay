'use strict';
// bottle-restart.test.cjs — ADR 0042 decision 4, delivery: on the replace branch with memory.bottle on,
// resume.md is the bottle (written atomically) and a `bottle` memory_event is the receipt; with the lever off
// it is today's continuity.resumeDoc, byte for byte; any failure falls back to that document with an event;
// the resume branch builds no bottle.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shim = require('./redact-shim.cjs');
shim.install();
const { restartFirstText } = require('../../src/run/restart.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');
const { createRunManager } = require('../../src/run/index.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const FIXTURE = path.join(__dirname, 'fixtures', 'claude-stream.jsonl');
const fwd = (p) => p.replace(/\\/g, '/');
const tmp = () => fwd(fs.mkdtempSync(path.join(os.tmpdir(), 'belay-bottle-restart-')));
const DOC = '# resume\n\n## spec\nthe store-derived document\n';
const SENT = [
  { seq: 1, turn: 1, kind: 'task', text: 'Read input.md and tell me its first five words.' },
  { seq: 2, turn: 2, kind: 'message', text: 'Now say done.' },
];

// A worker directory holding a real recorded stream and, optionally, its sent record.
function workerDir({ sent = SENT, stream = true } = {}) {
  const dir = tmp();
  if (stream) fs.copyFileSync(FIXTURE, path.join(dir, 'stream.jsonl'));
  if (sent) fs.writeFileSync(path.join(dir, 'sent.jsonl'), sent.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, w: { id: 'w1', taskId: 't1', dir, streamPath: fwd(path.join(dir, 'stream.jsonl')) } };
}

// The core methods the replace branch calls, recorded. `observations` is what memory.list/get_many answer.
function stubCore({ observations = [], failList = false } = {}) {
  const calls = [];
  const events = [];
  const core = {
    calls, events,
    continuity: {
      async resumeDoc(k) { calls.push(['resumeDoc', k]); return { text: DOC }; },
      async resumeLine(k) { calls.push(['resumeLine', k]); return { text: 'LINE' }; },
    },
    memory: {
      async list(a) {
        calls.push(['list', a]);
        if (failList) { const e = new Error('store down'); e.code = 'E_OWNER_LOST'; throw e; }
        return { rows: observations.map((o) => ({ id: o.id })) };
      },
      async get_many(a) { calls.push(['get_many', a]); return { rows: observations.filter((o) => a.ids.includes(o.id)).map((o) => ({ ...o, found: true })) }; },
      async recordEvent(a) { calls.push(['recordEvent', a]); events.push(a); return a; },
    },
  };
  return core;
}
const ctxWith = (core, over = {}) => ({ core, runId: 'r', memoryLevers: { ...DEFAULTS, bottle: true, ...over } });
const resumeMd = (dir) => fs.readFileSync(path.join(dir, 'resume.md'), 'utf8');
const names = (core) => core.calls.map((c) => c[0]);
const TAIL = 'This is a fresh session replacing an interrupted one. Read resume.md in your worker directory, then continue.';

test('lever off: resume.md is the resumeDoc text byte for byte, the text is unchanged, no bottle call is made', async () => {
  for (const ctx of [undefined, { runId: 'r', memoryLevers: { ...DEFAULTS } }, { runId: 'r', memoryLevers: { ...DEFAULTS, observations: true } }]) {
    const { dir, w } = workerDir();
    try {
      const core = stubCore();
      const text = await restartFirstText(w, 'replace', { core, ctx: ctx && { ...ctx, core } });
      assert.strictEqual(resumeMd(dir), DOC);
      assert.strictEqual(text, `LINE\n\n${TAIL}`);
      assert.deepStrictEqual(names(core), ['resumeDoc', 'resumeLine']);
      assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['resume.md', 'sent.jsonl', 'stream.jsonl']);
    } finally { cleanup(dir); }
  }
});

test('on: resume.md is the bottle built from the stream and the sent record, written whole, with one bottle receipt', async () => {
  const { dir, w } = workerDir();
  try {
    const core = stubCore();
    const text = await restartFirstText(w, 'replace', { core, ctx: ctxWith(core) });
    const md = resumeMd(dir);
    assert.notStrictEqual(md, DOC);
    assert.ok(md.startsWith('Conversation so far'));
    assert.ok(md.includes('user: Read input.md and tell me its first five words.'), 'the task spec from the sent record');
    assert.ok(md.includes('user: Now say done.'));
    assert.ok(md.includes('assistant: done'));
    assert.strictEqual(text, `LINE\n\n${TAIL}`, 'the instruction to read resume.md is unchanged');
    assert.ok(!names(core).includes('resumeDoc'), 'the store-derived document is not built when the bottle holds');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['resume.md', 'sent.jsonl', 'stream.jsonl'], 'no temp file is left');

    assert.strictEqual(core.events.length, 1);
    const ev = core.events[0];
    assert.strictEqual(ev.kind, 'bottle');
    assert.strictEqual(ev.ok, 1);
    assert.strictEqual(ev.worker_id, 'w1');
    assert.strictEqual(ev.task_id, 't1');
    assert.strictEqual(ev.bytes, Buffer.byteLength(md));
    assert.strictEqual(ev.sha256, crypto.createHash('sha256').update(md).digest('hex'));
    assert.strictEqual(ev.dropped, 0);
    assert.strictEqual(ev.over_budget, 0);
    assert.match(ev.message, /user_messages=recorded/);
  } finally { cleanup(dir); }
});

test('on: it is rebuilt whole every time, replacing the previous file', async () => {
  const { dir, w } = workerDir();
  try {
    fs.writeFileSync(path.join(dir, 'resume.md'), 'STALE '.repeat(1000));
    const core = stubCore();
    await restartFirstText(w, 'replace', { core, ctx: ctxWith(core) });
    assert.ok(!resumeMd(dir).includes('STALE'));
  } finally { cleanup(dir); }
});

test('on, no sent record: the bottle says so and the receipt reports user_messages=unrecorded', async () => {
  const { dir, w } = workerDir({ sent: null });
  try {
    const core = stubCore();
    await restartFirstText(w, 'replace', { core, ctx: ctxWith(core) });
    assert.match(resumeMd(dir), /messages sent to this worker were not recorded/);
    assert.match(core.events[0].message, /user_messages=unrecorded/);
    assert.strictEqual(core.events[0].ok, 1);
  } finally { cleanup(dir); }
});

test('on with observations: stored exit data is keyed by tool_use_id and the receipt says how many were read', async () => {
  const { dir, w } = workerDir({ stream: false });
  try {
    const line = (o) => JSON.stringify(o) + '\n';
    fs.writeFileSync(path.join(dir, 'stream.jsonl'), [
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'running the tests' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'npm test' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'FAIL', is_error: true }] } }),
      line({ type: 'result', subtype: 'success' }),
    ].join(''));
    const obs = [{ id: 'o1', title: 'turn 1: ran 1 command', body: { v: 1, turn: 1, commands: [{ command: 'npm test', tool_use_id: 'tu-1', exit_code: 1, exit_code_source: 'reported' }] } }];
    const core = stubCore({ observations: obs });
    await restartFirstText(w, 'replace', { core, ctx: ctxWith(core, { capture: true, observations: true }) });
    assert.match(resumeMd(dir), /\[tool Bash: npm test -> exit 1 \(reported\)/);
    assert.deepStrictEqual(core.calls.find((c) => c[0] === 'list')[1].filter, { types: ['observation'], task_id: 't1' });
    assert.deepStrictEqual(core.calls.find((c) => c[0] === 'get_many')[1].ids, ['o1']);
    assert.match(core.events[0].message, /1 observations/);
  } finally { cleanup(dir); }
});

test('on, observations unreadable: the bottle is still built, without them, and the receipt names the code', async () => {
  const { dir, w } = workerDir();
  try {
    const core = stubCore({ failList: true });
    await restartFirstText(w, 'replace', { core, ctx: ctxWith(core, { capture: true, observations: true }) });
    assert.ok(resumeMd(dir).startsWith('Conversation so far'));
    assert.match(core.events[0].message, /observations unavailable \(E_OWNER_LOST\)/);
    assert.strictEqual(w.lastError.where, 'memory.list');
  } finally { cleanup(dir); }
});

test('an unreadable stream falls back to the resume document and records why', async () => {
  const { dir, w } = workerDir({ stream: false });
  try {
    const core = stubCore();
    const text = await restartFirstText(w, 'replace', { core, ctx: ctxWith(core) });
    assert.strictEqual(resumeMd(dir), DOC);
    assert.strictEqual(text, `LINE\n\n${TAIL}`);
    assert.strictEqual(core.events.length, 1);
    assert.strictEqual(core.events[0].kind, 'bottle');
    assert.strictEqual(core.events[0].ok, 0);
    assert.strictEqual(core.events[0].code, 'E_STREAM_UNREADABLE');
    assert.match(core.events[0].message, /fell back to the resume document/);
  } finally { cleanup(dir); }
});

test('over budget with nothing droppable falls back with over_budget set', async () => {
  const { dir, w } = workerDir();
  try {
    const core = stubCore();
    await restartFirstText(w, 'replace', { core, ctx: ctxWith(core, { bottle_bytes: 40 }) });
    assert.strictEqual(resumeMd(dir), DOC);
    assert.strictEqual(core.events[0].ok, 0);
    assert.strictEqual(core.events[0].code, 'E_OVER_BUDGET');
    assert.strictEqual(core.events[0].over_budget, 1);
  } finally { cleanup(dir); }
});

test('a write that fails falls back and records E_BOTTLE_WRITE (the resume document is then tried, and its failure named)', async () => {
  const { dir, w } = workerDir();
  try {
    fs.mkdirSync(path.join(dir, 'resume.md')); // a directory where the file goes: the rename fails
    const core = stubCore();
    const text = await restartFirstText(w, 'replace', { core, ctx: ctxWith(core) });
    assert.strictEqual(core.events[0].code, 'E_BOTTLE_WRITE');
    assert.strictEqual(core.events[0].ok, 0);
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'the temp file is removed');
    assert.ok(names(core).includes('resumeDoc'));
    assert.strictEqual(w.lastError.where, 'continuity.resumeDoc');
    assert.strictEqual(text, `LINE\n\n${TAIL}`);
  } finally { cleanup(dir); }
});

test('the resume branch builds no bottle: no file, no read of the stream, no event', async () => {
  const { dir, w } = workerDir();
  try {
    const core = stubCore();
    const text = await restartFirstText(w, 'resume', { core, ctx: ctxWith(core, { observations: true, capture: true }) });
    assert.strictEqual(text, 'You were interrupted and resumed. Continue from where you left off.\n\nLINE');
    assert.ok(!fs.existsSync(path.join(dir, 'resume.md')));
    assert.deepStrictEqual(names(core), ['resumeLine']);
    assert.deepStrictEqual(core.events, []);
  } finally { cleanup(dir); }
});

// ---- through the run manager on the fake substrate --------------------------------------------------------

function managerCore(levers) {
  const core = createFakeCore({ runId: 'run-fake', resumeLineText: 'LINE' });
  const events = [];
  core.run = { get: async () => ({ run: { memory_levers: JSON.stringify(levers) } }) };
  core.memory.recordEvent = async (a) => { events.push(a); return a; };
  core.events = events;
  return core;
}
async function withManager(levers, fn) {
  const data = tmp();
  fs.mkdirSync(path.join(data, 'wt'), { recursive: true });
  const core = managerCore(levers);
  const m = createRunManager({
    core, dataDir: data, runId: 'run-fake',
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
  try { return await fn(m, core, { data, worktree: fwd(path.join(data, 'wt')), dir: (id) => path.join(data, 'workers', id) }); } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(data);
  }
}

test('manager: a replace restart delivers the bottle with the task and the later message; the resume branch builds none', async () => {
  await withManager({ bottle: true }, async (m, core, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'build the widget', worker_id: 'w1', task_id: 't1' });
    await m._waitTurn('w1', 8000);
    await m.message({ worker_id: 'w1', text: 'and mind the edge case' });
    await m._waitTurn('w1', 8000);

    const r1 = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 });
    assert.strictEqual(r1.branch, 'resume');
    assert.deepStrictEqual(core.events.filter((e) => e.kind === 'bottle'), [], 'a resume builds no bottle');
    assert.ok(!fs.existsSync(path.join(sb.dir('w1'), 'resume.md')));

    m._worker('w1').lastEventAt = Date.now() - 60 * 60 * 1000;
    const r2 = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 });
    assert.strictEqual(r2.branch, 'replace');
    const md = fs.readFileSync(path.join(sb.dir('w1'), 'resume.md'), 'utf8');
    assert.ok(md.startsWith('Conversation so far'));
    assert.ok(md.includes('build the widget'), 'the task spec, from the sent record');
    assert.ok(md.includes('and mind the edge case'));
    const bottles = core.events.filter((e) => e.kind === 'bottle');
    assert.strictEqual(bottles.length, 1);
    assert.strictEqual(bottles[0].ok, 1);
    assert.match(bottles[0].message, /user_messages=recorded/);

    // The relaunch's own first messages are in the record too: the resume (park/restart) text, kind resume.
    const sent = fs.readFileSync(path.join(sb.dir('w1'), 'sent.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepStrictEqual(sent.map((s) => s.kind), ['task', 'message', 'resume', 'resume']);
    assert.deepStrictEqual(sent.map((s) => s.seq), [1, 2, 3, 4]);
  });
});

test('manager, lever off: a replace restart writes the resumeDoc text and no bottle event', async () => {
  await withManager({ bottle: false }, async (m, core, sb) => {
    await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'build the widget', worker_id: 'w1', task_id: 't1' });
    await m._waitTurn('w1', 8000);
    m._worker('w1').lastEventAt = Date.now() - 60 * 60 * 1000;
    const r = await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 });
    assert.strictEqual(r.branch, 'replace');
    assert.match(fs.readFileSync(path.join(sb.dir('w1'), 'resume.md'), 'utf8'), /^# resume/);
    assert.deepStrictEqual(core.events, []);
    assert.ok(!fs.existsSync(path.join(sb.dir('w1'), 'sent.jsonl')));
  });
});
