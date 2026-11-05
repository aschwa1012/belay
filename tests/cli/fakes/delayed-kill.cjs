'use strict';
// delayed-kill.cjs — ends one process after a delay, as Claude Code ends its MCP server after closing its stdin (ADR 0029), and only
// the process it was given (ADR 0039): { pid, created } is checked against one snapshot taken just before the signal. A pid nothing
// holds, a pid another process now holds (Windows reuses them quickly), an unreadable snapshot or a missing creation time is no signal.
// As a script: node delayed-kill.cjs <pid> <created> <delayMs> [outFile], appending { ev: 'delayed-kill', ... } to outFile when given.
const fs = require('node:fs');
const ID = require('../../../src/core/proc-identity.cjs');

// -> { pid, outcome: 'killed' | 'gone' | 'mismatch' | 'unverifiable', detail? }. `snapshot` and `signal` are test seams.
async function killIfSame({ pid, created, snapshot = () => ID.snapshotRetry({ attempts: 3 }), signal = (p) => process.kill(p, 'SIGKILL') }) {
  if (!Number.isInteger(pid) || pid <= 0) return { pid, outcome: 'unverifiable', detail: 'no pid' };
  if (!Number.isFinite(created)) return { pid, outcome: 'unverifiable', detail: 'no creation time was read while the process lived' };
  const snap = await snapshot();
  if (!snap) return { pid, outcome: 'unverifiable', detail: 'the process snapshot could not be read' };
  const e = snap.get(pid);
  if (!e) return { pid, outcome: 'gone' };
  if (e.created !== created) return { pid, outcome: 'mismatch', detail: `pid ${pid} was created at ${e.created}, expected ${created}` };
  try { signal(pid); } catch (err) { return { pid, outcome: 'gone', detail: (err && err.code) || String(err) }; }
  return { pid, outcome: 'killed' };
}

if (require.main === module) {
  const [pid, created, delayMs, outFile] = process.argv.slice(2);
  setTimeout(async () => {
    const r = await killIfSame({ pid: Number(pid), created: created === 'null' ? null : Number(created) });
    if (outFile) { try { fs.appendFileSync(outFile, JSON.stringify({ t: Date.now(), ev: 'delayed-kill', ...r }) + '\n'); } catch { /* the test reports the missing line */ } }
  }, Number(delayMs) || 0);
}

module.exports = { killIfSame };
