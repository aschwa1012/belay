'use strict';
// release-owner.cjs — how a CLI command lets go of a store owner it elected (ADR 0051). With no other client attached the owner
// stops now, as shutdownOwner() always did. With one attached it stays up and stops with the last, and the command says so on
// stderr, naming the clients it is waiting for: it never waits in silence. A core without releaseOwner (a test double) is shut down.

const text = (r) => {
  const who = (r.attached || []).map((a) => `${a.pid === null ? 'unidentified' : `pid ${a.pid}`}${a.role ? ` (${a.role})` : ''}`).join(', ');
  return `belay: the store owner (pid ${r.pid}) stays up for the other client(s) attached to it: ${who}. This command ends when they detach; Ctrl-C ends it now and drops them.\n`;
};

async function releaseOwnerOf(core, err = process.stderr) {
  if (typeof core.releaseOwner !== 'function') return core.shutdownOwner();
  const r = await core.releaseOwner();
  if (r && r.deferred) { try { err.write(text(r)); } catch { /* a closed stderr changes nothing */ } }
  return r;
}

module.exports = { releaseOwnerOf };
