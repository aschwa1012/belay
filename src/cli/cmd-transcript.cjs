'use strict';
// cmd-transcript.cjs — ADR 0036 decision 8, build step U1. Mode R: run.list (a store read through the
// core's copy-then-read path) and a plain read of the orchestrator's own stream.jsonl, which another
// process appends to (not invariant 6's concern, which is about the store). The core is closed before
// any follow starts, as `belay logs -f` does: the row is read once, the follow watches the file and
// the pid. The orchestrator's stream is rendered as panel entries, never summarised or rewritten:
//   text    each assistant text block in full
//   tool    each tool call as one line: tool name, the ids in its input, the error code of its result
//   belay   a user line that starts `belay: ` (a worker wake, a run-resume line, any line belay writes)
//   operator a user line that starts `operator:` (ADR 0036 decision 4; none is written before U3)
//   note    a line of this command's own: the stream shrank during -f and is read again from its start
//   result  a turn end with the stream's total_cost_usd
//
// A wake is a stdin write belay makes, and the orchestrator's launch passes no
// `--replay-user-messages`, so a stream recorded today carries no wake or operator line (checked over
// 17 recorded orchestrator streams: none). Those entries appear when the substrate
// echoes the line; the code does not invent them from `command_lifecycle`, which carries no text.

const fs = require('node:fs');
const C = require('./config.cjs');
const P = require('./panel-common.cjs');
const { growTail } = require('./stream-tail.cjs');
const { openCore, pidAlive } = require('../core/index.cjs');

const USAGE = 'usage: belay transcript [run-id] [-f] [--for <ms>] [--tail <n>] [--dir <orchestrator_dir>] [--data <dir>] [--json]\n';
const POLL_MS = 250;
const DEFAULT_FOR_MS = 30000;
const TAIL_MAX_ENTRIES = 1000;
const ID_KEYS = ['worker_id', 'worker_ids', 'task_id', 'id', 'lease_id', 'request_id', 'repairs', 'depends_on'];

function usageError(message) {
  return { code: 2, text: `belay transcript: ${message}\n\n${USAGE}`, json: { error: message } };
}

function parseArgs(argv) {
  let follow = false, forMs = DEFAULT_FOR_MS, dir = null, tail = null, forGiven = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-f' || a === '--follow') { follow = true; continue; }
    if (a === '--for') {
      const raw = argv[i += 1]; const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) return { error: `--for needs a positive integer number of milliseconds; got ${raw}` };
      forMs = n; forGiven = true; continue;
    }
    if (a === '--tail') {
      const raw = argv[i += 1];
      if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw) || Number(raw) > TAIL_MAX_ENTRIES) return { error: `--tail needs a positive integer up to ${TAIL_MAX_ENTRIES}; got ${raw}` };
      tail = Number(raw); continue;
    }
    if (a === '--dir') {
      const raw = argv[i += 1];
      if (raw === undefined || raw.startsWith('-')) return { error: '--dir needs a directory' };
      dir = raw; continue;
    }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    rest.push(a);
  }
  if (rest.length > 1) return { error: `belay transcript takes zero or one argument, a run id; got ${rest.length}` };
  if (rest.length === 1 && rest[0] === '') return { error: 'the run id is an empty string' };
  if (tail !== null && follow) return { error: '--tail and -f cannot be combined; --tail is a one-shot read of the last entries' };
  if (tail !== null && forGiven) return { error: '--tail and --for cannot be combined; --for bounds a follow and --tail is a one-shot read' };
  return { runId: rest[0], follow, forMs, dir, tail };
}

// ---- stream -> entries ---------------------------------------------------------------------------

// The ids a tool call names in its input: the keys in ID_KEYS whose values are strings or short arrays
// of strings. Nothing else of the input is shown.
function idsOf(input) {
  const ids = {};
  if (!input || typeof input !== 'object') return ids;
  for (const k of ID_KEYS) {
    const val = input[k];
    if (typeof val === 'string' && val) ids[k] = val;
    else if (Array.isArray(val) && val.length && val.every((x) => typeof x === 'string')) ids[k] = val.slice(0, 8).join(',');
  }
  return ids;
}

// The error code a failed tool result carries: belay's MCP errors are JSON `{ error: 'E_...' }` in the
// result text; anything else falls back to the first E_ token, then to the word `error`.
function errorCodeOf(block) {
  const text = P.contentText(block.content);
  try {
    const o = JSON.parse(text);
    if (o && typeof o.error === 'string') return o.error;
  } catch { /* not JSON */ }
  const m = /\bE_[A-Z0-9_]+\b/.exec(text);
  return m ? m[0] : 'error';
}

