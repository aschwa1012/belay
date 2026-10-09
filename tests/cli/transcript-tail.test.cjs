'use strict';
// transcript-tail.test.cjs — `belay transcript --tail N` (ADR 0036 decision 8): the last N panel
// entries read from the end of the stream in a bounded, growing window. The CLI is driven as a
// subprocess against a sandbox store with one planted run row; the window logic is also driven
// through readTail with small windows so a boundary lands mid-line. Every sandbox is removed in finally.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { openCore } = require('../../src/core/index.cjs');
const { readTail } = require('../../src/cli/cmd-transcript.cjs');
const { ROOT, CLI, sandbox, cleanup } = require('./stop-helpers.cjs');

const RUN = 'run-tail';
const { writeSyntheticStream } = require('../helpers/synthetic-stream.cjs');
const L = (o) => `${JSON.stringify(o)}\n`;
const TS = '2026-10-04T10:00:00.000Z';
const asst = (content) => L({ type: 'assistant', message: { role: 'assistant', content, usage: { input_tokens: 1 } }, parent_tool_use_id: null, timestamp: TS });
const text = (t) => asst([{ type: 'text', text: t }]);
const toolUse = (id, name, input) => asst([{ type: 'tool_use', id, name, input }]);
const toolResult = (id, content, isError) => L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, timestamp: TS });
const bytes = (...parts) => parts.reduce((a, x) => a + Buffer.byteLength(x), 0);

function cli(args, dataDir, { json = true } = {}) {
  return spawnSync(process.execPath, [CLI, 'transcript', ...args, '--data', dataDir, ...(json ? ['--json'] : [])], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
}

async function plantRun(dataDir) {
  const core = await openCore({ dataDir, caller: { role: 'orchestrator', run_id: RUN, pid: process.pid }, embed: false });
  try { await core.run.attach({ adapter_pid: process.pid }); } finally { await core.shutdownOwner(); await core.close(); }
}

function snapshot(...dirs) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) { out.push(`${p}/`); walk(p); } else { const s = fs.statSync(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); }
    }
  };
  dirs.forEach(walk);
  return out;
}

// Only valid lines, so a retained cut line is the one thing that can raise skipped_lines. Multi-byte
// text keeps a window boundary inside a character reachable.
function cleanFixture() {
  const parts = [];
  for (let i = 0; i < 12; i += 1) {
    parts.push(text(`entry ${i} é中 ${'x'.repeat(10 + i * 7)}`));
    parts.push(toolUse(`tu${i}`, 'mcp__belay__task_evaluate', { task_id: `t${i}` }));
    parts.push(toolResult(`tu${i}`, '{"state":"done"}'));
  }
  parts.push(L({ type: 'result', is_error: false, num_turns: 3, stop_reason: 'end_turn', total_cost_usd: 2 }));
  return parts;
}

async function withRun(fn) {
  const dir = sandbox();
  const dataDir = `${dir}/.belay`;
  const orch = `${dir}/orch`;
  try {
    await plantRun(dataDir);
    fs.mkdirSync(orch, { recursive: true });
    await fn({ dir, dataDir, orch, stream: `${orch}/stream.jsonl` });
  } finally { cleanup(dir); }
}

