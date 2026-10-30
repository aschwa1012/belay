'use strict';
// rerank-owner-hold.cjs — an owner in its own process that holds a CPU rerank client whose REAL child (on a stub
// transformers package) has a slow op in flight. Needs BELAY_TEST_MODE=1. argv: <pkgDir> <cacheDir> <tableJson>. Prints
// one JSON line { owner_pid, rerank_pid } once the child is busy, then idles until a test kills it by its exact pid
// (rerank-cpu-proc.test.cjs checks the child goes with it).
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { CpuRerankClient } = require(path.join(ROOT, 'src', 'core', 'rerank-cpu.cjs'));

(async () => {
  const table = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  const c = new CpuRerankClient({ pkg: process.argv[2], cacheDir: process.argv[3], table }).start();
  await c.load(Object.keys(table)[0]);
  const started = new Promise(res => c.child.on('message', (m) => { if (m && m.event === 'sleep_started') res(); })); // the child's own announcement, not a guessed wait
  c._call({ op: 'sleep', ms: 60000 }, 120000).catch(() => {});
  await started;
  console.log(JSON.stringify({ owner_pid: process.pid, rerank_pid: c.pid }));
  setInterval(() => {}, 1000);
})().catch((e) => { console.log(JSON.stringify({ error: e.code || e.message })); process.exit(1); });
