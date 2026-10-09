'use strict';
// crash.cjs — ADR 0039: the test plays the outside world, but it too may only kill what it can prove. belay's
// kill API refuses a bare pid, and so does this. Three ways in, nothing else:
//   - crash(handle): a child handle that is still live (exitCode and signalCode both null);
//   - crash(pid, created): a pid with the creation time its own row recorded (`pid_created`), matching one
//     fresh snapshot EXACTLY. A row with no pid_created is not signalled;
//   - crashDescendant(pid): a pid that is, right now, in this test process's own process tree (created at or
//     after its parent at every step), for fixtures a spawned dispatcher started.
// `note(handle)` records a live handle's creation time for a later crash(pid) and refuses a bare pid, because
// a creation time read for a pid nobody holds proves nothing. A snapshot costs about a second.

const ID = require('../src/core/proc-identity.cjs');

const noted = new Map(); // pid -> creation time, kept only while its handle was live when the read landed

function note(handle, { snapshot = ID.processSnapshot } = {}) { // `snapshot` is a test seam
  if (!handle || typeof handle !== 'object' || !Number.isInteger(handle.pid)) throw new TypeError('note() takes a live child handle, never a bare pid');
  if (!ID.handleLive(handle)) return handle;
  const pid = handle.pid;
  snapshot().then((s) => {
    const e = s && s.get(pid);
    if (e && e.created != null && ID.handleLive(handle)) noted.set(pid, e.created); // discarded if the child exited meanwhile
  }).catch(() => {});
  return handle;
}

function crash(target, created) {
  if (target && typeof target === 'object') {
    // An object that is not a child handle (a wrapper holding one) is a test bug, not a dead process: say so.
    if (!('exitCode' in target && 'signalCode' in target)) throw new TypeError('crash() takes a child handle, a pid with its creation time, or nothing');
    if (!ID.handleLive(target)) return false;
    try { process.kill(target.pid, 'SIGKILL'); return true; } catch { return false; }
  }
  const pid = target;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const want = created != null ? created : noted.get(pid);
  if (want == null) return false;
  const s = ID.processSnapshotSync(); const e = s && s.get(pid);
  if (!e || e.created !== want) return false;
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

// crash(pid, created) by the async snapshot. For a test whose own process hosts the worker's run manager: the
// synchronous snapshot holds that loop for about a second, so the manager's pid poll is overdue when the loop
// resumes and settles the death (with no exit code) before the child's 'exit' event is read.
async function crashAsync(pid, created) {
  if (!Number.isInteger(pid) || pid <= 0 || created == null) return false;
  const s = await ID.processSnapshot(); const e = s && s.get(pid);
  if (!e || e.created !== created) return false;
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

// One snapshot, leaves first: killing a parent first would hide its children (their recorded parent is gone).
function crashDescendants(pids) {
  const s = ID.processSnapshotSync();
  if (!s) return [];
  const want = new Set(pids.filter((p) => Number.isInteger(p) && p > 0));
  const killed = [];
  for (const d of ID.descendantsOf(process.pid, s).leavesFirst) {
    if (!want.has(d.pid)) continue;
    try { process.kill(d.pid, 'SIGKILL'); killed.push(d.pid); } catch { /* gone */ }
  }
  return killed;
}
const crashDescendant = (pid) => crashDescendants([pid]).length === 1;

// Record the creation time of a pid that is, right now, in this process's own tree, so a later crash(pid) can
// end it after its parent is gone (an orphaned grandchild). Returns whether it was recorded.
function noteDescendant(pid) {
  const s = ID.processSnapshotSync();
  const d = s && ID.descendantsOf(process.pid, s).leavesFirst.find((x) => x.pid === pid);
  if (!d || d.created == null) return false;
  noted.set(pid, d.created);
  return true;
}

module.exports = { crash, crashAsync, note, crashDescendant, crashDescendants, noteDescendant, noted };