// Feeds stream lines in order, returns the entries each completes. A tool call is held until its
// result arrives, because the one line shows the result's error code; `flush()` returns the calls
// still waiting, with `result: null`. Lines that do not parse, and a subagent's own lines
// (`parent_tool_use_id` set), are not the orchestrator's words and are skipped and counted.
//
// `orphans` (the tail read, whose window can start between a call and its result): a result with no
// call in the window becomes a `tool` entry with `tool: null`, `ids: {}` and `call_outside_window: true`;
// the call's name and ids are unknown and are not guessed, its result and error code are real.
function makeFolder({ orphans = false } = {}) {
  const pending = new Map();
  const state = { skipped: 0 };
  const feed = (line) => {
    let o;
    try { o = JSON.parse(line); } catch { state.skipped += 1; return []; }
    if (!o || typeof o !== 'object') { state.skipped += 1; return []; }
    if ((o.type === 'assistant' || o.type === 'user') && o.parent_tool_use_id) { state.skipped += 1; return []; }
    const ts = typeof o.timestamp === 'string' ? o.timestamp : null;
    const out = [];
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ kind: 'text', text: b.text, ts });
        else if (b && b.type === 'tool_use') {
          pending.set(b.id, { kind: 'tool', tool: String(b.name), ids: idsOf(b.input), tool_use_id: b.id, result: null, error_code: null, ts });
        }
      }
    } else if (o.type === 'user' && o.message) {
      const content = o.message.content;
      const results = Array.isArray(content) ? content.filter((b) => b && b.type === 'tool_result') : [];
      for (const b of results) {
        const e = pending.get(b.tool_use_id);
        if (!e) {
          if (orphans) out.push({ kind: 'tool', tool: null, ids: {}, tool_use_id: b.tool_use_id ?? null, result: b.is_error ? 'error' : 'ok', error_code: b.is_error ? errorCodeOf(b) : null, call_outside_window: true, ts });
          continue;
        }
        pending.delete(b.tool_use_id);
        e.result = b.is_error ? 'error' : 'ok';
        e.error_code = b.is_error ? errorCodeOf(b) : null;
        out.push(e);
      }
      if (!results.length) {
        const text = P.contentText(content);
        if (text.startsWith('belay: ')) out.push({ kind: 'belay', text, ts });
        else if (text.startsWith('operator:')) out.push({ kind: 'operator', text, ts });
      }
    } else if (o.type === 'result') {
      out.push({
        kind: 'result', is_error: !!o.is_error, stop_reason: o.stop_reason ?? null, num_turns: o.num_turns ?? null,
        total_cost_usd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null, ts,
      });
    }
    return out;
  };
  const flush = () => { const rest = [...pending.values()]; pending.clear(); return rest; };
  return { feed, flush, state };
}

// ---- text ----------------------------------------------------------------------------------------

function renderEntry(e) {
  if (e.kind === 'text') {
    const lines = [];
    String(e.text).split(/\r?\n/).forEach((l, i) => lines.push(...P.wrapLine(i === 0 ? 'orchestrator  ' : '              ', P.clean(l, 4000))));
    return lines;
  }
  if (e.kind === 'tool') {
    const name = e.tool === null ? '(call outside the window)' : e.tool.replace(/^mcp__belay__/, '');
    const ids = Object.entries(e.ids).map(([k, val]) => `${k}=${P.clean(val, 60)}`).join(' ');
    const res = e.result === null ? 'no result yet' : (e.result === 'ok' ? 'ok' : P.clean(e.error_code, 40));
    return P.wrapLine('  > ', `${P.clean(name, 60)}${ids ? ` ${ids}` : ''} -> ${res}`);
  }
  if (e.kind === 'belay') return P.wrapLine('  ! ', P.clean(e.text, 400));
  if (e.kind === 'note') return P.wrapLine('  ~ ', P.clean(e.text, 400));
  if (e.kind === 'operator') return P.wrapLine('  @ ', P.clean(e.text, 400));
  const parts = [`turn end${e.is_error ? ' (error)' : ''}`];
  if (e.num_turns != null) parts.push(`turns ${P.clean(e.num_turns, 10)}`);
  if (e.stop_reason != null) parts.push(`stop ${P.clean(e.stop_reason, 30)}`);
  parts.push(`total_cost_usd ${P.money(e.total_cost_usd)}`);
  return [`  = ${parts.join('  ')}`];
}

