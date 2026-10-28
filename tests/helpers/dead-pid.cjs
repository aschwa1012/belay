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

module.exports = { deadPid, FLOOR, CEILING };
