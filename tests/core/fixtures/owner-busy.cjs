'use strict';
// owner-busy.cjs — a LIVE store owner that is only BUSY (build 12b E2): it elects itself, prints READY,
// blocks its event loop once for argv[3] ms (the shape of a CreateProcess for the embedder child), then
// serves its pipe normally until the test stops it through the pipe's shutdown. argv[2] is the data dir.
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { openCore } = require(path.join(ROOT, 'src', 'core', 'index.cjs'));

(async () => {
  const c = await openCore({ dataDir: process.argv[2], caller: { role: 'orchestrator', run_id: 'r-busy', pid: process.pid }, embed: false, ownerOpts: { exitOnShutdown: true } });
  await c.task.create({ spec: 'elect' });
  process.stdout.write('READY\n');
  setTimeout(() => { const end = Date.now() + Number(process.argv[3] || 700); while (Date.now() < end) { /* busy */ } process.stdout.write('FREE\n'); }, 200);
})().catch((e) => { console.log(JSON.stringify({ error: e.code || e.message })); process.exit(1); });
