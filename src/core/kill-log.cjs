'use strict';
// kill-log.cjs — ADR 0039 P2, made small: a refusal counter. When BELAY_KILL_LOG names a file, every kill
// attempt in process.cjs appends one JSONL line { time, pid, via, ok, kind, detail, caller, fn }. Unset, the
// only cost is the one environment lookup: no stack is captured and nothing is written. A failed append is
// swallowed; the log is a measurement and never changes what a kill does.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const OWN = /[\\/]core[\\/](process|kill-log)\.cjs:/;
const FRAME = /\(?((?:[A-Za-z]:)?[\\/][^():]+|node:[^():]+):(\d+):\d+\)?$/;

const logPath = () => process.env.BELAY_KILL_LOG || null;

// The first stack frame outside the kill mechanics, as `<repo-relative file>:<line>`. Taken synchronously at
// the call, because a snapshot kill finishes after an await that loses the caller's frames.
function callerOf(stack) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    if (OWN.test(line)) continue;
    const m = FRAME.exec(line.trim());
    if (!m) continue;
    const rel = m[1].startsWith('node:') ? m[1] : path.relative(REPO, m[1]);
    return `${rel.split(path.sep).join('/')}:${m[2]}`;
  }
  return null;
}

// The identity the target offers, before any check: a handle, a creation time, an image only, or nothing.
function viaOf(target) {
  if (typeof target === 'number') return 'bare';
  if (target && typeof target === 'object' && 'exitCode' in target && 'signalCode' in target) return 'handle';
  if (target && typeof target === 'object' && 'pid' in target) return target.created == null ? 'image' : 'created';
  return 'unknown';
}

// Called at the start of a kill: returns a recorder for its result, or null when logging is off.
function begin(fn, target) {
  const file = logPath();
  if (!file) return null;
  const caller = callerOf(new Error().stack);
  const pid = typeof target === 'number' ? target : target && target.pid;
  return (r) => {
    const ok = !!(r && r.ok);
    const line = {
      time: new Date().toISOString(), pid: Number.isInteger(pid) ? pid : null,
      via: (r && r.identity && r.identity.via) || viaOf(target), ok,
      kind: ok ? null : ((r && r.kind) || (r && r.error ? 'error' : 'unverifiable')),
      detail: ok ? null : ((r && (r.detail || r.error)) || null), caller, fn,
    };
    try { fs.appendFileSync(file, `${JSON.stringify(line)}\n`); } catch { /* the log never changes a kill */ }
    return r;
  };
}

module.exports = { begin, callerOf, viaOf, logPath };
