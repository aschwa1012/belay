'use strict';
// memory-views.test.cjs — ADR 0043 decision 3, the read-only memory views: additive `belay diff` fields,
// `belay logs --memory`, a wrap-up in `belay notices`, and the doctor's `memory-index` rung. Everything runs
// the built CLI as a subprocess against a sandbox store planted through the core; nothing here touches the
// repository's own store. The three doctor states are planted by writing the `meta` marker the way an owner
// would (or leaving it out).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { openCore } = require('../../src/core/index.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const RUN = 'run-mv';
const vec = (seed) => Array.from({ length: 384 }, (_, i) => (((i + seed) % 7) + 1) / 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(cmd, args, dataDir) {
  return spawnSync(process.execPath, [CLI, cmd, ...args, '--data', dataDir, '--json'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

function listDir(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else out.push(p.slice(dir.length)); } };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

async function plantRows(dataDir) {
  const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
  let worker;
  try {
    await orch.run.attach({ adapter_pid: process.pid });
    const before = await orch.memory.store({ namespace: `run/${RUN}`, text: 'a decision made before the mark', type: 'decision', embedding: vec(0), embedding_model: 'fixture', dim: 384 });
    await sleep(25);
    const markMs = Date.now();
    await sleep(25);
    await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: markMs - 1000 });
    worker = await openCore({ dataDir, caller: { role: 'worker', worker_id: 'w1', run_id: RUN, pid: process.pid }, embed: false });
    const a = await worker.memory.store({ namespace: `run/${RUN}`, text: 'w1 found the parser skips blank lines', type: 'finding', embedding: vec(1), embedding_model: 'fixture', dim: 384 });
    const b = await worker.memory.store({ namespace: `run/${RUN}`, text: 'w1 observation: ran the suite', type: 'observation', embedding: vec(2), embedding_model: 'fixture', dim: 384 });
    const ev = await orch.memory.recordEvent({ kind: 'observation', worker_id: 'w1', task_id: 't-1', row_ids: [b.id], newest_row_id: b.id });
    const wrap = await orch.memory.recordEvent({ kind: 'wrapup', key: 'task:t-1', task_id: 't-1', worker_id: 'w1', bytes: 31, message: 'task t-1 done, 2 files, summary mem-x' });
    const run = await orch.memory.recordEvent({ kind: 'wrapup', key: 'run', message: 'run finished: 1 task done' });
    const usage = await orch.usage.record({ worker_id: 'w1', task_id: 't-1', turn: 1, substrate: 'claude-code', model: 'm', input_tokens: 10, output_tokens: 5, cost_usd: 0.01, cost_basis: 'delta-of-cumulative' });
    return { markMs, before, a, b, ev, wrap, run, usage };
  } finally {
    if (worker) await worker.close();
    await orch.shutdownOwner(); await orch.close();
  }
}

async function plant(dataDir) {
  const p = await plantRows(dataDir);
  markVerified(dataDir, p.a.id);
  return p;
}

// The status column is written the way setStatus would, straight into the sandbox store once its owner is gone.
function markVerified(dataDir, id) {
  const db = new DatabaseSync(`${dataDir}/memory.db`);
  try { db.prepare("UPDATE memory_entries SET status = 'verified', status_receipt = 'test:planted', status_by = 'operator', status_at = ?, updated_at = ? WHERE id = ?").run(Date.now(), Date.now(), id); }
  finally { db.close(); }
}

test('diff: additive memory_ledger with counts by type and status and the ledger rows since the mark; counts.memory and tables are unchanged in shape', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const p = await plant(dataDir);
    const r = cli('diff', [RUN, '--since', String(p.markMs)], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual(Object.keys(j.counts.memory).sort(), ['added', 'expired', 'superseded', 'updated'], 'counts.memory keeps its four keys');
    assert.ok(!('memory_event' in j.tables) && !('usage' in j.tables), 'the ledger tables are not added to tables');
    const m = j.memory_ledger;
    assert.deepStrictEqual(m.by_type, { finding: 1, observation: 1 }, 'the row from before the mark is not counted');
    assert.deepStrictEqual(m.by_status, { unverified: 1, verified: 1 });
    assert.strictEqual(m.events.count, 3);
    assert.deepStrictEqual(m.events.rows.map((e) => e.id), [p.ev.id, p.wrap.id, p.run.id]);
    assert.deepStrictEqual(m.events.rows[0].row_ids, [p.b.id], 'row_ids come back parsed');
    assert.strictEqual(m.events.truncated, false);
    assert.strictEqual(m.usage.count, 1);
    assert.strictEqual(m.usage.rows[0].id, p.usage.id);
    // A mark after everything: empty, not absent.
    const later = JSON.parse(cli('diff', [RUN, '--since', String(Date.now() + 1000)], dataDir).stdout).memory_ledger;
    assert.deepStrictEqual(later.by_type, {});
    assert.strictEqual(later.events.count, 0);
    assert.strictEqual(later.usage.count, 0);
  } finally { cleanup(dir); }
});

