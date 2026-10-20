'use strict';
// memory-preface-boundary.test.cjs — where a replacement's conversation begins is read from the store, not held on the worker object:
// the replacement's first receipt carries `convo: { carried }`, the earlier row ids its bottle still holds. So a failed read, a row whose
// syntax is quoted in retained prose, and a process that adopts the worker are all judged from the receipts alone.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { bottleRowIds } = require('../../src/run/memory-preface.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => p.split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const PROMPT = 'implement the thing';

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-preface-boundary-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: fwd(d), worktree: fwd(path.join(d, 'wt')) };
}
function mgr(sb, core) {
  return createRunManager({ core, dataDir: sb.data, runId: 'run-fake', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
}
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const received = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : []);
const assistant = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n';
const filler = (n) => Array.from({ length: n }, (_, i) => assistant(`filler message ${i} ${'x'.repeat(300)}`)).join('');

// `rows` is read at each call, so a test can change what the store holds between launches. A row line renders as the real index does.
function memoryCore(levers, rows) {
  const core = createFakeCore({ runId: 'run-fake', resumeLineText: 'task t1 state assigned' });
  const events = [];
  core.run = { get: async () => ({ run: { memory_levers: JSON.stringify(levers) } }) };
  core.continuity.resumeDoc = async () => ({ text: '# resume\n' });
  core.memory.list = async () => ({ rows: [] });
  core.memory.get_many = async () => ({ rows: [] });
  core.memory.index = async (a) => {
    core.calls.push({ method: 'memory.index', args: a });
    const left = rows.filter((r) => !(a.exclude_ids || []).includes(r));
    const text = left.length ? ['INDEX', ...left.map((id) => `- ${id} [note/unverified] title of ${id}`)].join('\n') : '';
    return { text, bytes: Buffer.byteLength(text), row_ids: left, dropped: 0, over_budget: false, sha256: 'f'.repeat(64), considered: rows.length, excluded_already_injected: rows.length - left.length };
  };
  core.memory.events = async (a) => ({ events: events.filter((e) => e.worker_id === a.worker_id && (!a.kinds || a.kinds.includes(e.kind))) });
  core.memory.recordEvent = async (a) => { const ev = { ...a, ok: a.ok === undefined ? (a.code ? 0 : 1) : a.ok }; events.push(ev); return ev; };
  core.events = events;
  return core;
}

// A worker that was shown mem-a at its spawn and mem-b at a resume, then ran 40 more messages: the 12 KB bottle drops the resume's message.
async function throughResume(m, rows, extra = '') {
  await m.spawn({ substrate: 'claude-code', worktree: m._sb.worktree, prompt: PROMPT, worker_id: 'w1', task_id: 't1' });
  await m._waitTurn('w1', 8000);
  rows.push('mem-b');
  assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
  await m._waitTurn('w1', 8000);
  const w = m._worker('w1');
  fs.appendFileSync(w.streamPath, filler(40) + extra);
  w.lastEventAt = 1;
}
const replace = async (m) => assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'replace');

async function scenario(core, rows, fn) {
  const sb = sandbox();
  const m = mgr(sb, core);
  m._sb = sb;
  try {
    const recv = path.join(sb.data, 'recv.jsonl');
    await withEnv({ FAKE_RECV_FILE: recv }, () => fn(m, recv));
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(sb.data);
  }
}

test('bottleRowIds counts a row only as a line of a user message', () => {
  const text = [
    'BEGIN', 'user: the task',
    '  INDEX',
    '  - mem-a [note/unverified] title of mem-a',
    '  - mem-c [note/unverified] see - mem-b [ for the syntax',
    'assistant: prose that shows the syntax "- mem-d [" and then',
    '  - mem-e [note/x] a complete row in an assistant message',
    'user (generated, resume): - mem-f [note/x] a message that opens with a row',
    '[tool Bash: ls; 3 lines]',
    '  - mem-g [note/x] indented under a tool line', 'END', '',
  ].join('\n');
  assert.deepStrictEqual([...bottleRowIds(text)].sort(), ['mem-a', 'mem-c', 'mem-f']);
  assert.deepStrictEqual([...bottleRowIds('')], []);
  assert.deepStrictEqual([...bottleRowIds(null)], []);
});