const textOf = (entries) => entries.flatMap(renderEntry).map((l) => `${l.replace(/\s+$/, '')}\n`).join('');

function header(run, source, streamPath, bytes, tailNote = '') {
  const state = run.ended_at != null ? `ended ${P.iso(run.ended_at)}` : (run.paused_at != null ? 'paused' : (run.alive ? 'alive' : 'not alive'));
  const tail = bytes == null ? '(no stream file yet)' : `bytes ${bytes}${tailNote}`;
  return P.wrapLine('', `run ${P.v(run.id)} (chosen by ${source}) ${state} stream ${P.clean(streamPath, 200)} ${tail}`).join('\n');
}

// ---- tail ----------------------------------------------------------------------------------------

// The last `n` panel entries, read from the end of the file in a growing window (stream-tail.cjs). A
// window is enough when it holds n entries and none of the last n is an orphan (a result whose call
// lies before the window), or when it reaches byte 0 or the byte cap; an orphan that survives the cap
// stays marked. `skipped_lines` counts the window only. `tail` is the read's receipt.
//
// Only calls inside the window are shown. A call with no result is "no result yet" when it is in the
// window; one from before the window is not shown, so a stale unanswered call (a stream reused across
// epochs, opened with 'a') that the whole-file read's flush() would put last does not appear. When the
// window reached byte 0 the whole file was read and the entries equal the whole-file read's: a result
// whose call line is nowhere in the file is dropped, not marked an orphan.
function foldWindow(lines, orphans = true) {
  const folder = makeFolder({ orphans });
  const entries = [];
  for (const l of lines) entries.push(...folder.feed(l));
  entries.push(...folder.flush());
  return { entries, skipped: folder.state.skipped };
}

function readTail(streamPath, n, opts) {
  const w = growTail(streamPath, (lines) => {
    const last = foldWindow(lines).entries.slice(-n);
    return last.length >= n && !last.some((e) => e.call_outside_window);
  }, opts);
  const folded = foldWindow(w.lines, !w.reached_start);
  const entries = folded.entries.slice(-n);
  return {
    entries, skipped: folded.skipped, file_bytes: w.file_bytes,
    tail: { requested: n, returned: entries.length, bytes_read: w.bytes_read, file_bytes: w.file_bytes, reached_start: w.reached_start, truncated_during_read: w.truncated_during_read },
  };
}

// ---- follow --------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// New bytes from `offset`, read from that offset (never the whole file); not held open between polls.
function readNewBytes(file, offset) {
  let stat;
  try { stat = fs.statSync(file); } catch { return Buffer.alloc(0); }
  if (stat.size <= offset) return Buffer.alloc(0);
  const buf = Buffer.alloc(stat.size - offset);
  let fd;
  try { fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, buf.length, offset); }
  catch { return Buffer.alloc(0); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* gone */ } } }
  return buf;
}

// Polls every 250 ms from `offset`. Only complete lines are folded; a partial last line is read whole
// on a later poll. Ends on the bound, on SIGINT, or on a dead orchestrator pid once two consecutive
// polls saw no growth (a run row with no pid is bounded by --for alone).
async function followLoop({ file, offset, pid, forMs, onLine, onShrink }) {
  const start = Date.now();
  let at = offset, still = 0, interrupted = false;
  const onSigint = () => { interrupted = true; };
  process.once('SIGINT', onSigint);
  try {
    for (;;) {
      if (interrupted) return { endedBecause: 'interrupted', followedMs: Date.now() - start };
      if (Date.now() - start >= forMs) return { endedBecause: 'bound', followedMs: Date.now() - start };
      await sleep(POLL_MS);
      try {
        if (fs.statSync(file).size < at) { at = 0; onShrink(); }
      } catch { /* gone: readNewBytes sees it too */ }
      const chunk = readNewBytes(file, at);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl >= 0) {
        for (const l of chunk.subarray(0, lastNl).toString('utf8').split('\n')) onLine(l);
        at += lastNl + 1;
        still = 0;
      } else still += 1;
      if (pid != null && !pidAlive(pid) && still >= 2) return { endedBecause: 'orchestrator pid dead and the stream stopped growing', followedMs: Date.now() - start };
    }
  } finally { process.removeListener('SIGINT', onSigint); }
}

