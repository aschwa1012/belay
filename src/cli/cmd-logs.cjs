'use strict';
// cmd-logs.cjs — build step 4c, design item 3. Mode R:
// worker.get (a store read) then a plain file read of the worker's own stream.jsonl — a read of a file
// another process appends to is not invariant 6's concern (that invariant is about the store). The
// core is closed before any follow loop starts: the row is read once, and the follow watches the file
// and the pid, never the store, so no pipe connection outlives the read.

const fs = require('node:fs');
const C = require('./config.cjs');
const { openCore, pidAlive } = require('../core/index.cjs');

const POLL_MS = 250;
const DEFAULT_TAIL = 20;
const DEFAULT_FOR_MS = 30000;

function usageError(message) {
  return {
    code: 2,
    text: `belay logs: ${message}\n\nusage: belay logs <worker-id> [--tail <n>] [-f] [--for <ms>] [--memory] [--data <dir>] [--json]\n`,
    json: { error: message },
  };
}

function parseArgs(argv) {
  let follow = false, tail = DEFAULT_TAIL, forMs = DEFAULT_FOR_MS, memory = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-f' || a === '--follow') { follow = true; continue; }
    if (a === '--memory') { memory = true; continue; }
    if (a === '--tail') {
      const v = argv[i += 1]; const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { error: `--tail needs a non-negative integer; got ${v}` };
      tail = n; continue;
    }
    if (a === '--for') {
      const v = argv[i += 1]; const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return { error: `--for needs a positive integer number of milliseconds; got ${v}` };
      forMs = n; continue;
    }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    rest.push(a);
  }
  if (rest.length !== 1) return { error: `belay logs needs exactly one argument, a worker id; got ${rest.length}` };
  return { workerId: rest[0], follow, tail, forMs, memory };
}

// The tail's own byte offset: how far into the file the printed lines begin, computed from the exact
// bytes skipped rather than a re-encoding guess. offset plus the printed lines' own bytes equals the
// file's total size only when the file ends with a trailing newline; otherwise the last line is still
// being written (partial), is printed as a tail line anyway, and its remainder arrives later as its
// own line from the follow — split, never lost. `stream.jsonl` is LF-only; no `\r` handling needed.
function readTail(streamPath, n) {
  let buf;
  try { buf = fs.readFileSync(streamPath); }
  catch (e) {
    if (e.code === 'ENOENT') return { exists: false, bytes: null, lines: [], offset: null };
    throw e;
  }
  const bytes = buf.length;
  const text = buf.toString('utf8');
  const all = text.length ? text.split('\n') : [];
  if (all.length && all[all.length - 1] === '') all.pop(); // the trailing newline leaves one empty entry
  const lines = n === 0 ? [] : all.slice(-n);
  const skipped = all.slice(0, all.length - lines.length);
  const offset = skipped.length ? Buffer.byteLength(skipped.join('\n') + '\n', 'utf8') : 0;
  return { exists: true, bytes, lines, offset };
}

function renderHeader(w, tailInfo) {
  const base = `worker ${w.id} ${w.state} pid ${w.pid} pid_alive ${w.pid_alive} stream ${w.stream_path}`;
  return tailInfo.exists ? `${base} bytes ${tailInfo.bytes} offset ${tailInfo.offset}` : `${base} (no stream file yet)`;
}

// ADR 0043 decision 3. The worker's memory rows (index view) and its memory_events, oldest first. A stream
// line carries no wall-clock time, so the two cannot be merged line by line: the items are ordered by their own
// times and printed as one block after the tail, and the receipt says so. Read only, through the same core.
const MEMORY_LIMIT = 50;

async function readMemory(core, w) {
  const [list, ev] = await Promise.all([
    core.memory.list({ namespaces: [`run/${w.run_id}`], filter: { worker_id: w.id }, view: 'index', order: 'oldest', limit: MEMORY_LIMIT }),
    core.memory.events({ run_id: w.run_id, worker_id: w.id }), // a worker id is unique only within its run
  ]);
  const items = [
    ...list.rows.map((r) => ({ at: r.created_at, kind: 'row', id: r.id, type: r.type, status: r.status, title: r.title, task_id: r.task_id })),
    ...ev.events.map((e) => ({ at: e.written_at, kind: 'event', id: e.id, event: e.kind, ok: !!e.ok, code: e.code ?? null, key: e.key ?? null, message: e.message ?? null, task_id: e.task_id ?? null })),
  ].map((x, i) => [x, i]).sort(([a, i], [b, j]) => (a.at ?? 0) - (b.at ?? 0) || i - j).map(([x]) => x);
  return { items, rows_total: list.total, events_total: ev.events.length, table_absent: !!ev.table_absent };
}

