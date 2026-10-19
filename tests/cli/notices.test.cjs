'use strict';
// notices.test.cjs — ADR 0036 decision 5, build step U1. Drives the built CLI's `notices` as a
// subprocess against a sandbox store planted through the core; the verdict and run-state events are
// also checked as pure functions over row-shaped input. Never a real data dir.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const N = require('../../src/cli/cmd-notices.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const RUN = 'run-n';

function cli(args, dataDir, { json = true } = {}) {
  return spawnSync(process.execPath, [CLI, 'notices', ...args, '--data', dataDir, ...(json ? ['--json'] : [])], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

async function plant(dataDir, { end = false } = {}) {
  const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
  let worker;
  try {
    await orch.run.attach({ adapter_pid: process.pid });
    const now = Date.now();
    // w1: mid-turn and silent for ten minutes, its process alive (this one)
    await orch.worker.write({ id: 'w1', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: now - 700000, mid_turn: 1, last_event_at: now - 600000 });
    // w4: running, mid-turn, but heard from a minute ago: not a stall
    await orch.worker.write({ id: 'w4', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: now - 700000, mid_turn: 1, last_event_at: now - 60000 });
    // w5: old last event but not mid-turn: not a stall
    await orch.worker.write({ id: 'w5', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: now - 700000, mid_turn: 0, last_event_at: now - 600000 });
    await orch.worker.write({ id: 'w2', substrate: 'claude-code', pid: process.pid, state: 'running', started_at: now - 700000 });
    await orch.worker.write({ id: 'w2', state: 'dead', exited_at: now - 5000, exit_code: 1, death_established_by: 'pid 4242 not alive\nrun_ended  FORGED line' });
    await orch.worker.write({ id: 'w3', substrate: 'codex', pid: process.pid, state: 'running', started_at: now - 700000 });
    await orch.worker.write({ id: 'w3', state: 'stopped', exited_at: now - 9000, exit_code: 0 });
    worker = await openCore({ dataDir, caller: { role: 'worker', worker_id: 'w1', run_id: RUN, pid: process.pid }, embed: false });
    await worker.permission.request({ id: 'tu-1', tool: 'Bash', input: { command: 'ls' } });
    if (end) await orch.run.end({ exit_reason: 'idle' });
    return { now };
  } finally {
    if (worker) await worker.close();
    await orch.shutdownOwner(); await orch.close();
  }
}

test('notices: a pending request, dead and stopped workers with their establishment, one stall with its pid check, oldest first, each with ids, a timestamp and its row; no false stalls', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir);
    const r = cli([RUN], dataDir);
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.stall_ms, 300000);
    const kinds = j.events.map((e) => e.kind);
    assert.deepStrictEqual([...kinds].sort(), ['permission_pending', 'worker_dead', 'worker_stalled', 'worker_stopped']);
    const by = Object.fromEntries(j.events.map((e) => [e.kind, e]));

    assert.strictEqual(by.permission_pending.request_id, 'tu-1');
    assert.strictEqual(by.permission_pending.worker_id, 'w1');
    assert.strictEqual(by.permission_pending.tool, 'Bash');
    assert.strictEqual(by.worker_dead.worker_id, 'w2');
    assert.strictEqual(by.worker_dead.exit_code, 1);
    assert.ok(by.worker_dead.death_established_by.startsWith('pid 4242 not alive'));
    assert.strictEqual(by.worker_stopped.worker_id, 'w3');
    assert.strictEqual(by.worker_stalled.worker_id, 'w1');
    assert.strictEqual(by.worker_stalled.pid_alive, true);
    assert.ok(by.worker_stalled.last_event_age_ms > 300000);
    for (const e of j.events) {
      assert.strictEqual(e.run_id, RUN);
      assert.ok(Number.isInteger(e.ts), `${e.kind} carries a timestamp`);
      assert.ok(/^(worker|permission|run) row seq \d+$/.test(e.source), e.source);
    }
    const ts = j.events.map((e) => e.ts);
    assert.deepStrictEqual(ts, [...ts].sort((a, b) => a - b), 'oldest first');

    const tx = cli([RUN], dataDir, { json: false });
    assert.strictEqual(tx.status, 0, tx.stderr);
    assert.ok(!tx.stdout.includes('\u001b'));
    for (const line of tx.stdout.split('\n').filter(Boolean)) {
      assert.ok(Array.from(line).length <= 120, `line over 120 columns: ${line}`);
      assert.ok(/^(\d{4}-\d\d-\d\dT|\s)/.test(line), `a value started a line of its own: ${line}`);
    }
    assert.ok(tx.stdout.includes('worker_stalled'));
  } finally { cleanup(dir); }
});

