'use strict';
// dead-pid.cjs — a pid that no process holds and none will be handed. The pid of a child that has exited is not that: Windows hands
// a dead process's pid out again within seconds (measured on this host: 3 repeats in 150 short children, the first after 39
// spawns), and a suite that spawns git and node continuously takes it. So these are numbers above anything the host issues
// (Windows pids stay below 2^22 and Linux's limit is 4194304; the first one here is 2147483000), counting down so that two calls
// in a process differ. A test that needs a pid with a creation time to match or to differ from uses a real child it holds.

const FLOOR = 2147483000 - 4 * 1000; // every pid deadPid() hands out is above this
const CEILING = 2147483000;
let next = CEILING;

function deadPid() {
  const pid = next;
  next = next > FLOOR ? next - 4 : CEILING;
  return pid;
}

// Whether the process that was started at `startedAt` (its own clock, taken after it was born) still runs under `pid`. A pid that is
// alive is that process only if it was created no later than that; a process created after is another one that was handed the pid
// once the first had gone (ADR 0039), which `process.kill(pid, 0)` cannot tell. A creation time the snapshot cannot read is a failed
// precondition, not an answer.
async function stillRunning(pid, startedAt) {
  const { pidAlive } = require('../../src/core/lock.cjs');
  if (!pidAlive(pid)) return false;
  const { readCreated } = require('./created.cjs');
  const c = await readCreated(pid);
  return c.created <= startedAt;
}

module.exports = { deadPid, stillRunning, FLOOR, CEILING };
