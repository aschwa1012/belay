'use strict';
// agents-derive.cjs — what `belay agents` derives for the panel (ADR 0036 decision 5b and amendment 1
// sections 4 and 5): the prompt-cache timer, the task, the display state and the run's mode. Pure
// functions over the rows and the one stream scan cmd-agents already makes, with `now` passed in. No
// store access, no write, no process, no embedder.

const fs = require('node:fs');
const P = require('./panel-common.cjs');

const STALL_MS = 300000; // ADR 0036 decision 5: five minutes, the same threshold `belay notices` uses
const LOW_CAP_MS = 600000; // amendment 1 section 5: under ten minutes, or under a fifth of the lifetime if that is less
const FILE_MAX = 1024 * 1024;
const WAIT_TOOL = /(^|__)worker_wait$/; // the one call an orchestrator waits in by design (ADR 0015)
// A call that legitimately runs longer than the stall threshold: task.evaluate runs the acceptance
// commands inside the owner for up to EVALUATE_TIMEOUT_MS (mirrors src/core/index.cjs:28, which does not
// export it; this module imports nothing of the core).
const EVALUATE_TIMEOUT_MS = 600000;
const EVALUATE_TOOL = /(^|__)task_evaluate$/;

// The lifetime a line's usage.cache_creation split names, or null when it names none. A 1-hour write
// wins over a 5-minute write on the same line.
function splitOf(o) {
  const cc = o && o.message && o.message.usage && o.message.usage.cache_creation;
  if (!cc || typeof cc !== 'object') return null;
  if (Number(cc.ephemeral_1h_input_tokens) > 0) return { ttl_s: 3600, field: 'ephemeral_1h_input_tokens', tokens: Number(cc.ephemeral_1h_input_tokens) };
  if (Number(cc.ephemeral_5m_input_tokens) > 0) return { ttl_s: 300, field: 'ephemeral_5m_input_tokens', tokens: Number(cc.ephemeral_5m_input_tokens) };
  return null;
}

const lineName = (o) => (o.uuid ? `line uuid ${o.uuid}` : (o.timestamp ? `line timestamp ${o.timestamp}` : 'an unnamed line'));

// The cache timer. `scan` is cmd-agents' scanTail result. One API message spans several stream lines (one
// per content block), so the age is taken from the earliest line of the latest message (`first_assistant`):
// that line's timestamp is nearest the request. It is still when the reply began to be recorded, slightly
// after the request went out, so `left_ms` can be over by about one response time. A cache read refreshes
// the lifetime, so the latest own line counts even if it only read; the lifetime itself comes from the
// latest own line in the tail that wrote.
function cacheOf(scan, now) {
  const out = { ttl_s: null, ttl_established_by: null, last_request_at_ms: null, age_ms: null, left_ms: null, state: 'unknown' };
  if (!scan || !scan.exists) { out.ttl_established_by = scan && scan.skipped ? scan.skipped : 'no stream to read'; return out; }
  const last = scan.first_assistant || scan.assistant;
  if (!last) { out.ttl_established_by = `no assistant line of the agent's own in the ${scan.bytes_read} bytes of stream tail read`; return out; }
  const ts = Date.parse(last.timestamp);
  if (Number.isFinite(ts)) {
    out.last_request_at_ms = ts;
    out.age_ms = Math.max(0, now - ts);
  }
  const sp = scan.split;
  if (!sp) {
    out.ttl_established_by = `no assistant line of the agent's own in the ${scan.bytes_read} bytes of stream tail read has a non-zero message.usage.cache_creation split; the lifetime is not assumed`;
    return out;
  }
  out.ttl_s = sp.ttl_s;
  out.ttl_established_by = `${lineName(sp.line)}, message.usage.cache_creation.${sp.field}=${sp.tokens}`;
  if (out.last_request_at_ms == null) { out.ttl_established_by += '; the latest own assistant line has no usable timestamp'; return out; }
  out.left_ms = sp.ttl_s * 1000 - out.age_ms;
  out.state = out.left_ms <= 0 ? 'cold' : (out.left_ms < Math.min(LOW_CAP_MS, sp.ttl_s * 1000 * 0.2) ? 'low' : 'warm');
  return out;
}

