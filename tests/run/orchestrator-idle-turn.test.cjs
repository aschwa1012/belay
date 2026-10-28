'use strict';
// orchestrator-idle-turn.test.cjs — an idle hold names the turn whose end began the idle period. Two turn ends can arrive in one
// chunk while a poll read is in flight; the next poll must not stamp the hold with the later turn. The read is stalled by the
// test (no timing): the fake core's worker.list waits on a promise the test releases once both results are in the stream.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));
const RUN = 'run-idle-turn';

const resultLines = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('"type":"result"')).length; } catch { return 0; } };

test('two turn ends in one chunk behind a stalled read: the hold names turn 1', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-idle-turn-'));
  const sb = { worktree: fwd(path.join(root, 'wt')), dataDir: fwd(path.join(root, '.belay')), orchestratorDir: fwd(path.join(root, 'orch')) };
  fs.mkdirSync(sb.worktree, { recursive: true });
  fs.mkdirSync(sb.dataDir, { recursive: true });
  const core = createFakeCore();
  let busy = true;
  let release; const released = new Promise((r) => { release = r; });
  let stalled = null; let listCalls = 0;
  const row = () => ({ id: 'w-hold', run_id: RUN, state: 'running', turns: 0, seq: 2, pid: process.pid, pid_alive: true, mid_turn: busy ? 1 : 0 });
  core.worker = { ...core.worker, list: async () => {
    listCalls += 1;
    if (listCalls === 1) { stalled = Date.now(); await released; } // the read the ready event starts
    return { workers: [row()] };
  } };
  const saved = { exe: process.env.BELAY_CLAUDE_EXE, extra: process.env.FAKE_EXTRA_INIT };
  process.env.BELAY_CLAUDE_EXE = FAKE;
  process.env.FAKE_EXTRA_INIT = '1';
  const streamPath = `${sb.orchestratorDir}/stream.jsonl`;
  const watcher = (async () => {
    const limit = Date.now() + 40000;
    while (resultLines(streamPath) < 2 && Date.now() < limit) await new Promise((r) => setTimeout(r, 25));
    const seen = resultLines(streamPath);
    // No margin is needed: the stream line is written and its events are handled in one synchronous data handler, so a timer that sees both
    // results in the file runs after the chunk's events were dispatched.
    release();
    // the hold is recorded by a later poll; once it is, the worker is no longer busy and the run may close
    const until = Date.now() + 20000;
    while (listCalls < 4 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    busy = false;
    return seen;
  })();
  try {
    const out = await runOrchestrator({ core, runId: RUN, dataDir: sb.dataDir, onAttached: async () => ({ ok: true }), spec: {
      worktree: sb.worktree, promptText: 'hello', orchestratorDir: sb.orchestratorDir, model: 'claude-sonnet-5', allowedTools: null,
      startupTimeoutMs: 8000, timeoutMs: 50000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
    } });
    assert.ok(stalled, 'the ready event started a read');
    assert.strictEqual(await watcher, 2, 'both results reached the stream while the first read was stalled');
    assert.strictEqual(out.orchestrator.turns, 2, JSON.stringify(out.orchestrator));
    const first = out.holds.find((h) => Array.isArray(h.busy) && h.busy.includes('w-hold'));
    assert.ok(first, `a hold recorded the busy worker: ${JSON.stringify(out.holds)}`);
    assert.strictEqual(first.turn, 1, `the hold names the turn whose end began the idle period: ${JSON.stringify(out.holds)}`);
  } finally {
    release();
    for (const [k, v] of [['BELAY_CLAUDE_EXE', saved.exe], ['FAKE_EXTRA_INIT', saved.extra]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanup(root);
  }
});
