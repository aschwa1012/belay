'use strict';
// one-row-per-turn-real.test.cjs — a turn leaves one row on the real store. With observations on, the observation
// is that row: embedded, tagged and with the provenance of the turn row it replaces, no turn row is written, and
// continuity.resumeDoc still finds the turn through its tags. With observations off the turn row is written as it
// always was, and no observation. The only stand-in is a fixed vector on each store, so no embedding model is needed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createRunManager } = require('../../src/run/index.cjs');
const { openCore } = require('../../src/core/index.cjs');
const { sandbox, cleanup, callerFor } = require('../core/helpers.cjs');

const FAKE = path.join(__dirname, 'fakes', 'fake-claude.cjs').split(path.sep).join('/');

async function twoTurns(levers) {
  const dir = sandbox();
  const core = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  const saved = process.env.FAKE_TOOL_USES;
  process.env.FAKE_TOOL_USES = '1';
  try {
    await core.run.attach({ adapter_pid: process.pid, project: 'acme', memory_levers: JSON.stringify({ project: 'acme', ...levers }) });
    const task = await core.task.create({ spec: 'say something', files_owned: [] });
    const h = core.harness();
    const view = Object.create(h, { memory: { value: { ...h.memory, store: (a) => h.memory.store(a.embed === false ? a : { ...a, embedding: [1, 0], embedding_model: 'fixed', dim: 2 }) } } });
    const wt = path.join(dir, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    const m = createRunManager({ core: view, dataDir: dir, runId: 'test-run', paths: { claudeExe: FAKE, codexExe: FAKE, userSettings: path.join(__dirname, 'fixtures', 'user-settings.json') } });
    try {
      await m.spawn({ substrate: 'claude-code', worktree: wt.split(path.sep).join('/'), prompt: 'one', worker_id: 'w1', task_id: task.id });
      await m._waitTurn('w1', 8000);
      await m.message({ worker_id: 'w1', text: 'two' });
      await m._waitTurn('w1', 8000);
      await m._worker('w1').memoryQueue;
    } finally { try { await m.shutdown(); } catch { /* best effort */ } }
    const rows = (await core.memory.list({ namespace: 'run/test-run', view: 'full', order: 'oldest', limit: 50 })).rows;
    const resume = await core.continuity.resumeDoc({ task_id: task.id });
    const embedded = {};
    for (const r of rows) embedded[r.id] = !!(await core.memory.get({ id: r.id, view: 'full' })).has_embedding;
    return { rows, taskId: task.id, resume, embedded, events: (await core.memory.events({})).events };
  } finally {
    if (saved === undefined) delete process.env.FAKE_TOOL_USES; else process.env.FAKE_TOOL_USES = saved;
    try { await core.shutdownOwner(); } catch { /* best effort */ }
    await core.close();
    cleanup(dir);
  }
}

test('observations on: one row per turn, the observation, embedded, with the turn tags; resumeDoc finds it', { timeout: 60000 }, async () => {
  const { rows, taskId, resume, embedded, events } = await twoTurns({ capture: true, observations: true });
  assert.deepStrictEqual(rows.map((r) => r.type), ['observation', 'observation'], 'two turns, two rows, no turn row');
  rows.forEach((r, i) => {
    assert.deepStrictEqual(r.tags, [taskId, 'w1', `turn:${i + 1}`]);
    assert.match(r.provenance, /^checkpoint:/);
    assert.strictEqual(r.written_by, 'harness');
    assert.strictEqual(r.source, 'harness');
    assert.strictEqual(embedded[r.id], true, 'the observation is the turn\'s embedded row');
    assert.strictEqual(r.text.split('\n')[1].startsWith('worker-stated: echo: '), true, 'the narrative follows the title');
  });
  const doc = typeof resume === 'string' ? resume : resume.text;
  assert.match(doc, new RegExp(`recent memory rows tagged ${taskId}`));
  assert.match(doc, /\[w1\] turn 2: .*worker-stated: echo: /, 'the newest turn is listed from its observation');
  assert.strictEqual(events.filter((e) => e.kind === 'observation' && e.ok === 1).length, 2);
});

test('observations off: the turn row is written as before, embedded, and there is no observation', { timeout: 60000 }, async () => {
  const { rows, taskId, embedded } = await twoTurns({ cost_ledger: true });
  assert.deepStrictEqual(rows.filter((r) => r.type !== 'turn'), [], 'only turn rows (a job lever is on, observations are not)');
  assert.strictEqual(rows.length, 2);
  rows.forEach((r, i) => {
    assert.deepStrictEqual(r.tags, [taskId, 'w1', `turn:${i + 1}`]);
    assert.strictEqual(embedded[r.id], true);
    assert.match(r.text, /^echo: /);
  });
});
