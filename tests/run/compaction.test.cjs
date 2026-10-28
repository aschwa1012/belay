'use strict';
// compaction.test.cjs — build 12 wave 3, ADR 0007 decision 3 and 7: the `compact_at_tokens` lever. A real
// RunManager over tests/run/fakes/fake-claude.cjs (which models per-call context, `/compact`, the hooks of the
// worker's --settings file and an automatic compaction; see its FAKE_CTX_* knobs) and tests/run/fake-core.cjs.
// No real Claude Code session is started. Guard cases drive compaction.cjs's afterTurn on stub records.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createRunManager } = require('../../src/run/index.cjs');
const CP = require('../../src/run/compaction.cjs');
const L = require('../../src/run/launch.cjs');
const { createParser } = require('../../src/run/parsers.cjs');
const { parseLevers } = require('../../src/cli/run-levers.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').replace(/\\/g, '/');
const MCP = path.join(__dirname, '..', '..', 'src', 'mcp', 'belay-mcp.cjs');
const HOOK = path.join(__dirname, '..', '..', 'src', 'run', 'compact-hook.cjs');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-compact-'));
  fs.mkdirSync(path.join(d, 'wt'), { recursive: true });
  return { data: d.replace(/\\/g, '/'), worktree: path.join(d, 'wt').replace(/\\/g, '/') };
}
function mgr(sb, core, compactAtTokens) {
  return createRunManager({
    core, dataDir: sb.data, runId: 'run-compact-test', compactAtTokens,
    paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') },
  });
}
// The fake reads its knobs from the environment the worker inherits; set for one test and always restored.
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return await fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
async function teardown(m, sb) {
  if (m) { try { await m.shutdown(); } catch { /* best effort */ } }
  cleanup(sb.data);
}
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function until(fn, ms = 30000) { // the fake runs each hook as a node process; a loaded host takes seconds per compaction
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const records = (sb, id) => lines(`${sb.data}/workers/${id}/compactions.jsonl`);

test('lever null: no hooks key, no hook files, no /compact however large the context, no record', async () => {
  const sb = sandbox();
  const recv = `${sb.data}/recv.jsonl`;
  const m = mgr(sb, createFakeCore(), null);
  try {
    await withEnv({ FAKE_CTX_START: '900000', FAKE_CTX_STEP: '1000', FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wn' });
      await m._waitTurn('wn', 8000);
      await m.message({ worker_id: 'wn', text: 'two' });
      await m._waitTurn('wn', 8000);
      await new Promise((r) => setTimeout(r, 300));
    });
    const settings = JSON.parse(fs.readFileSync(`${sb.data}/workers/wn/settings.json`, 'utf8'));
    assert.deepStrictEqual(Object.keys(settings.hooks), ['PreToolUse'], 'the kill guard only, no compaction hooks');
    assert.deepStrictEqual(lines(recv).map((r) => r.text), ['one', 'two'], 'only the two messages the caller sent');
    for (const f of [CP.RECORDS_LOG, CP.HOOKS_LOG, CP.RESUME_FILE]) assert.ok(!fs.existsSync(`${sb.data}/workers/wn/${f}`), f);
  } finally { await teardown(m, sb); }
});

test('lever set: a turn that ends at or above it is followed by /compact, between turns, and the compaction is recorded', async () => {
  const sb = sandbox();
  const recv = `${sb.data}/recv.jsonl`;
  const m = mgr(sb, createFakeCore(), 1000);
  try {
    await withEnv({ FAKE_CTX_START: '500', FAKE_CTX_STEP: '300', FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wl' }); // ctx 500
      await m._waitTurn('wl', 8000);
      await m.message({ worker_id: 'wl', text: 'two' }); // ctx 800, still under
      await m._waitTurn('wl', 8000);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!lines(recv).some((r) => r.text.startsWith('/compact')), 'no /compact under the lever');
      await m.message({ worker_id: 'wl', text: 'three' }); // ctx 1100, at or above
      await m._waitTurn('wl', 8000);
      await until(() => records(sb, 'wl').length === 1);
    });
    const sent = lines(recv).filter((r) => r.text.startsWith('/compact'));
    assert.strictEqual(sent.length, 1, 'exactly one /compact');
    assert.strictEqual(sent[0].in_turn, false, 'the substrate was between turns when it arrived');
    const [rec] = records(sb, 'wl');
    assert.strictEqual(rec.trigger, 'manual');
    assert.strictEqual(rec.requested_by, 'harness');
    assert.strictEqual(rec.threshold, 1000);
    assert.strictEqual(rec.pre_tokens, 1100);
    assert.strictEqual(rec.post_tokens, 900);
    assert.strictEqual(rec.post_from, 'compact_metadata.post_tokens');
    assert.strictEqual(rec.duration_ms, 7);
    assert.ok(rec.wall_ms >= 0);
    assert.strictEqual(rec.steer_bytes, Buffer.byteLength(CP.STEER), 'the PreCompact steer was injected once');
    assert.ok(rec.resume_bytes > 0 && rec.resume_bytes <= CP.HOOK_MAX_BYTES, `resume bytes ${rec.resume_bytes}`);
    assert.ok(rec.max_hook_bytes <= CP.HOOK_MAX_BYTES, 'invariant 9');
    // The context is small again, so the next turn does not compact a second time.
    await withEnv({ FAKE_CTX_START: '500', FAKE_CTX_STEP: '300', FAKE_RECV_FILE: recv }, async () => {
      await m.message({ worker_id: 'wl', text: 'four' });
      await m._waitTurn('wl', 8000);
      await new Promise((r) => setTimeout(r, 300));
    });
    assert.strictEqual(lines(recv).filter((r) => r.text.startsWith('/compact')).length, 1);
    assert.strictEqual(records(sb, 'wl').length, 1);
  } finally { await teardown(m, sb); }
});

