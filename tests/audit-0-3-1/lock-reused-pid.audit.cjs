'use strict';
// lock-reused-pid.audit.cjs — audit 0.3.1, core finding C4. Not globbed by `npm test` (*.audit.cjs).
// Run: node --test tests/audit-0-3-1/lock-reused-pid.audit.cjs
//
// An owner that dies without its handlers (a Windows terminate of `belay run`) leaves owner.lock behind. Staleness is a bare
// pid check (lock.cjs:191, pidAlive), and owner.json records no process creation time, so once Windows hands that pid to any
// other process the lock reads as held for as long as that process lives: every election fails E_LOCKED and every write ends
// E_NO_OWNER, although no pipe answers. The stand-in for "the pid was reused" is a live child whose pid the planted lock names.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { core, sandbox, cleanup, callerFor } = require('../core/helpers.cjs');
const { openCore } = core('index.cjs');
const { pipeName } = core('lock.cjs');

test('C4: a dead owner\'s lock whose pid now names an unrelated live process blocks every write', async () => {
  const dir = sandbox();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => other.once('spawn', r));
  const lockDir = path.join(dir, 'owner.lock');
  fs.mkdirSync(lockDir);
  // exactly what a serving owner leaves: owner.json with listening true (markListening rewrote it) and its marker
  const token = 'deadbeef0001';
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: other.pid, pipe: pipeName(dir), listening: true, mode: 'claimed', token, acquired_at: Date.now() - 60000, listening_at: Date.now() - 59000 }));
  const orch = await openCore({ dataDir: dir, caller: callerFor('orchestrator'), embed: false });
  const t0 = Date.now();
  let outcome;
  try { outcome = { ok: true, value: await orch.run.attach({ adapter_pid: process.pid }) }; }
  catch (e) { outcome = { ok: false, code: e.code, message: e.message }; }
  const ms = Date.now() - t0;
  try {
    console.log(JSON.stringify({ planted_pid: other.pid, ms, outcome: outcome.ok ? 'written' : { code: outcome.code, message: outcome.message } }));
    assert.ok(outcome.ok, 'a lock no pipe answers for is taken over, and the write lands');
  } finally {
    try { await orch.shutdownOwner(); } catch { /* none */ }
    await orch.close();
    try { process.kill(other.pid); } catch { /* gone */ } // the exact pid this test spawned, through its live handle
    await new Promise((r) => (other.exitCode !== null || other.signalCode !== null ? r() : other.once('exit', r)));
    cleanup(dir);
  }
});
