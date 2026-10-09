'use strict';
// writer.cjs — one client process for the A7 shape in miniature: N memory.store calls against a live
// owner, with caller-supplied embeddings so nothing here needs an embedding model. Prints the acked ids
// so the parent can reconcile acked against rows (P3: acked_but_missing and unacked_but_present).
const path = require('node:path');
const { openCore } = require(path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'index.cjs'));

const [dataDir, label, nRaw] = process.argv.slice(2);
const n = Number(nRaw || 100);
const DIM = 8;

function vec(i) {
  const v = new Array(DIM).fill(0);
  v[i % DIM] = 1 + (i % 5) / 10;
  v[(i + 3) % DIM] = 0.25;
  return v;
}

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
        namespace: 'a7', text: `${label} entry ${i}`, tags: ['a7', label],
        embedding: vec(i), embedding_model: 'test-fixture', dim: DIM,
      });
      acked.push(r.id);
    } catch (e) { errors.push({ i, code: e.code, message: e.message }); }
  }
  await core.close();
  process.stdout.write(JSON.stringify({ label, acked, errors }) + '\n');
})().catch(e => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
