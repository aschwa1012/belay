'use strict';
// owner-embed-stop.cjs — a store owner in its own process that is stopped while a long embed is in
// flight in its embedder child (review 2, MF1). argv[2] is the data dir. It prints JSON lines:
// { ready, owner_pid, embedder_pid } once the embed is in flight, then shuts the owner down through its
// own shutdown call and lets the process end by itself, without process.exit. A correct build exits 0
// promptly; the worker-thread build lingered ~25 s and died with 0xC0000409.
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { openCore } = require(path.join(ROOT, 'src', 'core', 'index.cjs'));

(async () => {
  const c = await openCore({ dataDir: process.argv[2], caller: { role: 'orchestrator', run_id: 'r-stop', pid: process.pid }, embed: true });
  const long = c.memory.store({ namespace: 'stop', text: 'word '.repeat(7000) }).then(() => 'stored', (e) => e.code);
  const t0 = Date.now();
  for (;;) {
    const o = c.owner && c.owner.embedderObj;
    if (o && o.pipe && o.pending.size > 0) break;
    if (Date.now() - t0 > 90000) throw new Error('the embed never went in flight');
    await new Promise((r) => setTimeout(r, 5));
  }
  // Let the embed get past tokenizing and into onnx's native run, where a thread could not be interrupted.
  await new Promise((r) => setTimeout(r, 800));
  console.log(JSON.stringify({ stopping: true, owner_pid: process.pid, embedder_pid: c.owner.embedderObj.pid }));
  if (process.argv[3] === 'hold') { setInterval(() => {}, 1000); return; } // the test kills this process by its exact pid
  await c.shutdownOwner();
  await c.close();
  console.log(JSON.stringify({ stopped: true, in_flight: await long }));
})().catch((e) => { console.log(JSON.stringify({ error: e.code || e.message })); process.exit(1); });