test('lever at 1: every /compact the harness sends arrives while no turn is running, and none overlaps another', async () => {
  const sb = sandbox();
  const recv = `${sb.data}/recv.jsonl`;
  const m = mgr(sb, createFakeCore(), 1);
  try {
    await withEnv({ FAKE_CTX_START: '500', FAKE_CTX_STEP: '0', FAKE_RECV_FILE: recv, FAKE_ANSWER_DELAY_MS: '150' }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wm' });
      await m._waitTurn('wm', 8000);
      await until(() => records(sb, 'wm').length >= 1);
      // The compact turn left the context at 900, still over 1: the next turn end compacts again, once.
      await m.message({ worker_id: 'wm', text: 'two' });
      await m._waitTurn('wm', 8000);
      await until(() => records(sb, 'wm').length >= 2);
    });
    const rs = lines(recv);
    const compacts = rs.filter((r) => r.text.startsWith('/compact'));
    assert.strictEqual(compacts.length, records(sb, 'wm').length, 'one record per /compact');
    assert.ok(compacts.every((r) => r.in_turn === false), JSON.stringify(compacts));
  } finally { await teardown(m, sb); }
});

test('an automatic compaction is recorded too, as substrate-requested, with its hooks bytes', async () => {
  const sb = sandbox();
  const recv = `${sb.data}/recv.jsonl`;
  const m = mgr(sb, createFakeCore(), 5000000); // the harness lever is far away; the substrate compacts first
  try {
    await withEnv({ FAKE_CTX_START: '2000', FAKE_CTX_STEP: '0', FAKE_AUTO_COMPACT_AT: '1000', FAKE_RECV_FILE: recv }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wa' });
      await m._waitTurn('wa', 8000);
      await until(() => records(sb, 'wa').length === 1);
    });
    const [rec] = records(sb, 'wa');
    assert.strictEqual(rec.trigger, 'auto');
    assert.strictEqual(rec.requested_by, 'substrate');
    assert.strictEqual(rec.pre_tokens, 2000);
    assert.strictEqual(rec.post_tokens, 900);
    assert.strictEqual(rec.wall_ms, null);
    assert.strictEqual(rec.steer_bytes, Buffer.byteLength(CP.STEER));
    assert.ok(rec.resume_bytes > 0 && rec.max_hook_bytes <= CP.HOOK_MAX_BYTES);
    assert.ok(!lines(recv).some((r) => r.text.startsWith('/compact')), 'the harness sent nothing');
  } finally { await teardown(m, sb); }
});

