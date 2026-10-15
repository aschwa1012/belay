'use strict';
// notes-adopt.test.cjs — ADR 0047 review S6: the contract text is only ever sent to an adapter launched with --notes.
// An adopted worker (a new adapter finds it in the store) gets the flag from the run's levers before its files are
// written; a levers read that fails means off for that worker, recorded, and no contract.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const MP = require('../../src/run/memory-preface.cjs');
const NC = require('../../src/run/notes-contract.cjs');
const { DEFAULTS } = require('../../src/run/memory-levers.cjs');
const { createFakeCore } = require('./fake-core.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const USER_SETTINGS = path.join(__dirname, 'fixtures', 'user-settings.json').replace(/\\/g, '/');
const SLOW = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitCreated = async (core, id) => { for (let i = 0; i < 100; i++) { const c = core.currentWorker(id); if (c && c.pid_created) return; await sleep(100); } throw new Error('pid_created never landed for ' + id); };

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-notes-adopt-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { root: d, data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
const mgr = (sb, core) => createRunManager({ core, dataDir: sb.data, runId: 'run-fake', paths: { claudeExe: FAKE, userSettings: USER_SETTINGS } });
const levers = (core, get) => { core.run = { get }; return core; };
const ON = JSON.stringify({ project: 'demo', notes: true });
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('an adopted worker is relaunched with --notes and the contract when the run has notes on', async () => {
  const sb = sandbox();
  const core = levers(createFakeCore({ runId: 'run-fake' }), async () => ({ run: { memory_levers: ON } }));
  const first = mgr(sb, core);
  let second = null;
  try {
    const born = await first.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wa', task_id: 't1' });
    await first._waitTurn('wa', SLOW);
    await sleep(120);
    await waitCreated(core, 'wa');
    await first.stop({ worker_id: 'wa', mode: 'kill', timeout_ms: 8000 });
    second = mgr(sb, core); // a new adapter that has not read the levers yet
    const recv = path.join(sb.data, 'recv2.jsonl');
    await withEnv({ FAKE_RECV_FILE: recv }, () => second.restart({ worker_id: 'wa', first_turn_timeout_ms: SLOW }));
    const w = second._worker('wa');
    assert.strictEqual(w.notesOn, true);
    const mcp = JSON.parse(fs.readFileSync(w.mcpJsonPath, 'utf8'));
    assert.ok(mcp.mcpServers.belay.args.includes('--notes'), 'the adopted worker\'s adapter argv carries --notes');
    const sent = fs.readFileSync(recv, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text).join('\n');
    assert.ok(sent.includes(NC.question({ ...DEFAULTS })), 'and the relaunch carries the contract');
    assert.ok(born.pid > 0);
  } finally {
    for (const m of [first, second]) { if (m) { try { await m.shutdown(); } catch { /* best effort */ } } }
    fs.rmSync(sb.root, { recursive: true, force: true });
  }
});

test('a levers read that fails at spawn means no --notes and no contract, and the failure is on the worker', async () => {
  const sb = sandbox();
  const core = levers(createFakeCore({ runId: 'run-fake' }), async () => { throw Object.assign(new Error('run row unreadable'), { code: 'E_OWNER_LOST' }); });
  const m = mgr(sb, core);
  try {
    const recv = path.join(sb.data, 'recv.jsonl');
    await withEnv({ FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'do it', worker_id: 'wf' });
      await m._waitTurn('wf', 8000);
    });
    const w = m._worker('wf');
    assert.strictEqual(w.notesOn, false);
    assert.ok(!JSON.parse(fs.readFileSync(w.mcpJsonPath, 'utf8')).mcpServers.belay.args.includes('--notes'));
    assert.strictEqual(w.firstMessage, 'do it');
    assert.ok(!fs.readFileSync(recv, 'utf8').includes(NC.question({})), 'no contract on stdin');
  } finally {
    try { await m.shutdown(); } catch { /* best effort */ }
    fs.rmSync(sb.root, { recursive: true, force: true });
  }
});

test('a failed levers read is named on the worker', async () => {
  const w = {};
  const got = await MP.levers({ core: { run: { get: async () => { throw Object.assign(new Error('run row unreadable'), { code: 'E_OWNER_LOST' }); } } }, runId: 'r' }, w);
  assert.strictEqual(got.notes, false);
  assert.deepStrictEqual([w.lastError.where, w.lastError.code], ['memory.levers', 'E_OWNER_LOST']);
});

test('a failed levers read at spawn is a levers_unread receipt with ok 0 and the code, once per worker', async () => {
  const events = [];
  const ctx = { runId: 'r', core: { run: { get: async () => { throw Object.assign(new Error('run row unreadable'), { code: 'E_OWNER_LOST' }); } }, memory: { recordEvent: async (a) => { events.push(a); } } } };
  const w = { id: 'w9', taskId: 't9' };
  await MP.levers(ctx, w);
  await MP.levers(ctx, w);
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual([events[0].kind, events[0].ok, events[0].code, events[0].worker_id, events[0].task_id], ['levers_unread', false, 'E_OWNER_LOST', 'w9', 't9']);
  assert.strictEqual(w.lastError.where, 'memory.levers', 'and it is named on the worker too');
});

test('contractTail follows the worker\'s own decision, whatever the levers say now', async () => {
  const ctx = { memoryLevers: { ...DEFAULTS, project: 'p', notes: true } };
  assert.strictEqual(await MP.contractTail(ctx, { notesOn: false }), '');
  assert.strictEqual(await MP.contractTail(ctx, null), '');
  assert.ok((await MP.contractTail(ctx, { notesOn: true })).includes(NC.question(ctx.memoryLevers)));
});
