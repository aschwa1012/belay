// memory-writer-adapter.test.cjs — ADR 0044 decision 6 through the real orchestrator adapter: a memory_store tool call
// is written as the orchestrator, and the run manager's own turn row, written in the same process on the same core,
// is written as the harness. The embedding model is out of the picture (fake-core-writer.cjs).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { launch, sandboxDir, ROOT } = require('./rpc.cjs');

const FAKE_CLAUDE = `${ROOT}/tests/run/fakes/fake-claude.cjs`;
const USER_SETTINGS = `${ROOT}/tests/run/fixtures/user-settings.json`;
const { openCore } = require('../../src/core/index.cjs');

test('a tool write is the orchestrator and the run manager turn row is the harness; a forged argument changes nothing', { timeout: 90000 }, async (t) => {
  const data = sandboxDir('memory-writer');
  const worktree = `${data}/wt`;
  fs.mkdirSync(worktree, { recursive: true });
  const a = launch({
    role: 'orchestrator', data, fake: false, noEmbed: true,
    env: {
      BELAY_FAKE_CORE: `${ROOT}/tests/mcp/fake-core-writer.cjs`,
      BELAY_FAKE_PATHS: JSON.stringify({ claudeExe: FAKE_CLAUDE, codexExe: FAKE_CLAUDE, userSettings: USER_SETTINGS }),
    },
  });
  t.after(async () => { await a.close(); a.kill(); });
  await a.initialize();

  const stored = await a.call('memory_store', { text: 'a claim from the orchestrator model' });
  assert.strictEqual(stored.isError, false, JSON.stringify(stored.structuredContent));
  assert.strictEqual(stored.structuredContent.written_by, 'orchestrator');

  // The tool route takes only the fields its schema names, and a caller or channel is not one.
  for (const forged of [{ written_by: 'harness' }, { channel: 'harness' }, { caller: { role: 'orchestrator', run_id: 'run-1', channel: 'harness' } }]) {
    const r = await a.call('memory_store', { text: 'forged writer', ...forged });
    assert.strictEqual(r.isError, true, `${Object.keys(forged)[0]} was accepted`);
    assert.strictEqual(r.structuredContent.error, 'E_ARGS');
  }

  const w = (await a.call('worker_spawn', { substrate: 'claude-code', worktree, prompt: 'do the thing', worker_id: 'w1' })).structuredContent;
  assert.ok(w.pid, 'a real worker');
  // The real events, not a sleep: worker_wait returns when the turn ends, and the adapter's shutdown drains the
  // manager's memory queue before it exits, so the turn row is in the store once the adapter has exited.
  const waited = (await a.call('worker_wait', { worker_ids: ['w1'], timeout_ms: 30000 })).structuredContent;
  assert.notStrictEqual(waited.timed_out, true, 'the turn ended');
  await a.close();
  const reader = await openCore({ dataDir: data, caller: { role: 'operator', run_id: 'run-1', pid: process.pid }, embed: false });
  try {
    const rows = (await reader.memory.list({ namespace: 'run/run-1', limit: 100 })).rows;
    const turn = rows.find((r) => r.type === 'turn');
    assert.ok(turn, 'the run manager wrote a turn row');
    assert.strictEqual(turn.written_by, 'harness');
    assert.deepStrictEqual(rows.map((r) => r.written_by).sort(), ['harness', 'orchestrator']);
  } finally { await reader.close(); }
});