test('transcript --tail: the last N entries equal the last N of a full read, on a fixture and on a long generated stream; a small N reads a small part of the file', async () => {
  await withRun(async ({ dataDir, orch, stream }) => {
    fs.writeFileSync(stream, cleanFixture().join(''));
    const full = JSON.parse(cli([RUN, '--dir', orch], dataDir).stdout);
    for (const n of [1, 5, 20]) {
      const j = JSON.parse(cli([RUN, '--dir', orch, '--tail', String(n)], dataDir).stdout);
      assert.deepStrictEqual(j.entries, full.entries.slice(-n));
      assert.strictEqual(j.tail.requested, n);
      assert.strictEqual(j.tail.returned, n);
      assert.strictEqual(j.followed, false);
    }

    writeSyntheticStream(stream);
    const fileBytes = fs.statSync(stream).size;
    const realFull = JSON.parse(cli([RUN, '--dir', orch], dataDir).stdout);
    assert.ok(realFull.entries.length > 40, `the generated stream has ${realFull.entries.length} entries`);
    for (const n of [1, 3, 10, 20]) {
      const j = JSON.parse(cli([RUN, '--dir', orch, '--tail', String(n)], dataDir).stdout);
      assert.deepStrictEqual(j.entries, realFull.entries.slice(-n), `--tail ${n}`);
      assert.strictEqual(j.tail.file_bytes, fileBytes);
      assert.strictEqual(j.stream_bytes, fileBytes);
      assert.strictEqual(j.tail.reached_start, n <= 10 ? false : j.tail.reached_start);
    }
    const j3 = JSON.parse(cli([RUN, '--dir', orch, '--tail', '3'], dataDir).stdout);
    assert.ok(j3.tail.bytes_read * 3 < fileBytes, `bytes_read ${j3.tail.bytes_read} of ${fileBytes}`);
    assert.ok(j3.tail.bytes_read > 0);
  });
});

test('transcript --tail: an N larger than the stream returns every entry and says it reached the start', async () => {
  await withRun(async ({ dataDir, orch, stream }) => {
    writeSyntheticStream(stream);
    const full = JSON.parse(cli([RUN, '--dir', orch], dataDir).stdout);
    const j = JSON.parse(cli([RUN, '--dir', orch, '--tail', '1000'], dataDir).stdout);
    assert.deepStrictEqual(j.entries, full.entries);
    assert.strictEqual(j.tail.reached_start, true);
    assert.strictEqual(j.tail.returned, full.entries.length);
    assert.ok(j.tail.returned < 1000);
    assert.strictEqual(j.tail.bytes_read, j.tail.file_bytes, 'the whole file was read, once, because the start was needed');
  });
});

test('transcript --tail: a window boundary in the middle of a line (or of a character) drops that line and never counts it as skipped', async () => {
  await withRun(async ({ stream }) => {
    fs.writeFileSync(stream, cleanFixture().join(''));
    const full = readTail(stream, 1000);
    assert.strictEqual(full.skipped, 0);
    const size = fs.statSync(stream).size;
    let tried = 0;
    for (let start = 40; start < size; start += 13) {
      const t = readTail(stream, 6, { startBytes: start });
      assert.deepStrictEqual(t.entries, full.entries.slice(-6), `startBytes ${start}`);
      assert.strictEqual(t.skipped, 0, `startBytes ${start}: a cut line must be dropped, not parsed and skipped`);
      tried += 1;
    }
    assert.ok(tried > 20);
    // a boundary exactly on a line start keeps that line
    const buf = fs.readFileSync(stream);
    const lastLineStart = buf.lastIndexOf(0x0a, buf.length - 2) + 1;
    const t = readTail(stream, 1, { startBytes: buf.length - lastLineStart });
    assert.strictEqual(t.entries[0].kind, 'result');
    assert.strictEqual(t.tail.reached_start, false);
    assert.strictEqual(t.tail.bytes_read, buf.length - lastLineStart + 1, 'the window and one lookbehind byte, nothing more');
    // an unterminated last line is not an entry, as in a whole read
    fs.appendFileSync(stream, '{"type":"assistant","message":{"content":[{"type":"text","text":"PARTIAL');
    const withPartial = readTail(stream, 3, { startBytes: 50 });
    assert.deepStrictEqual(withPartial.entries, full.entries.slice(-3));
    assert.strictEqual(withPartial.skipped, 0);
  });
});