test('a dropped row whose syntax is retained in assistant prose is still shown again', async () => {
  const rows = ['mem-a'];
  const core = memoryCore({ first_message_index: true, bottle: true, bottle_bytes: 12000 }, rows);
  await scenario(core, rows, async (m, recv) => {
    // The last assistant message is always kept, and it quotes the row syntax, as a worker explaining the index might.
    await throughResume(m, rows, assistant('The index lists rows as "- mem-b [" then a type.\n- mem-b [note/x] and even a whole line of it'));
    await replace(m);
    const resumeText = fs.readFileSync(fwd(path.join(m._worker('w1').dir, 'resume.md')), 'utf8');
    assert.ok(resumeText.includes('"- mem-b ['), 'the prose that quotes the syntax is retained');
    assert.deepStrictEqual([...bottleRowIds(resumeText)], ['mem-a'], 'the bottle holds the opening row and the dropped resume row is gone');
    const idx = core.calls.filter((c) => c.method === 'memory.index');
    assert.deepStrictEqual(idx[2].args.exclude_ids, ['mem-a']);
    assert.ok(received(recv)[2].includes('- mem-b ['), 'mem-b is shown to the replacement');
  });
});

test('a replace whose receipts could not be read for once holds nothing of the old conversation: the next resume is shown the rows again', async () => {
  const rows = ['mem-a', 'mem-b'];
  const core = memoryCore({ first_message_index: true, bottle: true }, rows);
  await scenario(core, rows, async (m, recv) => {
    await m.spawn({ substrate: 'claude-code', worktree: m._sb.worktree, prompt: PROMPT, worker_id: 'w1', task_id: 't1' });
    await m._waitTurn('w1', 8000);
    m._worker('w1').lastEventAt = 1;
    const read = core.memory.events;
    let calls = 0;
    core.memory.events = async (a) => { calls += 1; if (calls === 1) throw Object.assign(new Error('busy once'), { code: 'E_BUSY' }); return read(a); };
    await replace(m);
    assert.strictEqual(calls, 1, 'one read per launch: a boundary is never split across two reads');
    await m._waitTurn('w1', 8000);
    assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
    const idx = core.calls.filter((c) => c.method === 'memory.index');
    assert.strictEqual(idx.length, 2, 'the replace made no index call; the resume made one');
    assert.deepStrictEqual(idx[1].args.exclude_ids, [], 'the replacement was shown nothing, so the resume holds nothing of the old conversation');
    assert.ok(received(recv)[2].includes('- mem-a [') && received(recv)[2].includes('- mem-b ['), received(recv)[2]);
    const failed = core.events.filter((e) => e.kind === 'index_injected' && e.ok === 0);
    assert.strictEqual(failed.length, 1);
    assert.deepStrictEqual(JSON.parse(failed[0].message).convo, { carried: [] });
  });
});

test('a process that adopts the worker after a replace finds the same boundary in the store', async () => {
  const rows = ['mem-a'];
  const core = memoryCore({ first_message_index: true, bottle: true, bottle_bytes: 12000 }, rows);
  await scenario(core, rows, async (m) => {
    await throughResume(m, rows);
    await replace(m);
    await m._waitTurn('w1', 8000);
    rows.push('mem-c');
    // Another process knows nothing of the replace the first one made: nothing of it is on the worker object.
    const adopted = m._worker('w1');
    adopted.bottleText = null;
    adopted.bottleCarriesFirst = false;
    assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
    const idx = core.calls.filter((c) => c.method === 'memory.index');
    assert.strictEqual(idx.length, 4);
    assert.deepStrictEqual(idx[2].args.exclude_ids, ['mem-a'], 'the replace carried only mem-a');
    assert.deepStrictEqual([...idx[3].args.exclude_ids].sort(), ['mem-a', 'mem-b'], 'the resume holds what the bottle carried and what the replacement was shown');
    const replaceReceipt = core.events.filter((e) => e.kind === 'index_injected')[2];
    assert.deepStrictEqual(JSON.parse(replaceReceipt.message).convo, { carried: ['mem-a'] });
    assert.deepStrictEqual(replaceReceipt.row_ids, ['mem-b']);
  });
});