test('a boundary without post_tokens falls back to the first post-compaction call\'s context', async () => {
  const sb = sandbox();
  const m = mgr(sb, createFakeCore(), 1000);
  try {
    await withEnv({ FAKE_CTX_START: '1200', FAKE_CTX_STEP: '0', FAKE_NO_POST_TOKENS: '1' }, async () => {
      await m.spawn({ substrate: 'claude-code', worktree: sb.worktree, prompt: 'one', worker_id: 'wf' });
      await m._waitTurn('wf', 8000);
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(records(sb, 'wf').length, 0, 'not recorded until the post context is known');
      for (let sent = false; !sent;) { // refused E_BUSY while the compaction runs; its first call after the boundary is the next turn's
        try { await m.message({ worker_id: 'wf', text: 'two' }); sent = true; } catch (e) { if (e.code !== 'E_BUSY') throw e; await new Promise((r) => setTimeout(r, 50)); }
      }
      await m._waitTurn('wf', 8000);
      await until(() => records(sb, 'wf').length >= 1);
    });
    const [rec] = records(sb, 'wf');
    assert.strictEqual(rec.post_from, 'first_post_call_ctx (fallback)');
    assert.strictEqual(rec.post_tokens, 997, 'the fake\'s first call after the boundary reports 90 + 900 + 7');
    assert.strictEqual(rec.pre_tokens, 1200);
  } finally { await teardown(m, sb); }
});

test('the lever adds three hooks beside the kill guard in the worker settings file, and only with the lever', () => {
  const sb = sandbox();
  try {
    const on = L.writeWorkerFiles({ dir: `${sb.data}/w-on`, workerId: 'w-on', runId: 'r', dataDir: sb.data, mcpPath: MCP, settingsPath: null, cwd: sb.worktree, compactAt: 2000 });
    const hooks = JSON.parse(fs.readFileSync(on.settingsPath, 'utf8')).hooks;
    assert.deepStrictEqual(Object.keys(hooks).sort(), ['PostCompact', 'PreCompact', 'PreToolUse', 'SessionStart']);
    assert.deepStrictEqual(hooks.PreCompact.map((h) => h.matcher), ['auto', 'manual']);
    assert.strictEqual(hooks.SessionStart[0].matcher, 'compact');
    assert.match(hooks.SessionStart[0].hooks[0].command, /compact-hook\.cjs" start /);
    const off = L.writeWorkerFiles({ dir: `${sb.data}/w-off`, workerId: 'w-off', runId: 'r', dataDir: sb.data, mcpPath: MCP, settingsPath: null, cwd: sb.worktree });
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(off.settingsPath, 'utf8')).hooks), ['PreToolUse'], 'without the lever only the kill guard');
  } finally { cleanup(sb.data); }
});

test('injection sizes: the start hook never exceeds 400 bytes whatever the resume line, the pre hook prints the steer', () => {
  const nasty = ['x'.repeat(5000), '"\\'.repeat(400), 'é'.repeat(900), '日本語'.repeat(300), 'a', ''];
  for (const line of nasty) {
    const out = CP.startOutput(line);
    assert.ok(Buffer.byteLength(out, 'utf8') <= CP.HOOK_MAX_BYTES, `${Buffer.byteLength(out, 'utf8')} bytes`);
    if (line) {
      const j = JSON.parse(out); // always valid JSON
      assert.strictEqual(j.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.ok(j.hookSpecificOutput.additionalContext.length > 0);
    } else assert.strictEqual(out, '');
  }
  assert.ok(Buffer.byteLength(CP.STEER) <= CP.HOOK_MAX_BYTES);
  // The real hook processes, against a directory holding an oversized resume line.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-hook-'));
  try {
    fs.writeFileSync(path.join(d, CP.RESUME_FILE), 'r'.repeat(3000));
    const run = (label, payload) => spawnSync(process.execPath, [HOOK, label, d], { input: JSON.stringify(payload), encoding: 'utf8' });
    const pre = run('pre', { trigger: 'auto' });
    assert.strictEqual(pre.stdout, CP.STEER);
    const start = run('start', { source: 'compact' });
    assert.ok(Buffer.byteLength(start.stdout) <= CP.HOOK_MAX_BYTES);
    const post = run('post', { trigger: 'manual', compact_summary: 's'.repeat(5000) });
    assert.strictEqual(post.stdout, '', 'PostCompact injects nothing');
    const log = lines(path.join(d, CP.HOOKS_LOG));
    assert.deepStrictEqual(log.map((r) => r.label), ['pre', 'start', 'post']);
    assert.deepStrictEqual(log.map((r) => r.trigger), ['auto', null, 'manual']);
    assert.ok(log.every((r) => r.emitted_bytes <= CP.HOOK_MAX_BYTES));
    assert.ok(log[2].payload_bytes > 5000);
  } finally { cleanup(d); }
});

// ---- afterTurn's guards, on stub records: each one is a case in which a /compact must not be sent.
function stubWorker(over = {}) {
  const writes = [];
  const w = {
    id: 'ws', substrate: 'claude-code', taskId: null, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'belay-stub-')),
    child: { stdin: { destroyed: false, write: (l) => writes.push(l) } }, settled: false, stopRequested: false,
    parkRequested: null, paused: null, turnEnded: true, parser: { noteStdinWrite: () => 7 }, ...over,
  };
  return { w, writes };
}
// The stand-in for worker.cjs's turnStarted: runs the sender synchronously and clears turnEnded.
const turnStarted = (w, ctx, send) => { const sent = send(); w.turnEnded = false; return Promise.resolve({ sent }); };