function cacheText(c) {
  if (!c || c.state === 'unknown') return '?';
  if (c.state === 'cold') return 'cold';
  const s = Math.floor(c.left_ms / 1000);
  const t = s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : (s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`);
  return `${t} ${c.state}`;
}

// The last event of the agent's own in the window, and every tool call not yet answered. Walks back over
// at most 60 events of its own (a subagent's lines, which carry `parent_tool_use_id`, and a synthetic
// message are passed over) and stops at a result line. `kind` is the newest event: a result line, an
// assistant line or a user line. `calls` is each tool_use with no tool_result after it, oldest first, so
// parallel calls are all named. A call's `ts_ms` is its line's timestamp.
function tailEvent(lines) {
  let tried = 0, kind = null;
  const answered = new Set();
  const calls = [];
  for (let i = lines.length - 1; i >= 0 && tried < 60; i -= 1) {
    const l = lines[i];
    if (!l.includes('"type":"assistant"') && !l.includes('"type":"user"') && !l.includes('"type":"result"')) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (!o || o.parent_tool_use_id || (o.type !== 'assistant' && o.type !== 'user' && o.type !== 'result')) continue;
    if (o.type === 'result') { kind = kind || 'result'; break; }
    if (o.type === 'assistant' && o.message && o.message.model === '<synthetic>') continue;
    tried += 1;
    kind = kind || o.type;
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of content) {
      if (!b) continue;
      if (o.type === 'user' && b.type === 'tool_result') answered.add(b.tool_use_id);
      else if (o.type === 'assistant' && b.type === 'tool_use' && !answered.has(b.id)) {
        const ts = Date.parse(o.timestamp);
        const t = Number(b.input && b.input.timeout_ms); // a permission wait names its own bound
        calls.push({ id: b.id, name: String(b.name), ts_ms: Number.isFinite(ts) ? ts : null, input_timeout_ms: Number.isFinite(t) && t > 0 ? t : null });
      }
    }
  }
  return kind ? { kind, calls: calls.reverse() } : null;
}

// The agent's current task. A worker's task is the one whose unreleased lease it holds (task.list's
// `lease.holder`); with none held, the worker row's task_id. The task row has no title column, so the
// title is the first non-empty line of its spec.
function taskOf(task, source) {
  if (!task) return null;
  const spec = typeof task.spec === 'string' ? task.spec : '';
  const first = spec.split('\n').map((l) => l.trim()).find((l) => l);
  return { id: task.id, title: first ? P.clean(first, 80) : null, title_source: 'first non-empty line of the task spec', source };
}

function currentTask(w, tasksById, leaseTaskOf) {
  const held = leaseTaskOf.get(w.id);
  if (held) return taskOf(held, 'unreleased lease held by this worker (task.list lease.holder)');
  const row = w.task_id ? tasksById.get(w.task_id) : null;
  return taskOf(row, 'worker row task_id (no unreleased lease held by this worker)');
}

const ds = (state, by) => ({ display_state: state, display_state_established_by: by });

// A worker. `stall` is cmd-notices' stallAge result ({ age, source }) or null; `pending` is whether a
// pending permission row names this worker. A fact the data does not give is `unknown`, never a guess.
function workerDisplay(w, { pending, stall, stallMs = STALL_MS }) {
  const hasPid = w.pid != null;
  const pid = `pid ${hasPid ? w.pid : 'not recorded'}`;
  if (w.state === 'dead') return ds('dead', `worker row state dead${w.death_established_by ? `, death_established_by ${w.death_established_by}` : ''}`);
  if (w.state === 'stopped' || w.state === 'forgotten') return ds('done', `worker row state ${w.state}`);
  if (w.state === 'paused') return ds('parked', 'worker row state paused (ADR 0023 amendment 2: the process ended, the session is kept)');
  if (w.substrate === 'codex' && w.state === 'idle') return ds('idle', 'worker row state idle; Codex between turns has no process by design (api.md §2)');
  if (w.state === 'starting' && !hasPid) return ds('starting', 'worker row state starting, no pid recorded yet');
  if (hasPid && w.pid_alive === false) return ds('dead', `worker row state ${w.state} but ${pid} is not alive (worker.list pid_alive)`);
  const live = w.pid_alive === true ? `${pid} alive` : `${pid}, liveness not established`;
  if (pending) return ds('permission', `a pending permission row names this worker; row state ${w.state}, ${live}`);
  if (w.state === 'stopping') return ds('stopping', `worker row state stopping, ${live}`);
  if (w.pid_alive !== true) return ds('unknown', `worker row state ${w.state}, ${live}; a state word alone is only a claim`);
  if (w.state === 'starting' || w.state === 'running') {
    if (!w.mid_turn) return ds('idle', `row state ${w.state}, mid_turn not set, ${live}`);
    const age = stall && stall.age != null ? ` last event ${stall.age} ms ago by ${stall.source}` : ' no last-event age';
    if (stall && stall.age != null && stall.age > stallMs) return ds('stalled', `row state ${w.state}, mid_turn,${age} (over ${stallMs} ms), ${live}`);
    return ds('running', `row state ${w.state}, mid_turn,${age}, ${live}`);
  }
  if (w.state === 'idle') return ds('idle', `worker row state idle, ${live}`);
  return ds('unknown', `worker row state ${w.state} is not one this derivation knows, ${live}`);
}

// The orchestrator. `scan.tail_event` is tailEvent's result and `scan.mtime_ms` the stream's mtime.
// `run.alive` is the run-alive rung (the adapter pid's liveness), not a check of the orchestrator process.
function orchestratorDisplay(run, scan, now, stallMs = STALL_MS) {
  if (run.ended_at != null) return ds('done', 'run row ended_at set');
  if (!run.alive) return ds('dead', 'run row not ended and run.alive false (the adapter pid is not alive; the orchestrator process is not checked)');
  if (run.paused_at != null) return ds('idle', 'run row paused_at set: the run is paused and the orchestrator interrupted (ADR 0023 amendment 3); run.alive is the adapter pid\'s liveness, not the orchestrator process\'s');
  const ev = scan && scan.tail_event;
  if (!ev) return ds('unknown', 'run alive (adapter pid); no stream event of the orchestrator\'s own to read, so running cannot be told apart from idle');
  if (ev.kind === 'result') return ds('idle', 'run alive (adapter pid); the last stream event is a result line');
  const names = ev.calls.map((c) => c.name).join(', ');
  if (ev.calls.some((c) => WAIT_TOOL.test(c.name))) return ds('waiting', `run alive (adapter pid); unanswered call to ${names} (worker_wait is where an orchestrator waits by design)`);
  const bound = (c) => Math.max(stallMs, EVALUATE_TOOL.test(c.name) ? EVALUATE_TIMEOUT_MS : 0, c.input_timeout_ms || 0);
  // each call is aged against its own bound; the one furthest past its bound decides (all must be under theirs to run)
  const over = ev.calls.filter((c) => c.ts_ms != null).map((c) => ({ c, age: Math.max(0, Math.round(now - c.ts_ms)), bound: bound(c) })).sort((a, b) => (b.age - b.bound) - (a.age - a.bound));
  if (over.length) {
    const o = over[0];
    const what = `unanswered call to ${names}, most overdue call (${o.c.name}) line timestamp ${o.age} ms ago (bound ${o.bound} ms)`;
    return o.age > o.bound ? ds('stalled', `run alive (adapter pid); ${what}`) : ds('running', `run alive (adapter pid); ${what}`);
  }
  const from = scan.mtime_ms != null ? { at: scan.mtime_ms, what: `mid-turn (last stream event is ${ev.kind}), stream mtime` } : null;
  if (!from) return ds('running', `run alive (adapter pid), mid-turn (last stream event is ${ev.kind}); no timestamp to age it by`);
  const age = Math.max(0, Math.round(now - from.at));
  if (age > stallMs) return ds('stalled', `run alive (adapter pid); ${from.what} ${age} ms ago (over ${stallMs} ms)`);
  return ds('running', `run alive (adapter pid); ${from.what} ${age} ms ago`);
}

// ---- the run's mode ------------------------------------------------------------------------------

function readJson(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > FILE_MAX) return { state: 'bad', why: `${file} is not readable as a small file` };
    return { state: 'ok', value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return e.code === 'ENOENT' ? { state: 'absent', why: `${file} does not exist` } : { state: 'bad', why: `${file} is unreadable` };
  }
}

// When the orchestrator stream began: the timestamp on its first line, else the file's birthtime. The
// orchestrator dir and stream.jsonl are reused across epochs, so a stream only counts for an epoch it
// does not predate.
function streamStart(file) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    let head = '';
    try { const b = Buffer.alloc(Math.min(st.size, 65536)); fs.readSync(fd, b, 0, b.length, 0); head = b.toString('utf8'); } finally { fs.closeSync(fd); }
    for (const l of head.split(String.fromCharCode(10)).slice(0, 20)) {
      const m = /"timestamp":"([^"]+)"/.exec(l);
      if (m && Number.isFinite(Date.parse(m[1]))) return { first_ts_ms: Date.parse(m[1]), birthtime_ms: st.birthtimeMs };
    }
    return { first_ts_ms: null, birthtime_ms: st.birthtimeMs };
  } catch { return null; }
}

// The run's mode, in this order. (1) `<orchestrator_dir>/run-start.json`, to be written by the interactive
// launcher (ADR 0037 wave 2) as { run_id, epoch, mode, started_at, launcher_pid }, whose run_id
// and epoch are this run's: interactive. (2) `run.json`, the closing receipt, whose
// run_id and epoch are this run's (an earlier epoch's receipt never answers): its mode. (3) No marker and
// an orchestrator stream in that directory, only in epoch 1 (the stream is appended to across epochs and started_at is inherited), that began at or after the run row's started_at: headless. (4) Otherwise null, with the reason.
function modeOf(orchDir, run, stream) {
  const marker = readJson(`${orchDir}/run-start.json`);
  if (marker.state === 'ok' && require('./transcript-usage.cjs').markerMatches(marker.value, run)) return { mode: 'interactive', mode_source: `${orchDir}/run-start.json run_id ${run.id} epoch ${marker.value.epoch} (the row is at ${run.epoch}; the adapter's attach bumps it past the launcher's)` };
  const why = [marker.state === 'ok' ? `${orchDir}/run-start.json names another run or epoch` : marker.why];
  const rec = readJson(`${orchDir}/run.json`);
  if (rec.state === 'ok' && rec.value) {
    const v = rec.value;
    const store = v.store || {};
    const epochs = [store.attach && store.attach.epoch, store.ended && store.ended.epoch].filter((e) => e != null);
    if (v.run_id !== run.id) why.push(`${orchDir}/run.json names another run`);
    else if (!epochs.length || !epochs.includes(run.epoch)) why.push(`${orchDir}/run.json epoch ${epochs.length ? epochs.join('/') : 'not recorded'} does not match the run row's epoch ${run.epoch}`);
    else if (v.mode === 'headless' || v.mode === 'interactive') return { mode: v.mode, mode_source: `${orchDir}/run.json mode, run_id and epoch ${run.epoch} match the run row` };
    else why.push(`${orchDir}/run.json records no mode`);
  } else why.push(rec.why);
  if (stream && run.epoch !== 1) {
    why.push(`the stream in ${orchDir} is shared across epochs (it is appended to, and the run row's started_at is inherited), so it cannot show epoch ${run.epoch}'s mode; the launch marker is the source`);
  } else if (stream) {
    const began = stream.first_ts_ms != null ? stream.first_ts_ms : stream.birthtime_ms;
    const by = stream.first_ts_ms != null ? 'first line timestamp' : 'file birthtime';
    if (began != null && run.started_at != null && began >= run.started_at) return { mode: 'headless', mode_source: `epoch 1; a stream exists in ${orchDir} that began at or after the run row's started_at (${by}); ${why.join('; ')}; headless is inferred from the absence of a launch marker, not recorded` };
    why.push(`the stream in ${orchDir} may predate this run (${by} ${began == null ? 'not known' : began}, run row started_at ${run.started_at})`);
  }
  return { mode: null, mode_source: `not told apart: ${why.join('; ')}${stream ? '' : `; no orchestrator stream in ${orchDir}`}` };
}

module.exports = { streamStart, STALL_MS, splitOf, cacheOf, cacheText, tailEvent, taskOf, currentTask, workerDisplay, orchestratorDisplay, modeOf };