test('diff: a store with no memory.db answers an empty ledger and creates no file', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const r = cli('diff', ['--all'], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    const m = JSON.parse(r.stdout).memory_ledger;
    assert.deepStrictEqual(m, { by_type: {}, by_status: {}, events: { count: 0, truncated: false, rows: [] }, usage: { count: 0, truncated: false, rows: [] } });
    assert.deepStrictEqual(listDir(dataDir), []);
  } finally { cleanup(dir); }
});

test('logs --memory: the worker\'s own rows (index view) and events, ordered by time after the tail; other workers\' items and the default form are untouched; reading writes nothing', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const p = await plant(dataDir);
    const sp = `${dataDir}/workers/w1/stream.jsonl`;
    fs.mkdirSync(`${dataDir}/workers/w1`, { recursive: true });
    fs.writeFileSync(sp, '{"line":1}\n{"line":2}\n');
    const before = listDir(dataDir);
    const plain = JSON.parse(cli('logs', ['w1'], dataDir).stdout);
    assert.ok(!('memory' in plain), 'without --memory the receipt has no memory field');

    const r = cli('logs', ['w1', '--memory'], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual(j.lines, ['{"line":1}', '{"line":2}']);
    const ids = j.memory.items.map((x) => x.id);
    assert.ok(ids.includes(p.a.id) && ids.includes(p.b.id) && ids.includes(p.ev.id) && ids.includes(p.wrap.id));
    assert.ok(!ids.includes(p.before.id), 'a row written by another caller is not w1\'s');
    assert.ok(!ids.includes(p.run.id), 'the run-level wrap-up names no worker');
    const times = j.memory.items.map((x) => x.at);
    assert.deepStrictEqual(times, [...times].sort((x, y) => x - y), 'oldest first');
    const row = j.memory.items.find((x) => x.id === p.a.id);
    assert.deepStrictEqual([row.kind, row.type, row.status], ['row', 'finding', 'verified']);
    assert.strictEqual(row.title, 'w1 found the parser skips blank lines');
    assert.ok(!('text' in row) && !('body' in row), 'index view only');

    const text = cli('logs', ['w1', '--memory'], dataDir);
    assert.strictEqual(text.status, 0);
    const t = spawnSync(process.execPath, [CLI, 'logs', 'w1', '--memory', '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.match(t.stdout, /-- memory: 4 item\(s\)/);
    assert.match(t.stdout, /memory row [0-9a-f-]{36} finding\/verified w1 found the parser/);
    assert.match(t.stdout, /memory event wrapup ok key task:t-1/);
    assert.ok(t.stdout.indexOf('{"line":2}') < t.stdout.indexOf('-- memory'), 'the tail comes first');
    assert.deepStrictEqual(listDir(dataDir), before, 'no file appeared or went away');
  } finally { cleanup(dir); }
});

test('logs: --memory is a known flag and the usage text names it', () => {
  const dir = sandbox();
  try {
    const r = cli('logs', ['w1', '--bogus'], `${dir}/.belay`);
    assert.strictEqual(r.status, 2);
    assert.match(r.stdout + r.stderr, /unknown option --bogus/);
    const t = spawnSync(process.execPath, [CLI, 'logs', '--bogus', '--data', `${dir}/.belay`], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.match(t.stdout + t.stderr, /\[--memory\]/);
  } finally { cleanup(dir); }
});

test('notices: each wrap-up shows once, in time order with the other events, carrying its key, text and the event it came from; none when the ledger has none', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const p = await plant(dataDir);
    const j = JSON.parse(cli('notices', [RUN], dataDir).stdout);
    const wraps = j.events.filter((e) => e.kind === 'memory_wrapup');
    assert.deepStrictEqual(wraps.map((e) => e.key), ['task:t-1', 'run']);
    assert.strictEqual(wraps[0].text, 'task t-1 done, 2 files, summary mem-x');
    assert.strictEqual(wraps[0].task_id, 't-1');
    assert.strictEqual(wraps[0].source, `memory_event ${p.wrap.id}`);
    assert.strictEqual(wraps[0].ok, true);
    assert.strictEqual(j.events.filter((e) => e.source === `memory_event ${p.ev.id}`).length, 0, 'only wrap-ups, not every ledger event');
    // A second read shows the same two, not four: the view is a pure read of the ledger.
    const again = JSON.parse(cli('notices', [RUN], dataDir).stdout);
    assert.strictEqual(again.events.filter((e) => e.kind === 'memory_wrapup').length, 2);
    // The store refuses a second wrap-up for a key, so nothing could show twice.
    const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    try {
      await assert.rejects(orch.memory.recordEvent({ kind: 'wrapup', key: 'run', message: 'again' }), (e) => e.code === 'E_EXISTS');
    } finally { await orch.shutdownOwner(); await orch.close(); }
    const text = spawnSync(process.execPath, [CLI, 'notices', RUN, '--data', dataDir], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
    assert.match(text.stdout, /memory_wrapup\s+key task:t-1 task t-1 done/);
  } finally { cleanup(dir); }

  const dir2 = sandbox();
  try {
    const orch = await openCore({ dataDir: `${dir2}/.belay`, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    try { await orch.run.attach({ adapter_pid: process.pid }); } finally { await orch.shutdownOwner(); await orch.close(); }
    const j = JSON.parse(cli('notices', [RUN], `${dir2}/.belay`).stdout);
    assert.deepStrictEqual(j.events.filter((e) => e.kind === 'memory_wrapup'), []);
  } finally { cleanup(dir2); }
});

test('notices: a failed wrap-up shows its code instead of text', () => {
  const N = require('../../src/cli/cmd-notices.cjs');
  const out = N.wrapupEvents([
    { id: 'me-1', kind: 'wrapup', key: 'run', ok: 0, code: 'E_SUMMARY_OVER_BUDGET', written_at: 5 },
    { id: 'me-2', kind: 'wrapup', key: 'run', ok: 1, message: 'dup', written_at: 6 },
    { id: 'me-3', kind: 'observation', key: null, ok: 1, written_at: 7 },
  ], 'r');
  assert.strictEqual(out.length, 1, 'a repeated key and a non-wrap-up kind are dropped');
  assert.deepStrictEqual([out[0].ok, out[0].code, out[0].ts], [false, 'E_SUMMARY_OVER_BUDGET', 5]);
});

test('doctor memory-index: absent before any owner has built the index, present after, unsupported when the owner recorded no FTS5; always read from a copy', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const rung = () => {
    const r = cli('doctor', [], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).checks.find((c) => c.check === 'memory-index');
  };
  try {
    // no store at all
    let c = rung();
    assert.strictEqual(c.state, 'absent');
    assert.strictEqual(c.verdict, 'missing');
    assert.match(c.evidence, /^absent \(no owner has opened this store since the index landed\)/);
    assert.deepStrictEqual(listDir(dataDir), [], 'doctor created nothing');

    // an owner has opened the store: the index is built
    const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    try { await orch.run.attach({ adapter_pid: process.pid }); } finally { await orch.shutdownOwner(); await orch.close(); }
    const sizeBefore = fs.statSync(`${dataDir}/memory.db`).size;
    const filesBefore = listDir(dataDir);
    c = rung();
    assert.strictEqual(c.state, 'present');
    assert.strictEqual(c.verdict, 'ok');
    assert.deepStrictEqual(listDir(dataDir), filesBefore, 'the read left no sidecar behind');
    assert.strictEqual(fs.statSync(`${dataDir}/memory.db`).size, sizeBefore);

    // an owner that found no FTS5 records '0'
    let db = new DatabaseSync(`${dataDir}/memory.db`);
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'memory_fts_version'").run();
    db.close();
    c = rung();
    assert.strictEqual(c.state, 'unsupported');
    assert.match(c.evidence, /^unsupported \(FTS5 not compiled\)/);
    assert.strictEqual(c.verdict, 'error');

    // a store no current owner has touched: the marker is missing
    db = new DatabaseSync(`${dataDir}/memory.db`);
    db.prepare("DELETE FROM meta WHERE key = 'memory_fts_version'").run();
    db.close();
    c = rung();
    assert.strictEqual(c.state, 'absent');
    assert.match(c.evidence, /^absent \(no owner has opened this store/);
  } finally { cleanup(dir); }
});