test('notices: --stall-ms moves the threshold, --since drops older events, run.end adds run_ended, and the read writes no file', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const { now } = await plant(dataDir, { end: true });
    const listing = () => fs.readdirSync(dataDir).sort().map((n) => `${n} ${fs.statSync(`${dataDir}/${n}`).mtimeMs}`);
    const before = listing();

    const wide = JSON.parse(cli([RUN, '--stall-ms', '3600000'], dataDir).stdout);
    assert.ok(!wide.events.some((e) => e.kind === 'worker_stalled'), 'ten minutes is under an hour');
    assert.ok(wide.events.some((e) => e.kind === 'run_ended' && e.exit_reason === 'idle'));

    const narrow = JSON.parse(cli([RUN, '--stall-ms', '30000'], dataDir).stdout);
    assert.deepStrictEqual(narrow.events.filter((e) => e.kind === 'worker_stalled').map((e) => e.worker_id).sort(), ['w1', 'w4']);

    const recent = JSON.parse(cli([RUN, '--since', String(now - 6000)], dataDir).stdout);
    assert.ok(recent.events.every((e) => e.ts >= now - 6000), JSON.stringify(recent.events.map((e) => [e.kind, e.ts])));
    assert.ok(recent.events.some((e) => e.kind === 'worker_dead'));
    assert.ok(!recent.events.some((e) => e.kind === 'worker_stopped'), 'stopped 9 s ago, before the mark');
    const iso = JSON.parse(cli([RUN, '--since', new Date(now - 6000).toISOString()], dataDir).stdout);
    assert.deepStrictEqual(iso.events.map((e) => e.kind), recent.events.map((e) => e.kind));

    assert.deepStrictEqual(listing(), before, 'a read writes no file and touches none');
  } finally { cleanup(dir); }
});

test('notices: an unknown run is exit 1, no run at all is an empty list, usage errors are exit 2 and create nothing', () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const none = cli([], dataDir, { json: false });
    assert.strictEqual(none.status, 0, none.stderr);
    assert.ok(none.stdout.includes('(no notices)'));
    assert.strictEqual(fs.existsSync(dataDir), false, 'reading an absent store creates nothing');
    for (const args of [['--since'], ['--since', 'soon'], ['--stall-ms', '0'], ['a', 'b'], ['--nope']]) {
      const r = cli(args, dataDir, { json: false });
      assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    }
    assert.strictEqual(fs.existsSync(dataDir), false);
  } finally { cleanup(dir); }
});

test('verdictEvents and runEvents: a verdict check becomes an event naming the verdict, the judge and the time; a check that was not executable says why; pause and end are read from the run row', () => {
  const tasks = [
    { id: 'rv1', handoff: { at: 1000 }, results: { checks: [{ kind: 'command', passed: true }, { kind: 'verdict', executable: true, passed: false, detail: { verdict: 'refuted', judged_by: 'w7', handoff_at: 2000, depends_on: ['t1'] } }] } },
    { id: 'rv2', handoff: null, results: { checks: [{ kind: 'verdict', executable: false, passed: false, detail: { reason: 'depends_on is empty' } }] } },
    { id: 't3', results: null },
  ];
  const ev = N.verdictEvents(tasks, RUN);
  assert.deepStrictEqual(ev.map((e) => [e.task_id, e.verdict, e.passed, e.executable, e.judged_by, e.ts, e.reason]), [
    ['rv1', 'refuted', false, true, 'w7', 2000, null],
    ['rv2', null, false, false, null, null, 'depends_on is empty'],
  ]);
  assert.strictEqual(ev[0].source, 'task rv1 results, verdict check');

  assert.deepStrictEqual(N.runEvents({ id: RUN, seq: 4, paused_at: 50, paused_by: 'operator:9', ended_at: null }).map((e) => [e.kind, e.ts, e.paused_by]), [['run_paused', 50, 'operator:9']]);
  const embPause = N.runEvents({ id: RUN, seq: 4, paused_at: 50, paused_by: 'operator:9 [embedder-failure (orchestrator, memory.store, E_TIMEOUT, timeout)]', ended_at: null });
  assert.strictEqual(embPause[0].embedder_failure, true);
  const embText = N.renderText(embPause).replace(/\s+/g, ' ');
  assert.match(embText, /embedder-failure \(orchestrator, memory\.store, E_TIMEOUT, timeout\)\] \(an embedder failure.*belay settings memory\.on_embedder_failure keyword\|off.*belay resume .* --embedder keyword\|off/);
  assert.deepStrictEqual(N.runEvents({ id: RUN, seq: 5, paused_at: null, ended_at: 70, exit_reason: 'idle' }).map((e) => [e.kind, e.ts]), [['run_ended', 70]]);
  assert.deepStrictEqual(N.runEvents({ id: RUN, seq: 6, paused_at: 50, ended_at: 70 }).map((e) => e.kind), ['run_ended'], 'a pause ends with its run');

  const mixed = N.ordered([{ kind: 'a', ts: null }, { kind: 'b', ts: 30 }, { kind: 'c', ts: 10 }], 20);
  assert.deepStrictEqual(mixed.map((e) => e.kind), ['b', 'a'], 'older dropped, undated kept last');
});

