'use strict';
// memory-preface-boundary.test.cjs — where a replacement's conversation begins is read from the store, not held on the worker object:
// the replacement's first receipt carries `convo:{"carried":[...]}` in its `key`, the earlier row ids its bottle still holds. So a failed read, a row whose
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
    assert.deepStrictEqual(JSON.parse(failed[0].key.slice('convo:'.length)), { carried: [] });
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
    assert.deepStrictEqual(JSON.parse(replaceReceipt.key.slice('convo:'.length)), { carried: ['mem-a'] });
    assert.deepStrictEqual(replaceReceipt.row_ids, ['mem-b']);
  });
});

// The boundary is control state, so a lost or damaged receipt must show rows again and never withhold one.
const indexCalls = (core) => core.calls.filter((c) => c.method === 'memory.index');

test('a replacement whose boundary receipt could not be written makes the next resume show every row, and the resume writes the boundary', async () => {
  const rows = ['mem-a'];
  const core = memoryCore({ first_message_index: true, bottle: true, bottle_bytes: 12000 }, rows);
  await scenario(core, rows, async (m, recv) => {
    await throughResume(m, rows);
    const write = core.memory.recordEvent;
    let lose = true;
    core.memory.recordEvent = async (a) => { if (lose && a.kind === 'index_injected') throw Object.assign(new Error('busy'), { code: 'E_BUSY' }); return write(a); };
    await replace(m);
    lose = false;
    const lost = core.events.filter((e) => e.kind === 'index_injected').length;
    assert.strictEqual(lost, 2, 'the replacement left no receipt: the spawn and the resume wrote theirs');
    await m._waitTurn('w1', 8000);
    assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
    const idx = indexCalls(core);
    assert.deepStrictEqual(idx[3].args.exclude_ids, [], 'the old conversation\'s boundary is no boundary of this one: nothing is left out');
    const text = received(recv)[3];
    assert.ok(text.includes('- mem-a [') && text.includes('- mem-b ['), text);
    const repair = core.events.filter((e) => e.kind === 'index_injected').pop();
    assert.strictEqual(repair.key, 'convo:{"carried":[]}', 'the resume wrote the boundary the replace could not');
    // And the boundary now holds: the next resume leaves out what the repaired conversation was shown, and no more.
    assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
    assert.deepStrictEqual([...indexCalls(core)[4].args.exclude_ids].sort(), ['mem-a', 'mem-b']);
  });
});

test('a boundary write that fails once is tried again, so the next resume still reads the store', async () => {
  const rows = ['mem-a'];
  const core = memoryCore({ first_message_index: true, bottle: true, bottle_bytes: 12000 }, rows);
  await scenario(core, rows, async (m) => {
    await throughResume(m, rows);
    const write = core.memory.recordEvent;
    let failed = 0;
    core.memory.recordEvent = async (a) => { if (a.kind === 'index_injected' && failed < 1) { failed += 1; throw Object.assign(new Error('busy once'), { code: 'E_BUSY' }); } return write(a); };
    await replace(m);
    assert.strictEqual(failed, 1);
    await m._waitTurn('w1', 8000);
    assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
    assert.deepStrictEqual([...indexCalls(core)[3].args.exclude_ids].sort(), ['mem-a', 'mem-b'], 'the boundary was stored, so the resume used it');
  });
});

test('redaction of a receipt\'s message cannot alter the boundary', async () => {
  const { redact } = require('../../src/core/redact.cjs');
  const rows = ['mem-a'];
  const core = memoryCore({ first_message_index: true, bottle: true, bottle_bytes: 12000 }, rows);
  await scenario(core, rows, async (m) => {
    await throughResume(m, rows);
    const write = core.memory.recordEvent;
    core.memory.recordEvent = async (a) => write({ ...a, message: a.message == null ? a.message : redact(a.message).text }); // as the ledger does
    const index = core.memory.index;
    let boom = true;
    core.memory.index = async (a) => { if (boom) throw Object.assign(new Error('index failed <private> and the rest'), { code: 'E_BUSY' }); return index(a); };
    await replace(m);
    boom = false;
    const failed = core.events.filter((e) => e.kind === 'index_injected' && e.ok === 0).pop();
    assert.throws(() => JSON.parse(failed.message), 'the redaction cut the message JSON, as the ledger would');
    await m._waitTurn('w1', 8000);
    assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
    assert.deepStrictEqual(indexCalls(core).pop().args.exclude_ids, ['mem-a'], 'the replacement was shown nothing but its bottle holds mem-a');
  });
});

test('a boundary key that cannot be read is a boundary with nothing carried', async () => {
  const rows = ['mem-a'];
  const core = memoryCore({ first_message_index: true, bottle: true, bottle_bytes: 12000 }, rows);
  await scenario(core, rows, async (m) => {
    await throughResume(m, rows);
    core.events.push({ kind: 'index_injected', worker_id: 'w1', ok: 1, row_ids: [], key: 'convo:{"carri' });
    m._worker('w1').lastEventAt = Date.now();
    await m._waitTurn('w1', 8000);
    assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
    assert.deepStrictEqual(indexCalls(core).pop().args.exclude_ids, [], 'rows before the unreadable boundary are not taken as held');
  });
});

test('a process that adopts the worker after a lost boundary write still shows every row, and its repair clears the loss', async () => {
  const rows = ['mem-a'];
  const core = memoryCore({ first_message_index: true, bottle: true, bottle_bytes: 12000 }, rows);
  await scenario(core, rows, async (m, recv) => {
    await throughResume(m, rows);
    const write = core.memory.recordEvent;
    let lose = true;
    core.memory.recordEvent = async (a) => { if (lose && a.kind === 'index_injected') throw Object.assign(new Error('busy'), { code: 'E_BUSY' }); return write(a); };
    await replace(m);
    lose = false;
    assert.strictEqual(core.events.filter((e) => e.kind === 'index_injected').length, 2, 'all three boundary writes failed');
    await m._waitTurn('w1', 8000);
    // The first process goes away; a second one, with its own worker records, adopts the worker from the store and the worker directory.
    const dir = m._worker('w1').dir;
    assert.ok(fs.existsSync(path.join(dir, 'convo-boundary-pending')), 'the loss is on disk, not only on the worker object');
    await m.stop({ worker_id: 'w1', mode: 'kill', timeout_ms: 8000 });
    const second = mgr(m._sb, core);
    try {
      assert.deepStrictEqual((await second.list()).workers, [], 'the second process starts knowing no worker');
      assert.strictEqual((await second.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
      assert.strictEqual(second._worker('w1').adopted !== undefined, true, 'the worker was adopted, not carried over');
      assert.deepStrictEqual(indexCalls(core).pop().args.exclude_ids, [], 'the adopter excludes nothing: this conversation never received what the old one saw');
      assert.ok(received(recv).pop().includes('- mem-a ['), 'mem-a is shown again');
      assert.strictEqual(core.events.filter((e) => e.kind === 'index_injected').pop().key, 'convo:{"carried":[]}', 'the adopter wrote the boundary');
      assert.ok(!fs.existsSync(path.join(dir, 'convo-boundary-pending')), 'a stored boundary clears the loss');
    } finally { try { await second.shutdown(); } catch { /* best effort */ } }
  });
});