test('afterTurn sends only between turns: every guard refuses, and only the open case sends', async () => {
  const ctx = { compactAt: 1000, core: null };
  const ev = (o = {}) => ({ kind: 'turn_end', context_tokens: 1500, is_error: false, answers_write: 1, ...o });
  const cases = [
    ['below the lever', {}, ev({ context_tokens: 999 })],
    ['no context known', {}, ev({ context_tokens: null })],
    ['an errored turn', {}, ev({ is_error: true })],
    ['a turn is running (turnEnded false)', { turnEnded: false }, ev()],
    ['settled', { settled: true }, ev()],
    ['stop requested', { stopRequested: true }, ev()],
    ['a park is under way', { parkRequested: { at: 1 } }, ev()],
    ['paused', { paused: { at: 1 } }, ev()],
    ['no live stdin', { child: { stdin: { destroyed: true, write() {} } } }, ev()],
    ['codex', { substrate: 'codex' }, ev()],
  ];
  for (const [name, over, e] of cases) {
    const { w, writes } = stubWorker(over);
    try {
      await CP.afterTurn(w, e, ctx, turnStarted);
      assert.strictEqual(writes.length, 0, name);
    } finally { cleanup(w.dir); }
  }
  const { w, writes } = stubWorker();
  try {
    await CP.afterTurn(w, ev(), ctx, turnStarted);
    assert.strictEqual(writes.length, 1, 'the open case sends');
    const msg = JSON.parse(writes[0]);
    assert.strictEqual(msg.message.content[0].text, `/compact ${CP.INSTRUCTIONS}`);
    assert.strictEqual(w.turnEnded, false, 'and marks the worker mid-turn');
    // While that /compact is in flight a second qualifying turn end sends nothing.
    w.turnEnded = true;
    await CP.afterTurn(w, ev({ answers_write: 99 }), ctx, turnStarted);
    assert.strictEqual(writes.length, 1, 'no second /compact while one is in flight');
    // The turn end that answers it clears the flag; the next qualifying one sends again.
    await CP.afterTurn(w, ev({ answers_write: 7 }), ctx, turnStarted);
    assert.strictEqual(writes.length, 1, 'the answering turn end sends nothing');
    await CP.afterTurn(w, ev(), ctx, turnStarted);
    assert.strictEqual(writes.length, 2);
  } finally { cleanup(w.dir); }
  // A null lever is inert even for the open case.
  const idle = stubWorker();
  try {
    await CP.afterTurn(idle.w, ev(), { compactAt: null }, turnStarted);
    CP.note(idle.w, { kind: 'compact_boundary', at: 1 }, { compactAt: null });
    CP.onAttach(idle.w, { compactAt: null });
    assert.strictEqual(idle.writes.length, 0);
    assert.deepStrictEqual(fs.readdirSync(idle.w.dir), [], 'no file');
    assert.ok(!idle.w.cp, 'no state');
  } finally { cleanup(idle.w.dir); }
});

