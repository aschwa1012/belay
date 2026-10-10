'use strict';
// writer.cjs — one client process for the A7 shape in miniature: N memory.store calls against a live
// owner, as a worker writing its own run namespace with embed: false, so nothing needs a model. Prints the acked ids
// so the parent can reconcile acked against rows (P3: acked_but_missing and unacked_but_present).
const path = require('node:path');
const { openCore } = require(path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'index.cjs'));

const [dataDir, label, nRaw] = process.argv.slice(2);
const n = Number(nRaw || 100);
(async () => {
  const core = await openCore({
    dataDir,
    caller: { role: 'worker', worker_id: label, run_id: 'a7', pid: process.pid },
    embed: false,
  });
  const acked = [];
  const errors = [];
  for (let i = 0; i < n; i++) {
    try {
      const r = await core.memory.store({
        namespace: 'run/a7', text: `${label} entry ${i}`, tags: ['a7', label], embed: false,
      });
      acked.push(r.id);
    } catch (e) { errors.push({ i, code: e.code, message: e.message }); }
  }
  await core.close();
  process.stdout.write(JSON.stringify({ label, acked, errors }) + '\n');
})().catch(e => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
