'use strict';
// trace-sweep.cjs — the temp files belay's traced git runs leave behind when their process dies mid-git, and the sweep that
// removes them. runTraced (git-hooks.cjs) writes `belay-trace-<pid>-<uuid>.json` in the temp folder and removes it when git
// returns; a process killed in between never gets there. The sweep deletes only a file that belay wrote and whose writer is gone,
// and every guard below must hold. A live pid proves nothing (the host may have handed a dead writer's pid to another process),
// so only a dead pid counts; a file left behind is acceptable, a file deleted that belay did not write is not.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The writer's name and the sweep's pattern come from this one place, so the two cannot drift.
const traceFileName = (pid, id) => `belay-trace-${pid}-${id}.json`;
const TRACE_NAME = /^belay-trace-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

const CAP = 50; // matching entries examined in one sweep
// A second guard beside the dead pid: a writer that lives where this process cannot see it (another pid namespace sharing the
// temp folder) looks dead, and git can hold a trace open for a long merge; ten minutes is longer than either is likely to matter.
const MIN_AGE_MS = 10 * 60 * 1000;
const TRACE2_HEAD = '{"event":';

// True only when the pid is certainly gone (ESRCH). EPERM means it exists; anything else is not an answer, so the file stays.
function pidGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

// First bytes of the file, or null when it cannot be read. '' for an empty file.
async function head(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(TRACE2_HEAD.length);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch { return null; } finally { if (fh) await fh.close().catch(() => {}); }
}

// One sweep of `dir` (top level only). -> the names removed. Never throws; an error on one file skips that file.
// Seams for tests: dir, gone(pid), now, cap, unlink, selfPid.
async function sweep(opts = {}) {
  const dir = opts.dir || os.tmpdir();
  const gone = opts.gone || pidGone;
  const now = opts.now === undefined ? Date.now() : opts.now;
  const cap = opts.cap || CAP;
  const unlink = opts.unlink || (f => fs.promises.unlink(f));
  const selfPid = opts.selfPid === undefined ? process.pid : opts.selfPid;
  const removed = [];
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return removed; }
  let examined = 0;
  for (const ent of entries) {
    const m = ent.name.startsWith('belay-trace-') && TRACE_NAME.exec(ent.name);
    if (!m) continue;
    if (examined++ >= cap) break;
    try {
      const file = path.join(dir, ent.name);
      const st = await fs.promises.lstat(file);
      if (!st.isFile() || st.isSymbolicLink()) continue;
      const pid = Number(m[1]);
      if (pid === selfPid || !gone(pid)) continue;
      if (now - st.mtimeMs < MIN_AGE_MS) continue;
      const first = await head(file);
      if (first === null || (first !== '' && first !== TRACE2_HEAD)) continue; // an empty file is git dying before it wrote
      await unlink(file);
      removed.push(ent.name);
    } catch { /* skip this file */ }
  }
  return removed;
}

// At most once per process, started the first time runTraced finishes a git call and not awaited. Never throws.
let started = false;
function sweepOnce(opts) {
  if (started) return null;
  started = true;
  try { return sweep(opts).catch(() => []); } catch { return null; }
}
const resetForTests = () => { started = false; };

module.exports = { traceFileName, TRACE_NAME, sweep, sweepOnce, resetForTests, pidGone, CAP, MIN_AGE_MS };
