'use strict';
// gpu-owner-hold.cjs — an owner in its own process that holds a GPU client whose child has an op in flight.
// Needs BELAY_TEST_MODE=1. Prints one JSON line { owner_pid, gpu_pid } once the child is busy, then idles
// until a test kills it by its exact pid (gpu-proc.test.cjs checks the child goes with it).
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { GpuClient } = require(path.join(ROOT, 'src', 'core', 'gpu.cjs'));

(async () => {
  const c = new GpuClient({ workerPath: path.join(__dirname, 'gpu-worker-fake.cjs') }).start();
  c._call({ op: 'sleep', ms: 60000 }, 120000).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  console.log(JSON.stringify({ owner_pid: process.pid, gpu_pid: c.pid }));
  setInterval(() => {}, 1000);
})().catch((e) => { console.log(JSON.stringify({ error: e.code || e.message })); process.exit(1); });
