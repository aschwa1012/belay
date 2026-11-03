'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env);
// notices-searchlog.test.cjs — the retrieval failures only the search log records (a reranker that failed mid-run, a heavy tier that fell behind,
// an embedder that died, a refused search) are notices: pure over log rows, and through the built CLI over a planted store.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { openCore } = require('../../src/core/index.cjs');
const { searchLogEvents, searchLogOffEvents } = require('../../src/cli/notices-searchlog.cjs');
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

test('searchLogEvents: only the heavy failure the run row already tells is left out; a different code is named', () => {
  const rows = [row(1, 1, [{ mode: 'heavy_embed', code: 'E_X', message: 'down' }]), row(2, 2, [{ mode: 'heavy_embed', code: 'E_Y', message: 'other' }])];
  assert.strictEqual(searchLogEvents(rows, RUN).length, 2);
  const left = searchLogEvents(rows, RUN, { heavyFallbackCodes: ['E_X'] });
  assert.deepStrictEqual(left.map((e) => e.code), ['E_Y']);
});

test('searchLogOffEvents: a run whose search log was off says so once; one with it on says nothing', () => {
  for (const lv of [null, '{}', '{"notes":true}', { search_log: false }]) {
    const ev = searchLogOffEvents({ id: RUN, seq: 3, started_at: 5, memory_levers: lv });
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].kind, 'search_log_off');
    assert.match(ev[0].text, /search log was off for this run.*not recorded/);
    assert.match(ev[0].options[0], /belay settings memory.search_log true/);
  }
  assert.deepStrictEqual(searchLogOffEvents({ id: RUN, seq: 3, memory_levers: '{"search_log":true}' }), []);
  assert.deepStrictEqual(searchLogOffEvents({ id: RUN, seq: 3, memory_levers: { search_log: true } }), []);
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
    assert.deepStrictEqual(kinds, ['search_log_off', 'search_refused_failed', 'search_rerank_failed'], 'only this run\'s rows');
  } finally { cleanup(dir); }
});

test('notices through the CLI: a log of many clean searches is filtered in SQL, so only the failed rows are read', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    try { await orch.run.attach({ adapter_pid: process.pid }); } finally { await orch.shutdownOwner(); await orch.close(); }
    const db = new DatabaseSync(`${dataDir}/memory.db`);
    const clean = JSON.stringify({ v: 1, query: 'q'.repeat(3000), fallback: null });
    try {
      const ins = db.prepare("INSERT INTO memory_event(id, run_id, kind, ok, code, message, bytes, written_at, written_by) VALUES (?, ?, 'search', ?, ?, ?, 1, ?, 'orchestrator')");
      db.exec('BEGIN');
      for (let i = 0; i < 20000; i++) ins.run(`c-${i}`, RUN, 1, null, clean, i);
      ins.run('f-1', RUN, 1, null, row(0, 0, [{ mode: 'semantic', code: 'E_MODEL_ABSENT', message: 'gone' }]).message, 30000);
      db.exec('COMMIT');
    } finally { db.close(); }
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [CLI, 'notices', RUN, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    const ms = Date.now() - t0; // recorded beside the gate, never asserted (ADR 0018)
    assert.strictEqual(r.status, 0, r.stderr);
    const ev = JSON.parse(r.stdout).events.filter((e) => e.kind === 'search_semantic_failed');
    assert.strictEqual(ev.length, 1, `wall ${ms} ms`);
    assert.strictEqual(ev[0].searches, 1);
    const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'x', pid: process.pid }, embed: false });
    try {
      const { events } = await core.memory.events({ run_id: RUN, kinds: ['search'], search_failures: true });
      assert.strictEqual(events.length, 1, 'the filter ran in SQL: 20000 clean rows were not returned');
    } finally { await core.shutdownOwner().catch(() => {}); await core.close(); }
  } finally { cleanup(dir); }
});