test('notices: the stall age is the newer of the row and the stream mtime; a row 10 minutes old over a stream touched 1 minute ago is not a stall, and the source is named', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    const orch = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
    try {
      await orch.run.attach({ adapter_pid: process.pid });
      const now = Date.now();
      for (const id of ['wa', 'wb']) await orch.worker.write({ id, substrate: 'claude-code', pid: process.pid, state: 'running', started_at: now - 700000, mid_turn: 1, last_event_at: now - 600000 });
      await orch.worker.write({ id: 'wc', substrate: 'codex', pid: process.pid, state: 'running', started_at: now - 700000, mid_turn: 1, last_event_at: now - 600000 });
    } finally { await orch.shutdownOwner(); await orch.close(); }
    const touch = (id, agoMs) => {
      fs.mkdirSync(`${dataDir}/workers/${id}`, { recursive: true });
      fs.writeFileSync(`${dataDir}/workers/${id}/stream.jsonl`, '{}\n');
      const t = new Date(Date.now() - agoMs);
      fs.utimesSync(`${dataDir}/workers/${id}/stream.jsonl`, t, t);
    };
    touch('wa', 60000);   // stream newer than the row: alive
    touch('wb', 540000);  // stream older than five minutes too: a stall, dated by the stream
    touch('wc', 60000);   // a Codex stream is not consulted: the row decides
    const j = JSON.parse(cli([RUN], dataDir).stdout);
    const stalls = Object.fromEntries(j.events.filter((e) => e.kind === 'worker_stalled').map((e) => [e.worker_id, e]));
    assert.deepStrictEqual(Object.keys(stalls).sort(), ['wb', 'wc']);
    assert.strictEqual(stalls.wb.last_event_age_source, 'stream mtime');
    assert.ok(stalls.wb.last_event_age_ms >= 539000 && stalls.wb.last_event_age_ms < 600000, String(stalls.wb.last_event_age_ms));
    assert.strictEqual(stalls.wc.last_event_age_source, 'row');
    assert.ok(cli([RUN], dataDir, { json: false }).stdout.includes('by stream mtime'));
  } finally { cleanup(dir); }
});

test('notices: every read of one command is served from a single copy of the store', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir);
    const copies = [];
    const real = fs.copyFileSync;
    fs.copyFileSync = (src, ...rest) => { if (/memory\.db$/.test(String(src))) copies.push(String(src)); return real.call(fs, src, ...rest); };
    let r;
    try { r = await N.run({ argv: [RUN], cwd: ROOT, dataDir, dataDirGiven: true }); } finally { fs.copyFileSync = real; }
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(r.json.events.length > 0);
    assert.strictEqual(copies.length, 1, `one copy of memory.db, saw ${copies.length}`);
  } finally { cleanup(dir); }
});

test('readBatch commits to one source: the owner that answered first is never swapped for an older copy, and a batch on the copy never asks the owner', async () => {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  try {
    await plant(dataDir);
    const copies = [];
    const real = fs.copyFileSync;
    fs.copyFileSync = (src, ...rest) => { if (/memory\.db$/.test(String(src))) copies.push(String(src)); return real.call(fs, src, ...rest); };
    try {
      // Owner first: the second read finds no owner. It fails loudly, and no copy is made.
      const a = await openCore({ dataDir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
      let n = 0;
      a._tryOwner = async () => (++n === 1 ? { ok: true, value: { runs: [] } } : { ok: false });
      try {
        await assert.rejects(a.readBatch(async () => { await a.run.list({}); await a.worker.list({}); }), (e) => e.code === 'E_OWNER_LOST');
        assert.strictEqual(copies.length, 0, 'no fallback copy');
      } finally { await a.close(); }
      // Copy first: the owner is asked once, then never, though it would now answer with a newer row.
      const b = await openCore({ dataDir, caller: { role: 'operator', run_id: RUN, pid: process.pid }, embed: false });
      let asked = 0;
      b._tryOwner = async () => { asked += 1; return asked === 1 ? { ok: false } : { ok: true, value: { workers: ['newer'] } }; };
      try {
        const got = await b.readBatch(async () => [await b.run.list({}), await b.worker.list({}), await b.task.list({})]);
        assert.strictEqual(asked, 1, 'the owner was asked only by the first read');
        assert.ok(got[1].workers.length > 0 && got[1].workers.every((w) => w !== 'newer'), 'served from the copy');
        assert.strictEqual(copies.length, 1);
      } finally { await b.close(); }
    } finally { fs.copyFileSync = real; }
  } finally { cleanup(dir); }
});
