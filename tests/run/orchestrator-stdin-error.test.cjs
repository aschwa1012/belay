'use strict';
// A write to an orchestrator whose stdin pipe is already broken fails as an asynchronous 'error' event on the
// parent's stream. With no listener Node crashes the run process; with one, the exit handler still settles the run.
// The seam forces the interleaving: the real spawn is wrapped so the prompt write destroys stdin with EPIPE on the
// next tick, while the child (a substrate that never becomes ready) is still alive and its 'exit' has not been seen.

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

test('a prompt write that hits a broken stdin pipe does not crash the run, which ends on the ready failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-orch-stdin-'));
  fs.mkdirSync(path.join(root, 'wt'));
  fs.mkdirSync(path.join(root, '.belay'));
  const core = createFakeCore();
  core.worker = { ...core.worker, list: async () => ({ workers: [] }) };
  const realSpawn = P.spawnWorker;
  P.spawnWorker = (opts) => {
    const child = realSpawn(opts);
    child.stdin.write = () => {
      process.nextTick(() => child.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      return true;
    };
    return child;
  };
  const saved = process.env.BELAY_CLAUDE_EXE;
  process.env.BELAY_CLAUDE_EXE = NOREADY;
  try {
    const result = await runOrchestrator({
      core, runId: 'run-se', dataDir: fwd(path.join(root, '.belay')),
      spec: {
        worktree: fwd(path.join(root, 'wt')), promptText: 'hello', orchestratorDir: fwd(path.join(root, 'orch')), model: 'claude-sonnet-5',
        allowedTools: null, startupTimeoutMs: 8000, timeoutMs: 0, mcpToolTimeoutMs: 60000, pollMs: 100, closeGraceMs: 3000,
      },
      onAttached: async () => ({ ok: true }),
    });
    assert.ok(result, 'the run settled with a result');
  } finally {
    P.spawnWorker = realSpawn;
    if (saved === undefined) delete process.env.BELAY_CLAUDE_EXE; else process.env.BELAY_CLAUDE_EXE = saved;
    cleanup(root);
  }
});