test('transcript --tail: a result whose call lies before the window is an entry marked call_outside_window, never an invented call; the window grows to find the call when it can', async () => {
  await withRun(async ({ stream }) => {
    const first = text('before');
    const use = toolUse('tuX', 'mcp__belay__worker_spawn', { worker_id: 'w9', task_id: 't9' });
    const pad = [text('pad one'), text('pad two'), text('pad three')];
    const res = toolResult('tuX', JSON.stringify({ error: 'E_ARGS' }), true);
    const last = text('the last');
    fs.writeFileSync(stream, [first, use, ...pad, res, last].join(''));

    // the window is held at exactly the pad, the result and the last line: the call is behind it
    const held = bytes(...pad, res, last);
    const capped = readTail(stream, 2, { startBytes: held, maxBytes: held });
    assert.strictEqual(capped.entries.length, 2);
    const [orphan, tail] = capped.entries;
    assert.strictEqual(orphan.kind, 'tool');
    assert.strictEqual(orphan.call_outside_window, true);
    assert.strictEqual(orphan.tool, null);
    assert.deepStrictEqual(orphan.ids, {});
    assert.strictEqual(orphan.tool_use_id, 'tuX');
    assert.strictEqual(orphan.result, 'error');
    assert.strictEqual(orphan.error_code, 'E_ARGS');
    assert.strictEqual(tail.text, 'the last');

    const grown = readTail(stream, 2, { startBytes: bytes(res, last) });
    assert.strictEqual(grown.entries[0].tool, 'mcp__belay__worker_spawn');
    assert.deepStrictEqual(grown.entries[0].ids, { worker_id: 'w9', task_id: 't9' });
    assert.strictEqual(grown.entries[0].call_outside_window, undefined);
    assert.ok(grown.tail.bytes_read > bytes(res, last), 'the window grew past the first guess to find the call');

    // growth that is capped part-way: the first window is below maxBytes, the call lies beyond it
    const maxB = bytes(...pad, res, last);
    const stepped = readTail(stream, 2, { startBytes: bytes(res, last), maxBytes: maxB });
    assert.ok(bytes(res, last) < maxB);
    assert.strictEqual(stepped.tail.bytes_read, maxB + 1, 'grown to the cap, plus the lookbehind byte');
    assert.strictEqual(stepped.entries[0].call_outside_window, true);

    // the other half: a call at the end with no result yet stays "no result yet", as in a whole read
    fs.writeFileSync(stream, [text('a'), toolUse('tuY', 'mcp__belay__worker_wait', { worker_ids: ['w1'] })].join(''));
    const open = readTail(stream, 1, { startBytes: 10 });
    assert.strictEqual(open.entries[0].tool, 'mcp__belay__worker_wait');
    assert.strictEqual(open.entries[0].result, null);
  });
});

test('transcript --tail: text mode names the bound in the header; a missing stream is exit 0', async () => {
  await withRun(async ({ dataDir, orch, stream }) => {
    const none = cli([RUN, '--dir', orch, '--tail', '4'], dataDir, { json: false });
    assert.strictEqual(none.status, 0, none.stderr);
    assert.ok(none.stdout.split(/\s+/).join(' ').includes('(no stream file yet)'), none.stdout);
    const noneJ = JSON.parse(cli([RUN, '--dir', orch, '--tail', '4'], dataDir).stdout);
    assert.deepStrictEqual(noneJ.entries, []);
    assert.strictEqual(noneJ.tail.file_bytes, null);

    writeSyntheticStream(stream);
    const tx = cli([RUN, '--dir', orch, '--tail', '4'], dataDir, { json: false });
    assert.strictEqual(tx.status, 0, tx.stderr);
    assert.ok(/last 4 of 4 requested entries, \d+ bytes read\)/.test(tx.stdout.split(/\s+/).join(' ')), tx.stdout);
  });
});

