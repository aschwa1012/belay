'use strict';
// own-children.cjs — how many children a test process has, for the tests that assert "this verb left no process behind".
// The parent id alone is not an identity: Windows reuses pids, so an orphan whose recorded parent was an earlier process with
// this pid (left by another test file or an aborted run) looks like this process's child. A real child is never older than its
// parent, so a child is counted only when its creation time is at or after the parent's own, both read from one snapshot
// ({ pid, created } is the identity the product's kills use, ADR 0039).

const ID = require('../../src/core/proc-identity.cjs');

// snap: Map pid -> { ppid, created, image }. -> pids of the children of `pid` created at or after `pid` itself.
function childrenIn(snap, pid) {
  const self = snap.get(pid);
  const floor = self && Number.isFinite(self.created) ? self.created : null;
  const out = [];
  for (const [p, e] of snap) {
    if (e.ppid !== pid || p === pid) continue;
    if (floor !== null && !(Number.isFinite(e.created) && e.created >= floor)) continue;
    out.push(p);
  }
  return out;
}

// After the gate is idle, so a snapshot's own PowerShell from an earlier caller is not counted. Throws when the snapshot is
// unreadable: a count of nothing would make "no process left behind" pass for the wrong reason.
async function ownChildCount() {
  await ID.gate.whenIdle();
  const snap = await ID.processSnapshot({ kind: 'own-probe' });
  if (!snap) throw new Error('the process snapshot was unreadable, so the child count cannot be established');
  return childrenIn(snap, process.pid).length;
}

module.exports = { childrenIn, ownChildCount };
