'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env);
// notices-searchlog.test.cjs — the retrieval failures only the search log records (a reranker that failed mid-run, a heavy tier that fell behind,
// an embedder that died, a refused search) are notices: pure over log rows, and through the built CLI over a planted store.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { openCore } = require('../../src/core/index.cjs');
const { searchLogEvents } = require('../../src/cli/notices-searchlog.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const RUN = 'run-sl';
const row = (seq, at, failed) => ({ seq, written_at: at, message: JSON.stringify({ v: 1, fallback: failed ? { failed } : null }) });

test('searchLogEvents: one event per failed stage and code, counted, with what belay did and the next step; a clean search says nothing', () => {
  const rr = { mode: 'rerank', code: 'E_RERANK', message: 'the rerank stage failed (timeout)' };
  const ev = searchLogEvents([row(1, 1000, null), row(2, 2000, [rr]), row(3, 3000, [rr]),
    row(4, 4000, [{ mode: 'heavy_behind', code: 'E_TIER_BEHIND', message: '74 notes are not yet embedded' }]),
    row(5, 5000, [{ mode: 'semantic', code: 'E_MODEL_ABSENT', message: 'the embedder process exited' }, { mode: 'refused', code: 'E_SEMANTIC_REQUIRED', message: 'paused' }])], RUN);
  assert.deepStrictEqual(ev.map((e) => e.kind).sort(), ['search_heavy_behind_failed', 'search_refused_failed', 'search_rerank_failed', 'search_semantic_failed']);
  const r = ev.find((e) => e.stage === 'rerank');
  assert.strictEqual(r.searches, 2);
  assert.strictEqual(r.ts, 2000);
  assert.strictEqual(r.last_ts, 3000);
  assert.match(r.text, /2 searches .*rerank stage fail.*E_RERANK.*fusion order/);
  assert.ok(r.options.length === 1 && r.retrieval === true && r.run_id === RUN);
  assert.match(ev.find((e) => e.stage === 'semantic').text, /keyword half only/);
  assert.match(ev.find((e) => e.stage === 'refused').text, /1 search in this run had a refusal.*E_SEMANTIC_REQUIRED/);
  assert.deepStrictEqual(searchLogEvents([row(1, 1, null)], RUN), []);
  assert.deepStrictEqual(searchLogEvents([{ seq: 1, written_at: 1, message: 'not json' }], RUN), []);
});

test('searchLogEvents: the heavy fallback in force on the run row is not told twice', () => {
  const rows = [row(1, 1, [{ mode: 'heavy_embed', code: 'E_X', message: 'down' }])];
  assert.strictEqual(searchLogEvents(rows, RUN).length, 1);
  assert.strictEqual(searchLogEvents(rows, RUN, { heavyFallbackInRow: true }).length, 0);
});

test('notices through the CLI: a failed stage and a refusal in the run\'s search log are notices', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    try { await orch.run.attach({ adapter_pid: process.pid }); } finally { await orch.shutdownOwner(); await orch.close(); }
    const db = new DatabaseSync(`${dataDir}/memory.db`);
    try {
      const ins = db.prepare("INSERT INTO memory_event(id, run_id, kind, ok, code, message, bytes, written_at, written_by) VALUES (?, ?, 'search', ?, ?, ?, 1, ?, 'orchestrator')");
      const now = Date.now();
      ins.run('me-1', RUN, 1, null, row(0, 0, [{ mode: 'rerank', code: 'E_RERANK', message: 'timeout' }]).message, now - 2000);
      ins.run('me-2', RUN, 0, 'E_PAUSED', row(0, 0, [{ mode: 'refused', code: 'E_PAUSED', message: 'run is paused' }]).message, now - 1000);
      ins.run('me-3', 'another-run', 1, null, row(0, 0, [{ mode: 'rerank', code: 'E_RERANK', message: 'x' }]).message, now - 500);
    } finally { db.close(); }
    const r = spawnSync(process.execPath, [CLI, 'notices', RUN, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const kinds = JSON.parse(r.stdout).events.map((e) => e.kind).filter((k) => k.startsWith('search_')).sort();
    assert.deepStrictEqual(kinds, ['search_refused_failed', 'search_rerank_failed'], 'only this run\'s rows');
  } finally { cleanup(dir); }
});
