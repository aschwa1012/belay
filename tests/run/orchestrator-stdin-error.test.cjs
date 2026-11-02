'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// A write to an orchestrator whose stdin pipe is already broken fails as an asynchronous 'error' event on the
// parent's stream. With no listener Node crashes the run process; with one, the exit handler still settles the run,
// and a later write is refused instead of being recorded as written. The seam forces the interleaving: the real
// spawn is wrapped so the chosen write destroys stdin, which marks it destroyed at once and emits EPIPE on the next tick.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = require('../../src/run/process.cjs');
const { runOrchestrator } = require('../../src/run/orchestrator.cjs');
const { createFakeCore } = require('./fake-core.cjs');
const { cleanup } = require('../core/helpers.cjs');

const fwd = (p) => String(p).split(path.sep).join('/');
const NOREADY = fwd(path.join(__dirname, 'fakes', 'fake-claude-noready.cjs'));
const FAKE = fwd(path.join(__dirname, 'fakes', 'fake-claude.cjs'));

// Runs one orchestrator over `exe` with its `failOn`th stdin write replaced by an EPIPE (earlier ones are real);
// returns the run result and how many times the wrapped write ran.
async function runWithBrokenPipe(exe, failOn, coreOverrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-orch-stdin-'));
  fs.mkdirSync(path.join(root, 'wt'));
  fs.mkdirSync(path.join(root, '.belay'));
  const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };
  Object.assign(core, coreOverrides || {});
  const realSpawn = P.spawnWorker;
  const seen = { writes: 0 };
  P.spawnWorker = (opts) => {
    const child = realSpawn(opts);
    const realWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (...a) => {
      seen.writes += 1;
      if (seen.writes < failOn) return realWrite(...a);
      child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      return true;
    };
    return child;
  };
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = exe;
  try {
    const result = await runOrchestrator({
      core, runId: 'run-se', dataDir: fwd(path.join(root, '.belay')),
      spec: {
        worktree: fwd(path.join(root, 'wt')), promptText: 'hello', orchestratorDir: fwd(path.join(root, 'orch')), model: 'claude-sonnet-5',
        allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 20000, mcpToolTimeoutMs: 60000, pollMs: 50, closeGraceMs: 3000,
      },
      onAttached: async () => ({ ok: true }),
    });
    return { result, seen };
  } finally {
    P.spawnWorker = realSpawn;
    if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved;
    cleanup(root);
  }
}

test('a prompt write that hits a broken stdin pipe does not crash the run, which ends on the ready failure', async () => {
  // The noready fake exits at once, so its 'exit' may not have been seen when the write is made.
  const { result, seen } = await runWithBrokenPipe(NOREADY, 1);
  assert.strictEqual(seen.writes, 1, 'the replaced write ran exactly once');
  assert.match(result.ended_by, /before a ready event/);
  assert.strictEqual(result.orchestrator.stdin_error.code, 'EPIPE');
});

test('a wake after the pipe broke is refused and not recorded as written', async () => {
  const startedAt = Date.now();
  let reads = 0;
  const mk = (k) => [
    { id: `d-${k}`, seq: 1, kind: 'call_detached', key: k, ok: 1, row_ids: ['t1'], message: JSON.stringify({ tool: 'task_evaluate', started_at: startedAt }) },
    { id: `e-${k}`, seq: 2, kind: 'call_ended', key: k, ok: 1, row_ids: ['t1'], message: '{}' },
  ];
  const base = createFakeCore();
  const { result, seen } = await runWithBrokenPipe(FAKE, 2, {
    memory: { ...(base.memory || {}), events: async () => { reads += 1; return { events: reads < 6 ? [mk('k1')[0], mk('k2')[0]] : [...mk('k1'), ...mk('k2')] }; } },
    task: { ...(base.task || {}), list: async () => ({ tasks: [] }), get: async () => ({ id: 't1', run_id: 'run-se', state: 'open', results: { evaluated_at: startedAt + 5, passed: true, executable: true, checks: [] } }) },
  });
  assert.strictEqual(seen.writes, 2, 'the prompt was real, the first wake hit the broken pipe, and the second wake never reached the stream');
  assert.ok(reads >= 6, `the calls ended while the run was still open (${reads} ledger reads)`);
  assert.strictEqual(result.wakes.length, 1, `only the wake written before the pipe broke is recorded: ${JSON.stringify(result.wakes)}`);
  assert.strictEqual(result.wakes_suppressed.length, 1);
  assert.match(result.wakes_suppressed[0].reason, /stdin was broken/);
});
