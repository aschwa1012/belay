'use strict';
// lock-race.cjs — one contender for the owner lock. Prints {"won":bool}. Several of these are run at
// once against a data dir holding a stale lock: exactly one must report won.
//
// build step 6i item 9(c) (6h carried item 1): the winner used to hold the lock only for `holdMs`, timed
// from its own acquire, then exit -- so a winner whose own process the OS merely scheduled late could
// still exit (a dying process is exactly as stale as a crashed one) before every racer had made its one
// attempt, leaving a fresh, genuinely-stale lock a still-retrying loser could then legitimately take over
// too: two sequential, individually-correct takeovers a single-generation assertion reads as a violation.
// 6h's own reproduction was under a concurrent full `npm test` (two winners in 5 of 10 runs, 0/20 quiet);
// this step's own instrument (`log()` below, driven under a CPU burner, 16 then 32 processes, 10 rounds
// each) never turned up a second winner on this host (this step's own `deviations`) -- a negative result,
// not a refutation of the mechanism 6h already isolated from the real evidence above.
// The fix: a barrier file per racer, in the data dir itself (no store, so nothing else touches it) --
// the winner exits only once every racer named in `count` has made its own attempt, never on a timer
// alone, so no loser is ever still inside its own retry budget when the lock actually goes stale.
const fs = require('node:fs');
const path = require('node:path');
const { acquireLock } = require(path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'lock.cjs'));

const dataDir = process.argv[2];
const holdMs = Number(process.argv[3] || 1500);
const count = Number(process.argv[4] || 1); // racers in this round, for the winner's own barrier wait
const logPath = process.argv[5] || null; // instrumentation only (item 9(c)'s own log); never required

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

// This racer's own barrier mark, written whether it won or lost -- the fact the fix's own wait below
// reads back, never a timer's guess at how long its siblings might still take.
try { fs.writeFileSync(path.join(dataDir, `.race-mark-${process.pid}`), String(attemptAt)); } catch { /* best effort */ }

if (r.won) {
  // Waits for every racer's own mark, not a timer's guess at how long its siblings might still take;
  // `holdMs` is now only the bound for a crashed sibling that never marks at all. Exits without
  // releasing (the lock is left standing, naming this pid, as the assertion below reads it).
  const deadline = attemptAt + Math.max(holdMs, 5000);
  while (now() < deadline) {
    let marks = 0;
    try { marks = fs.readdirSync(dataDir).filter((f) => f.startsWith('.race-mark-')).length; } catch { /* dataDir gone */ }
    if (marks >= count) break;
    sleepSync(20);
  }
  log({ event: 'exit', at: now() });
  process.exit(0);
}
