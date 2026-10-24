'use strict';
// memory-preface-replace.test.cjs — inject-once (ADR 0042 decision 3) holds only where the new conversation still holds the rows:
// a resumed session, or a replacement whose bottle carries the recorded first message. A replacement that starts from nothing
// of the old session (bottle off, a bottle that fell back, a Codex worker) is shown the whole index again.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { buildBottle } = require('../../src/run/bottle.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => p.split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const FIXTURE = path.join(__dirname, 'fixtures', 'claude-stream.jsonl');
const PROMPT = 'implement the thing';

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-preface-replace-'));
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

// `rows` is a list, read at each call, so a test can change what the store holds between launches. A row line renders as the real index does.
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

// Spawn, finish one turn, make the session stale (the replace branch), restart. Returns what the replacement was sent.
async function replaceAfterShown(levers, { beforeRestart } = {}) {
  const core = memoryCore(levers, ['mem-a', 'mem-b']);
  const sb = sandbox();
  const m = mgr(sb, core);
  try {
    const recv = path.join(sb.data, 'recv.jsonl');
    let branch;
    await withEnv({ FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w1', task_id: 't1' });
      await m._waitTurn('w1', 8000);
      m._worker('w1').lastEventAt = 1; // outside the resume window: the replace branch
      if (beforeRestart) beforeRestart(m._worker('w1'));
      branch = (await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch;
    });
    const idx = core.calls.filter((c) => c.method === 'memory.index');
    return { branch, second: idx[1].args, texts: received(recv), events: core.events };
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(sb.data);
  }
}

test('replace with the bottle off: the replacement is shown the whole index again, nothing excluded', async () => {
  const r = await replaceAfterShown({ first_message_index: true });
  assert.strictEqual(r.branch, 'replace');
  assert.deepStrictEqual(r.second.exclude_ids, []);
  assert.ok((r.texts[1].includes('- mem-a [') && r.texts[1].includes('- mem-b [')), r.texts[1]);
  assert.deepStrictEqual(r.events.filter((e) => e.kind === 'index_injected')[1].row_ids, ['mem-a', 'mem-b']);
});

test('replace with the bottle on: the bottle carries the first message, so the shown rows stay excluded', async () => {
  const r = await replaceAfterShown({ first_message_index: true, bottle: true });
  assert.strictEqual(r.branch, 'replace');
  const bottle = r.events.find((e) => e.kind === 'bottle');
  assert.strictEqual(bottle.ok, 1, JSON.stringify(bottle));
  assert.deepStrictEqual(r.second.exclude_ids.sort(), ['mem-a', 'mem-b']);
  assert.ok(!r.texts[1].includes('INDEX'), r.texts[1]);
});

test('replace with the bottle on but fallen back: nothing is carried, so nothing is excluded', async () => {
  const r = await replaceAfterShown({ first_message_index: true, bottle: true }, { beforeRestart: (w) => fs.unlinkSync(w.streamPath) });
  assert.strictEqual(r.branch, 'replace');
  const bottle = r.events.find((e) => e.kind === 'bottle');
  assert.strictEqual(bottle.ok, 0, JSON.stringify(bottle));
  assert.deepStrictEqual(r.second.exclude_ids, []);
  assert.ok((r.texts[1].includes('- mem-a [') && r.texts[1].includes('- mem-b [')), r.texts[1]);
});

test('a bottle made without the sent record does not carry the first message (spec_pinned false)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-spec-pinned-'));
  try {
    const sent = [{ seq: 1, turn: 1, kind: 'task', text: 'Read input.md and tell me its first five words.' }];
    const on = buildBottle({ streamPath: FIXTURE, sent, maxBytes: 65536 });
    assert.strictEqual(on.fallback, null);
    assert.strictEqual(on.spec_pinned, true);
    const off = buildBottle({ streamPath: FIXTURE, maxBytes: 65536 });
    assert.strictEqual(off.fallback, null);
    assert.strictEqual(off.spec_pinned, false);
    const msgOnly = buildBottle({ streamPath: FIXTURE, sent: [{ seq: 1, turn: 1, kind: 'message', text: 'hello there' }], maxBytes: 65536 });
    assert.strictEqual(msgOnly.spec_pinned, false);
    assert.strictEqual(buildBottle({ streamPath: path.join(dir, 'nope.jsonl') }).spec_pinned, false);
  } finally { cleanup(dir); }
});

test('replace with a bottle that holds no recorded first message: the bottle is made, but carries no index, so nothing is excluded', async () => {
  const r = await replaceAfterShown({ first_message_index: true, bottle: true }, { beforeRestart: (w) => fs.unlinkSync(fwd(path.join(w.dir, 'sent.jsonl'))) });
  assert.strictEqual(r.branch, 'replace');
  const bottle = r.events.find((e) => e.kind === 'bottle');
  assert.strictEqual(bottle.ok, 1, JSON.stringify(bottle));
  assert.deepStrictEqual(r.second.exclude_ids, []);
  assert.ok((r.texts[1].includes('- mem-a [') && r.texts[1].includes('- mem-b [')), r.texts[1]);
});

