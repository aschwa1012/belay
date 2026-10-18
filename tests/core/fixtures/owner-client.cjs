'use strict';
// owner-client.cjs — a client process of someone else's owner: argv[2] is the data dir. It attaches with one read that is
// answered by the owner's pipe, prints `attached`, and then stays connected and idle until its stdin ends (a clean detach)
// or it is killed (a crash). It never elects: a worker-role caller may not.
const path = require('node:path');
const { openCore } = require(path.join(__dirname, '..', '..', '..', 'src', 'core', 'index.cjs'));

(async () => {
  const c = await openCore({ dataDir: process.argv[2], caller: { role: 'orchestrator', run_id: 'test-run', pid: process.pid }, embed: false });
  await c.worker.list({});
  if (!c.client || !c.client.connected) { process.stdout.write('not-connected\n'); process.exit(2); }
  process.stdout.write('attached\n');
  process.stdin.resume();
  process.stdin.on('end', async () => { await c.close(); process.exit(0); });
  setInterval(() => {}, 1000);
})().catch((e) => { process.stderr.write(`${e && e.stack}\n`); process.exit(1); });
