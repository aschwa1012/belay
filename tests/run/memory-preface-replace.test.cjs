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
    const text = left.length ? `INDEX ${left.join(' ')}` : '';
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
  assert.ok(r.texts[1].includes('INDEX mem-a mem-b'), r.texts[1]);
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
  assert.ok(r.texts[1].includes('INDEX mem-a mem-b'), r.texts[1]);
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
  assert.ok(r.texts[1].includes('INDEX mem-a mem-b'), r.texts[1]);
});