test('afterTurn refreshes the resume line from the store before it sends, and survives a store failure', async () => {
  const text = '[belay resume] task=T-1 state=open; next: finish the thing';
  const ok = stubWorker({ taskId: 'T-1' });
  const bad = stubWorker({ taskId: 'T-1' });
  try {
    const mk = (fn) => ({ compactAt: 10, core: { continuity: { resumeLine: fn } } });
    await CP.afterTurn(ok.w, { kind: 'turn_end', context_tokens: 50, is_error: false }, mk(async () => ({ text })), turnStarted);
    assert.strictEqual(fs.readFileSync(path.join(ok.w.dir, CP.RESUME_FILE), 'utf8'), text);
    assert.strictEqual(ok.writes.length, 1);
    await CP.afterTurn(bad.w, { kind: 'turn_end', context_tokens: 50, is_error: false }, mk(async () => { throw Object.assign(new Error('store down'), { code: 'E_X' }); }), turnStarted);
    assert.strictEqual(bad.w.lastError.where, 'compaction.resumeLine');
    assert.strictEqual(bad.writes.length, 1, 'a failed refresh does not stop the compaction');
  } finally { cleanup(ok.w.dir); cleanup(bad.w.dir); }
});

test('levers: compact_at_tokens validates, defaults to absent, and reaches the orchestrator adapter\'s argv only when set', () => {
  assert.ok(!('compact_at_tokens' in parseLevers({})), 'absent by default');
  assert.strictEqual(parseLevers({ compact_at_tokens: null }).compact_at_tokens, undefined);
  assert.strictEqual(parseLevers({ compact_at_tokens: 150000 }).compact_at_tokens, 150000);
  for (const bad of [0, -1, 1.5, '150000', true, NaN]) assert.match(parseLevers({ compact_at_tokens: bad }).error, /compact_at_tokens/, String(bad));
  const base = { runId: 'r', dataDir: '/d', mcpPath: '/m.cjs' };
  assert.ok(!L.orchestratorAdapterArgs(base).includes('--compact-at'));
  assert.deepStrictEqual(L.orchestratorAdapterArgs({ ...base, compactAt: 150000 }).slice(-2), ['--compact-at', '150000']);
  const bare = JSON.stringify(L.orchestratorMcpConfig(base));
  assert.ok(!bare.includes('compact'), 'an unset lever leaves mcp.json as it was');
});

test('the adapter refuses a malformed --compact-at before it opens anything', () => {
  for (const v of ['abc', '0', '-5', '1.5']) {
    const r = spawnSync(process.execPath, [MCP, '--role', 'orchestrator', '--run', 'r', '--data', os.tmpdir(), '--compact-at', v], { encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(r.status, 2, v);
    assert.match(r.stderr, /--compact-at must be a positive integer/);
  }
});

test('parser: compact_boundary and call_context events, and last_call_id on turn_end', () => {
  const p = createParser('claude-code');
  const feed = (o) => p.pushChunk(JSON.stringify(o) + '\n').events;
  const asst = (id, input) => ({ type: 'assistant', message: { id, content: [{ type: 'text', text: 't' }], usage: { input_tokens: input, cache_read_input_tokens: 0, output_tokens: 1 } } });
  assert.ok(!feed(asst('m1', 100)).some((e) => e.kind === 'call_context'), 'none before a boundary');
  const b = feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 5, post_tokens: 2, duration_ms: 9 } });
  assert.deepStrictEqual(b.map((e) => [e.kind, e.trigger, e.pre_tokens, e.post_tokens, e.duration_ms]), [['compact_boundary', 'auto', 5, 2, 9]]);
  const first = feed(asst('m2', 40));
  assert.deepStrictEqual(first.filter((e) => e.kind === 'call_context').map((e) => [e.message_id, e.context_tokens]), [['m2', 40]]);
  assert.ok(!feed(asst('m2', 40)).some((e) => e.kind === 'call_context'), 'once per boundary, not per event of the call');
  const end = feed({ type: 'result', subtype: 'success', usage: {}, num_turns: 1 }).find((e) => e.kind === 'turn_end');
  assert.strictEqual(end.last_call_id, 'm2');
  assert.strictEqual(end.context_tokens, 40);
});

