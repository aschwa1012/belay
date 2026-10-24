'use strict';
// lock-race.cjs <dataDir> [logPath] — one contender for the owner lock. Prints {"won":bool,"pid":n} as
// its first line. Several of these are run at once against a data dir holding a stale lock: exactly one
// must report won, and no winner may lose its lock while it still holds it.
//
// A winner holds the lock until the parent writes <dataDir>/release, which the parent does only once
// every racer has printed its result or exited, so no racer is still inside its own retry budget when
// the winner goes. The winner's exit leaves a genuinely stale lock behind, and a racer that started
// late (a slow node startup on a loaded machine) may then rightly take it over: two sequential owners,
// never two at once. A wait on a timer could not tell those apart; the release file can. 60 s is only
// the bound for a parent that never writes it.
//
// While it holds, the winner re-reads owner.json every 10 ms and prints a second line on exit,
// {"exit":true,"pid":n,"robbed":null|{by,at}}: robbed when owner.json ever names another pid, is
// missing, or is not whole JSON, which is a live owner losing its lock (the failure that matters).
const fs = require('node:fs');
const path = require('node:path');
const { acquireLock } = require(path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'lock.cjs'));

const dataDir = process.argv[2];
const logPath = process.argv[3] || null; // instrumentation only; never required
const HOLD_BOUND_MS = 60000;

const now = () => Date.now();
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ } };

function log(entry) {
  if (!logPath) return;
  try { fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...entry }) + '\n'); } catch { /* instrumentation only */ }
}

const spawnedAt = now();
const r = acquireLock(dataDir, { pipe: 'test' });
const attemptAt = now();
log({ event: 'attempt', spawned_at: spawnedAt, attempt_at: attemptAt, won: !!r.won });
process.stdout.write(JSON.stringify({ won: !!r.won, pid: process.pid }) + '\n');

if (r.won) {
  const meta = path.join(dataDir, 'owner.lock', 'owner.json');
  const release = path.join(dataDir, 'release');
  const deadline = attemptAt + HOLD_BOUND_MS;
  let robbed = null;
  while (now() < deadline && !fs.existsSync(release)) {
    if (!robbed) {
      let text = null;
      try { text = fs.readFileSync(meta, 'utf8'); } catch (e) { if (e.code === 'ENOENT') robbed = { by: 'missing', at: now() }; }
      if (text !== null) {
        let m = null;
        try { m = JSON.parse(text); } catch { robbed = { by: 'not whole JSON', at: now() }; }
        if (m && m.pid !== process.pid) robbed = { by: m.pid, at: now() };
      }
    }
    sleepSync(10);
  }
  const released = fs.existsSync(release);
  log({ event: 'exit', at: now(), robbed, released });
  // Exits without releasing: the lock is left standing, naming this pid, as the parent reads it.
  process.stdout.write(JSON.stringify({ exit: true, pid: process.pid, robbed, released }) + '\n');
  process.exit(0);
}
