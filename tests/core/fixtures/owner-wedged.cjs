'use strict';
// owner-wedged.cjs — a LIVE but WEDGED store owner (review 3, MF3-1): it elects itself, prints READY,
// then blocks its event loop for argv[3] ms (pid alive, pipe accepting at the OS level, nothing
// answering) and exits. argv[2] is the data dir.
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { openCore } = require(path.join(ROOT, 'src', 'core', 'index.cjs'));

(async () => {
  const c = await openCore({ dataDir: process.argv[2], caller: { role: 'orchestrator', run_id: 'r-wedge', pid: process.pid }, embed: true });
  await c.task.create({ spec: 'elect' });
  process.stdout.write('READY\n');
  setTimeout(() => { const end = Date.now() + Number(process.argv[3] || 8000); while (Date.now() < end) { /* wedged */ } process.exit(0); }, 200);
})().catch((e) => { console.log(JSON.stringify({ error: e.code || e.message })); process.exit(1); });