test('the carry flag is reset on every replace: a second replace whose bottle falls back excludes nothing', async () => {
  const core = memoryCore({ first_message_index: true, bottle: true }, ['mem-a', 'mem-b']);
  const sb = sandbox();
  const m = mgr(sb, core);
  try {
    const recv = path.join(sb.data, 'recv.jsonl');
    await withEnv({ FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w1', task_id: 't1' });
      await m._waitTurn('w1', 8000);
      m._worker('w1').lastEventAt = 1;
      assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'replace');
      assert.strictEqual(m._worker('w1').bottleCarriesFirst, true);
      await m._waitTurn('w1', 8000);
      m._worker('w1').lastEventAt = 1;
      fs.unlinkSync(m._worker('w1').streamPath); // the second bottle cannot be built
      assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'replace');
    });
    const bottles = core.events.filter((e) => e.kind === 'bottle');
    assert.deepStrictEqual(bottles.map((b) => b.ok), [1, 0], JSON.stringify(bottles));
    const idx = core.calls.filter((c) => c.method === 'memory.index');
    assert.strictEqual(idx.length, 3);
    assert.deepStrictEqual(idx[1].args.exclude_ids.sort(), ['mem-a', 'mem-b']);
    assert.deepStrictEqual(idx[2].args.exclude_ids, []);
    assert.strictEqual(m._worker('w1').bottleCarriesFirst, false);
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(sb.data);
  }
});

// Codex review of the carry: a bottle that kept the opening task message proves only the opening index survived. A row first shown by
// a later relaunch (here mem-b, a resume's index) can fall out of the bottle, and must then be shown again to the replacement.
function lines(n) { return Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `filler message ${i} ${'x'.repeat(300)}` }] } })).join('\n') + '\n'; }

test('a row shown only by a later resume that the bottle dropped is shown again; the opening index stays excluded', async () => {
  const rows = ['mem-a'];
  const core = memoryCore({ first_message_index: true, bottle: true, bottle_bytes: 12000 }, rows);
  const sb = sandbox();
  const m = mgr(sb, core);
  try {
    const recv = path.join(sb.data, 'recv.jsonl');
    await withEnv({ FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w1', task_id: 't1' });
      await m._waitTurn('w1', 8000);
      rows.push('mem-b'); // a note written after the opening index
      assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
      await m._waitTurn('w1', 8000);
      const w = m._worker('w1');
      fs.appendFileSync(w.streamPath, lines(40)); // more than the 20 messages the bottle always keeps
      w.lastEventAt = 1;
      assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'replace');
    });
    const bottle = core.events.find((e) => e.kind === 'bottle');
    assert.strictEqual(bottle.ok, 1, JSON.stringify(bottle));
    const resumeText = fs.readFileSync(fwd(path.join(m._worker('w1').dir, 'resume.md')), 'utf8');
    assert.ok(resumeText.includes('- mem-a ['), 'the opening index is in the bottle');
    assert.ok(!resumeText.includes('- mem-b ['), 'the later resume message fell out of the bottle');
    const idx = core.calls.filter((c) => c.method === 'memory.index');
    assert.strictEqual(idx.length, 3);
    assert.deepStrictEqual(idx[1].args.exclude_ids, ['mem-a'], 'the resume holds what the first message showed');
    assert.deepStrictEqual(idx[2].args.exclude_ids, ['mem-a'], 'the replacement holds mem-a only: mem-b is not in its bottle');
    assert.ok(received(recv)[2].includes('- mem-b ['), 'mem-b is shown to the replacement');
    assert.ok(!received(recv)[2].includes('- mem-a ['), 'mem-a is not shown twice');
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(sb.data);
  }
});

test('a resume after a replace holds what the replacement was shown (receipts since the replace count in full)', async () => {
  const core = memoryCore({ first_message_index: true }, ['mem-a', 'mem-b']); // bottle off: the replacement starts from nothing
  const sb = sandbox();
  const m = mgr(sb, core);
  try {
    const recv = path.join(sb.data, 'recv.jsonl');
    await withEnv({ FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w1', task_id: 't1' });
      await m._waitTurn('w1', 8000);
      m._worker('w1').lastEventAt = 1;
      assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'replace');
      await m._waitTurn('w1', 8000);
      core.memory.index = ((orig) => async (a) => { core.calls.push({ method: 'memory.index.late', args: a }); return orig(a); })(core.memory.index);
      assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'resume');
    });
    const late = core.calls.find((c) => c.method === 'memory.index.late');
    assert.deepStrictEqual(late.args.exclude_ids.sort(), ['mem-a', 'mem-b'], 'the replacement itself was shown both');
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(sb.data);
  }
});

test('a replace whose receipts cannot be read still relaunches, and the failed index is a receipt, not silence', async () => {
  const core = memoryCore({ first_message_index: true, bottle: true }, ['mem-a']);
  const sb = sandbox();
  const m = mgr(sb, core);
  try {
    await withEnv({ FAKE_RECV_FILE: path.join(sb.data, 'recv.jsonl') }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: PROMPT, worker_id: 'w1', task_id: 't1' });
      await m._waitTurn('w1', 8000);
      m._worker('w1').lastEventAt = 1;
      core.memory.events = async () => { throw Object.assign(new Error('events unreadable'), { code: 'E_BUSY' }); };
      assert.strictEqual((await m.restart({ worker_id: 'w1', first_turn_timeout_ms: 8000 })).branch, 'replace');
    });
    const bad = core.events.filter((e) => e.kind === 'index_injected' && e.ok === 0);
    assert.strictEqual(bad.length, 1, JSON.stringify(core.events));
    assert.strictEqual(m._worker('w1').lastError.where, 'memory.index');
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    cleanup(sb.data);
  }
});
