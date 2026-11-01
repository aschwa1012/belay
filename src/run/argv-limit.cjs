'use strict';
// argv-limit.cjs — a Codex worker's whole message travels in argv (`exec ... -- <text>`), and Windows caps a command line at 32,767
// UTF-16 characters (CreateProcessW). Past it libuv fails the spawn with ENAMETOOLONG or E2BIG, which Node THROWS from spawn() rather
// than emitting an error event, so nothing downstream sees a child. The launch refuses an oversized command line up front, before any
// process, row change or flag reset, and says what is too long and what to do. A relaunch with a short text is unaffected.

const WIN_CMDLINE_LIMIT = 32767;
const ARGV_MARGIN = 767; // headroom for the quoting Windows adds around arguments (a quote or backslash is escaped, so it counts twice)
const SAFE_LIMIT = WIN_CMDLINE_LIMIT - ARGV_MARGIN;

// A conservative count of the command line `exe args...` becomes: each argument plus its two quotes and a separator, with
// every quote or backslash counted twice for the escape.
function commandLineLength(exe, args) {
  let n = 0;
  for (const a of [exe, ...args]) {
    const s = String(a);
    n += s.length + 3;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c === 34 || c === 92) n++; }
  }
  return n;
}

// Throws E_ARGS when the command line would pass the Windows limit. `limit` is a seam for tests.
// `path` is how the line came about, and the advice follows it: 'spawn' (a first launch), 'message' or 'restart' (a relaunch).
function adviceFor(path, workerId) {
  if (path === 'message') return `shorten the message (put the detail in a file in the worktree and name it); worker ${workerId} keeps its state and no process was started`;
  if (path === 'restart-stopped') return `the text is belay's own relaunch text (the resume line, the hand-back rule and, with memory levers on, the memory preface and index), not the caller's, and worker ${workerId}'s old process was already stopped, so it has none; the usual cause is a large memory index or preface, so trim the notes it lists or turn that memory lever off, then restart again, or spawn a replacement with a new worker id`;
  if (path === 'restart') return `shorten the appended message, or restart without one; worker ${workerId} was not stopped and is still running`;
  return `shorten the task spec or the prompt (put the detail in a file in the worktree and name it) and spawn again with a new worker id, since ${workerId} is used up; no process was started`;
}

function checkCommandLine(exe, args, { substrate = 'codex', workerId = null, limit = SAFE_LIMIT, windows = process.platform === 'win32', path = 'spawn' } = {}) {
  if (!windows) return;
  const length = commandLineLength(exe, args);
  if (length <= limit) return;
  const e = new Error(`${substrate} worker ${workerId}: the launch command line is about ${length} characters by belay's conservative count, over belay's cap of ${limit} (Windows allows ${WIN_CMDLINE_LIMIT}); a ${substrate} worker's message travels in its command line, so ${adviceFor(path, workerId)}`);
  e.code = 'E_ARGS';
  e.detail = { field: 'prompt', reason: 'argv_too_long', command_line_chars_estimate: length, belay_cap: limit, limit: WIN_CMDLINE_LIMIT, path, worker_id: workerId, substrate };
  throw e;
}

// Runs the spawn. Node throws (rather than emits) a spawn error other than EACCES/EAGAIN/EMFILE/ENFILE/ENOENT (ENAMETOOLONG, E2BIG, ...),
// and no child exists then, so no exit listener will settle the row: mark the error so a first launch writes its `starting` row dead.
// After a refused restart's relaunch the row is written dead with leases released. Say what the returned row shows: `row` is what the write
// returned (null when it wrote nothing, as a closed record does), `threw` that the write failed.
function noteDeadWrite(e, row, threw) {
  const dead = !!row && row.state === 'dead';
  const ids = dead && Array.isArray(row.leases_released) ? row.leases_released.map((l) => (l && l.id) || l) : [];
  e.detail = { ...(e.detail || {}), row_dead: dead, lease_released: ids.length > 0, leases_released: ids };
  e.message += dead
    ? (ids.length ? `; the worker row is now dead and its lease ${ids.join(', ')} was released` : '; the worker row is now dead (it held no lease)')
    : `; the worker row could not be marked dead${threw ? ' (the write failed)' : ''}; its lease is kept until its TTL`;
}

function guardSpawn(workerId, doSpawn) {
  try { return doSpawn(); } catch (e) {
    if (e && typeof e === 'object' && !(e.detail && e.detail.reason)) e.detail = { ...(e.detail || {}), reason: 'spawn_throw', worker_id: workerId, spawn_code: e.code || null };
    throw e;
  }
}

module.exports = { noteDeadWrite, guardSpawn, WIN_CMDLINE_LIMIT, SAFE_LIMIT, commandLineLength, checkCommandLine };
