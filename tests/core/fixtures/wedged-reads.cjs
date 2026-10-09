'use strict';
// wedged-reads.cjs — a client process that does argv[3] reads (memory.list) against a data dir whose
// owner is wedged, prints one JSON line with each read's milliseconds and via, then RETURNS from main
// (no process.exit): the process must end on its own, because a pending libuv connect to a wedged pipe
// would otherwise hold it for ~30 s.
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { openCore } = require(path.join(ROOT, 'src', 'core', 'index.cjs'));

(async () => {
  const c = await openCore({ dataDir: process.argv[2], caller: { role: 'orchestrator', run_id: 'r-reader', pid: process.pid }, embed: false });
  const out = [];
  for (let i = 0; i < Number(process.argv[3] || 6); i += 1) {
    const t0 = Date.now();
    await c.memory.list({});
    const st = await c.status.get({});
    out.push({ ms: Date.now() - t0, via: st.established_by });
  }
  process.stdout.write(JSON.stringify({ done: true, reads: out }) + '\n');
})().catch((e) => { console.log(JSON.stringify({ error: e.code || e.message })); });