// ---- command -------------------------------------------------------------------------------------

async function run(ctx) {
  const parsed = parseArgs(ctx.argv);
  if (parsed.error) return usageError(parsed.error);

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  let chosen, source;
  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: parsed.runId || 'cli', pid: process.pid } });
  try {
    ({ chosen, source } = await P.chooseRun(core, parsed.runId));
  } catch (e) {
    return { code: 1, text: `belay transcript: ${P.clean(e.message, 200)}\n`, json: { error: { code: e.code || 'E_INTERNAL', message: e.message } } };
  } finally {
    await core.close(); // the row is read once; a follow watches the file and the pid, not the store
  }
  if (!chosen) {
    if (!parsed.runId) {
      const empty = { run_id: null, run_id_source: 'none', stream_path: null, stream_bytes: null, entries: [], skipped_lines: 0, followed: false };
      return { code: 0, text: '(no run rows exist)\n', json: empty };
    }
    const message = `no run row exists for ${parsed.runId}`;
    return { code: 1, text: `belay transcript: ${P.clean(message)}\n`, json: { error: { code: 'E_NOT_FOUND', message, run_id: parsed.runId } } };
  }

  const { stream_path: streamPath } = P.orchestratorStreamPath(chosen.id, parsed.dir, ctx.cwd);
  if (parsed.tail !== null) {
    let t;
    try { t = readTail(streamPath, parsed.tail); } catch (e) {
      return { code: 1, text: `belay transcript: ${P.clean(e.message, 200)}
`, json: { error: { code: e.code || 'E_INTERNAL', message: e.message } } };
    }
    const note = ` (last ${t.tail.returned} of ${t.tail.requested} requested entries, ${t.tail.bytes_read} bytes read${t.tail.reached_start ? ', from the start' : ''}${t.tail.truncated_during_read ? ', the file shrank during the read and the window stopped growing' : ''})`;
    const head = header(chosen, source, streamPath, t.file_bytes, note);
    const base = { run_id: chosen.id, run_id_source: source, stream_path: streamPath, stream_bytes: t.file_bytes };
    return { code: 0, text: `${head}
${t.file_bytes == null ? '' : textOf(t.entries)}`, json: { ...base, entries: t.entries, skipped_lines: t.skipped, followed: false, tail: t.tail } };
  }
  let buf = null;
  try { buf = fs.readFileSync(streamPath); } catch (e) {
    if (e.code !== 'ENOENT') return { code: 1, text: `belay transcript: ${P.clean(e.message, 200)}\n`, json: { error: { code: e.code || 'E_INTERNAL', message: e.message } } };
  }
  const folder = makeFolder();
  const entries = [];
  const head = header(chosen, source, streamPath, buf ? buf.length : null);
  const base = { run_id: chosen.id, run_id_source: source, stream_path: streamPath, stream_bytes: buf ? buf.length : null };

  // Complete lines only: a partial last line (still being written) is left for the follow to read whole.
  const lastNl = buf ? buf.lastIndexOf(0x0a) : -1;
  const consumed = lastNl + 1;
  const emit = parsed.follow ? ctx.emit || null : null;
  const take = (items) => { for (const e of items) { entries.push(e); if (emit) emit(textOf([e])); } };
  if (emit) emit(`${head}\n`);
  if (consumed) for (const l of buf.subarray(0, lastNl).toString('utf8').split('\n')) take(folder.feed(l));

  if (!parsed.follow) {
    take(folder.flush());
    const body = buf ? textOf(entries) : '';
    return { code: 0, text: `${head}\n${body}`, json: { ...base, entries, skipped_lines: folder.state.skipped, followed: false } };
  }

  const { endedBecause, followedMs } = await followLoop({
    file: streamPath, offset: consumed, pid: chosen.orchestrator_pid ?? null, forMs: parsed.forMs,
    onLine: (l) => take(folder.feed(l)),
    onShrink: () => take([{ kind: 'note', text: 'stream shrank (replaced or truncated); reading again from its start', ts: null }]),
  });
  take(folder.flush());
  const closing = `run ${P.v(chosen.id)} followed ${followedMs} ms, ended because: ${endedBecause}. entries: ${entries.length}.\n`;
  return {
    code: 0, text: closing,
    json: { ...base, entries, skipped_lines: folder.state.skipped, followed: true, followed_ms: followedMs, ended_because: endedBecause },
  };
}

module.exports = { run, makeFolder, renderEntry, readTail };