test('transcript --tail: usage errors are exit 2 and a tail read creates and changes no file', async () => {
  await withRun(async ({ dir, dataDir, orch, stream }) => {
    writeSyntheticStream(stream);
    const before = snapshot(dir);
    for (const bad of [['--tail'], ['--tail', '0'], ['--tail', '-1'], ['--tail', 'abc'], ['--tail', '1.5'], ['--tail', '1001'], ['--tail', '5', '-f'], ['-f', '--tail', '5'], ['--tail', '5', '--for', '100'], ['--for', '100', '--tail', '5']]) {
      const r = cli([RUN, '--dir', orch, ...bad], dataDir);
      assert.strictEqual(r.status, 2, `${bad.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.ok(JSON.parse(r.stderr).error.includes('--tail'), bad.join(' '));
    }
    assert.strictEqual(cli([RUN, '--dir', orch, '--tail', '1000'], dataDir).status, 0);
    assert.deepStrictEqual(snapshot(dir), before, 'no file is created or touched');
  });
});

test('transcript --tail: when the window reaches byte 0 the entries equal the whole read; a result whose call line is nowhere in the file is dropped, not marked an orphan', async () => {
  await withRun(async ({ dataDir, orch, stream }) => {
    // the call line is garbage, so its result has no call anywhere in the file
    fs.writeFileSync(stream, [text('a'), 'not json at all\n', toolResult('tuZ', '{"state":"done"}')].join(''));
    const full = JSON.parse(cli([RUN, '--dir', orch], dataDir).stdout);
    assert.deepStrictEqual(full.entries.map((e) => e.kind), ['text']);
    for (const n of ['1', '2', '1000']) {
      const j = JSON.parse(cli([RUN, '--dir', orch, '--tail', n], dataDir).stdout);
      assert.deepStrictEqual(j.entries, full.entries.slice(-Number(n)), `--tail ${n}`);
      assert.strictEqual(j.tail.reached_start, true);
      assert.ok(!j.entries.some((e) => e.call_outside_window));
    }
  });
});

test('transcript --tail: only calls inside the window are shown; a stale unanswered call from before it (a stream reused across epochs) is not, though a whole read lists it last', async () => {
  await withRun(async ({ dataDir, orch, stream }) => {
    const stale = toolUse('tuE', 'mcp__belay__worker_wait', { worker_ids: ['w0'] });
    const body = [text('epoch two'), toolUse('tu2', 'mcp__belay__task_evaluate', { task_id: 't2' }), toolResult('tu2', '{"state":"done"}')];
    fs.writeFileSync(stream, [stale, ...body].join(''));
    const full = JSON.parse(cli([RUN, '--dir', orch], dataDir).stdout);
    assert.deepStrictEqual(full.entries.map((e) => e.tool || e.kind), ['text', 'mcp__belay__task_evaluate', 'mcp__belay__worker_wait'], 'a whole read puts the stale call last');
    const t = readTail(stream, 2, { startBytes: bytes(...body) });
    assert.deepStrictEqual(t.entries.map((e) => e.tool || e.kind), ['text', 'mcp__belay__task_evaluate']);
    assert.strictEqual(t.tail.reached_start, false);
    assert.ok(!JSON.stringify(t.entries).includes('tuE'));
  });
});

test('transcript --tail: a growth read that comes back short (the file shrank) stops the growth, keeps the previous window and says truncated_during_read', async (tctx) => {
  await withRun(async ({ stream }) => {
    fs.writeFileSync(stream, cleanFixture().join(''));
    const full = readTail(stream, 1000);
    const real = fs.readSync;
    let calls = 0;
    const hook = tctx.mock.method(fs, 'readSync', (...args) => { calls += 1; return calls === 1 ? real(...args) : 0; });
    const t = readTail(stream, 1000, { startBytes: 300 });
    assert.strictEqual(t.tail.truncated_during_read, true);
    assert.strictEqual(t.tail.reached_start, false);
    assert.strictEqual(t.tail.bytes_read, 301, 'the first window and its lookbehind byte; the short read is not added');
    assert.ok(t.entries.length > 0 && t.entries.length < full.entries.length);
    const sure = t.entries.filter((e) => !e.call_outside_window); // a window start can cut a call from its result
    assert.deepStrictEqual(sure, full.entries.slice(-sure.length), 'what it returns is the true tail');
    assert.strictEqual(calls, 2);
    hook.mock.restore();
    assert.strictEqual(readTail(stream, 1000).tail.truncated_during_read, false);
  });
});
