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
function checkCommandLine(exe, args, { substrate = 'codex', workerId = null, limit = SAFE_LIMIT, windows = process.platform === 'win32' } = {}) {
  if (!windows) return;
  const length = commandLineLength(exe, args);
  if (length <= limit) return;
  const e = new Error(`${substrate} worker ${workerId}: the launch command line would be ${length} characters, over the Windows limit of ${WIN_CMDLINE_LIMIT}; a ${substrate} worker's message travels in its command line, so shorten the task spec or the prompt (put the detail in a file in the worktree and name it) and spawn again. No process was started`);
  e.code = 'E_ARGS';
  e.detail = { field: 'prompt', reason: 'argv_too_long', command_line_chars: length, limit: WIN_CMDLINE_LIMIT, worker_id: workerId, substrate };
  throw e;
}

// Runs the spawn. Node throws (rather than emits) a spawn error other than EACCES/EAGAIN/EMFILE/ENFILE/ENOENT (ENAMETOOLONG, E2BIG, ...),
// and no child exists then, so no exit listener will settle the row: mark the error so a first launch writes its `starting` row dead.
function guardSpawn(workerId, doSpawn) {
  try { return doSpawn(); } catch (e) {
    if (e && typeof e === 'object' && !(e.detail && e.detail.reason)) e.detail = { ...(e.detail || {}), reason: 'spawn_throw', worker_id: workerId, spawn_code: e.code || null };
    throw e;
  }
}

module.exports = { guardSpawn, WIN_CMDLINE_LIMIT, SAFE_LIMIT, commandLineLength, checkCommandLine };