function memoryText(m) {
  const head = `-- memory: ${m.items.length} item(s) (${m.rows_total} row(s), ${m.events_total} event(s)); ordered by their own times, not interleaved, because stream lines carry no time --`;
  const lines = m.items.map((x) => {
    const at = new Date(x.at).toISOString();
    return x.kind === 'row'
      ? `${at}  memory row ${x.id} ${x.type || 'untyped'}/${x.status} ${x.title}`
      : `${at}  memory event ${x.event} ${x.ok ? 'ok' : `failed ${x.code}`}${x.key ? ` key ${x.key}` : ''} ${x.id}`;
  });
  return [head, ...lines];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// New bytes since `offset`, read from that offset directly (fs.openSync/fs.readSync): a poll costs the
// new bytes, never the whole file. Not held open across polls (the file may not exist yet; it only
// ever grows).
function readNewBytes(streamPath, offset) {
  let stat;
  try { stat = fs.statSync(streamPath); } catch { return { size: offset, chunk: Buffer.alloc(0) }; }
  if (stat.size <= offset) return { size: stat.size, chunk: Buffer.alloc(0) };
  const toRead = stat.size - offset;
  const buf = Buffer.alloc(toRead);
  let fd;
  try {
    fd = fs.openSync(streamPath, 'r');
    fs.readSync(fd, buf, 0, toRead, offset);
  } catch {
    return { size: offset, chunk: Buffer.alloc(0) };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
  return { size: stat.size, chunk: buf };
}

// Polls every 250 ms from `startOffset` (the file's total size as of the same read that produced the
// printed tail, never a second, independent read of "the current size": a fresh read here would race
// the tail's own read — a line that lands in the gap between the two reads would be counted as already
// known by this fresh baseline while never having been printed by the tail, and so would be lost for
// good). Ends on the outer bound, on a dead pid once two consecutive polls saw no growth, or on SIGINT.
async function followLoop({ streamPath, pid, forMs, announce, startOffset }) {
  const start = Date.now();
  let offset = startOffset;
  let noGrowthPolls = 0;
  let interrupted = false;
  const onSigint = () => { interrupted = true; };
  process.once('SIGINT', onSigint);
  try {
    for (;;) {
      if (interrupted) return { endedBecause: 'interrupted', followedMs: Date.now() - start };
      if (Date.now() - start >= forMs) return { endedBecause: 'bound', followedMs: Date.now() - start };
      await sleep(POLL_MS);
      if (interrupted) return { endedBecause: 'interrupted', followedMs: Date.now() - start };
      const { size, chunk } = readNewBytes(streamPath, offset);
      if (chunk.length) {
        const text = chunk.toString('utf8');
        const parts = text.split('\n');
        // Only complete lines (terminated by \n) are ever announced: splitting on \n always leaves one
        // trailing entry that is either '' (the chunk ended with \n) or a partial line still being
        // written; either way it is dropped here and, if partial, picked up whole on the next poll.
        const complete = parts.slice(0, -1);
        const consumedBytes = Buffer.byteLength(complete.map(l => `${l}\n`).join(''), 'utf8');
        for (const line of complete) announce(line);
        offset += consumedBytes;
        noGrowthPolls = 0;
      } else {
        noGrowthPolls += 1;
      }
      if (!pidAlive(pid) && noGrowthPolls >= 2) return { endedBecause: 'pid dead and the stream stopped growing', followedMs: Date.now() - start };
      if (Date.now() - start >= forMs) return { endedBecause: 'bound', followedMs: Date.now() - start };
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  let w, memory = null;
  try {
    w = await core.worker.get({ worker_id: parsed.workerId });
    if (parsed.memory) memory = await readMemory(core, w);
  } catch (e) {
    await core.close();
    const detail = { code: e.code || 'E_INTERNAL', message: e.message };
    return { code: 1, text: `belay logs: ${e.message}\n`, json: { error: detail } };
  }
  await core.close(); // the row is read once; the follow below watches the file and the pid, not the store

  // An unreadable stream file (EACCES, EISDIR, oversized) is the same mode-R error receipt every other
  // read command returns, never a thrown error escaping to the dispatcher's bare stderr line.
  let tailInfo;
  try {
    tailInfo = readTail(w.stream_path, parsed.tail);
  } catch (e) {
    const detail = { code: e.code || 'E_INTERNAL', message: e.message };
    return { code: 1, text: `belay logs: ${e.message}\n`, json: { error: detail } };
  }
  const header = renderHeader(w, tailInfo);
  const baseJson = {
    worker_id: w.id, run_id: w.run_id, state: w.state, pid: w.pid, pid_alive: w.pid_alive,
    stream_path: w.stream_path, stream_bytes: tailInfo.exists ? tailInfo.bytes : null,
    offset: tailInfo.exists ? tailInfo.offset : null,
    ...(memory ? { memory } : {}),
  };
  const memLines = memory ? memoryText(memory) : [];

  if (!parsed.follow) {
    const text = tailInfo.exists ? [header, ...tailInfo.lines, ...memLines, ''].join('\n') : [header, ...memLines, ''].join('\n');
    return { code: 0, text, json: { ...baseJson, lines: tailInfo.lines, followed: false } };
  }

  const collected = [...tailInfo.lines];
  const emit = ctx.emit || null;
  if (emit) { emit(`${header}\n`); for (const l of tailInfo.lines) emit(`${l}\n`); for (const l of memLines) emit(`${l}\n`); }
  let followLines = 0;
  const announce = (line) => { collected.push(line); followLines += 1; if (emit) emit(`${line}\n`); };

  const startOffset = tailInfo.exists ? tailInfo.bytes : 0;
  const { endedBecause, followedMs } = await followLoop({ streamPath: w.stream_path, pid: w.pid, forMs: parsed.forMs, announce, startOffset });
  const bytesSeen = Buffer.byteLength(collected.slice(collected.length - followLines).map(l => `${l}\n`).join(''), 'utf8');
  // lines_emitted/bytes_seen count only what the follow loop announced; the closing line says so.
  const closing = `worker ${w.id} followed ${followedMs} ms, ended because: ${endedBecause}. followed: ${followLines} lines, ${bytesSeen} bytes after the tail.\n`;
  return {
    code: 0, text: closing,
    json: {
      ...baseJson, lines: collected, followed: true, followed_ms: followedMs,
      ended_because: endedBecause, lines_emitted: followLines, bytes_seen: bytesSeen,
    },
  };
}

module.exports = { run };
