'use strict';
require('../helpers/tmp.cjs');
// embedder-delete-store-dir.test.cjs — `embedder delete` finds the store the way every other command does: the --data
// override, then the project config's data_dir, then <project root>/.belay. The dispatcher always fills ctx.dataDir with
// <cwd>/.belay and sets ctx.dataDirGiven only for --data, so a command must not read ctx.dataDir directly.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core } = require('../core/helpers.cjs');
const { GGUF_MODELS } = require('../../src/core/gguf-models.cjs');
const embedderExtra = require('../../src/cli/cmd-embedder-extra.cjs');

const { Store } = core('store.cjs');
const R4 = 'giladgd/Qwen3-Reranker-4B-GGUF';
let root, cache0;
const fwd = (p) => p.split(path.sep).join("/");
const mk = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return fwd(d); };

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-storedir-'));
  cache0 = process.env.BELAY_MODEL_CACHE;
  process.env.BELAY_MODEL_CACHE = mk('models');
});
after(() => {
  if (cache0 === undefined) delete process.env.BELAY_MODEL_CACHE; else process.env.BELAY_MODEL_CACHE = cache0;
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeFetch(entry) {
  const dir = path.join(process.env.BELAY_MODEL_CACHE, `${entry.id}@${entry.sha}`);
  for (const f of entry.files) { const p = path.join(dir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); const fd = fs.openSync(p, 'w'); fs.ftruncateSync(fd, f.bytes); fs.closeSync(fd); }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sha: entry.sha }));
  return dir;
}
function liveStore(data) {
  fs.mkdirSync(data, { recursive: true });
  const store = new Store(path.join(data, 'memory.db'), { stamp: true });
  const pin = { routing: { run: { embedder: R4, reranker: R4, profile: 'gpu-rerank' } } };
  store.p('INSERT INTO run(id, epoch, adapter_pid, started_at, ended_at, retrieval_routing, written_at, written_by) VALUES (?, 1, ?, ?, ?, ?, ?, ?)')
    .run('r-live', 1, Date.now(), null, JSON.stringify(pin), Date.now(), 't');
  store.close();
}
// What the dispatcher builds when --data is not given.
const ctxFor = (cwd, extra) => ({ argv: ['delete', R4], cwd, dataDir: `${cwd}/.belay`, dataDirGiven: false, json: true, ...extra });

test('delete refuses a model a live run pins when data_dir comes from the config, and from a project subdirectory', async () => {
  const proj = mk('pd');
  fs.writeFileSync(path.join(proj, 'belay.config.json'), JSON.stringify({ project: 'acme', data_dir: 'store' }));
  const sub = mk('pd/sub');
  const dir = fakeFetch(GGUF_MODELS[R4]);
  // The live run's adapter pid must be alive and verifiable: this process.
  liveStore(`${proj}/store`);
  const db = new Store(`${proj}/store/memory.db`, { stamp: true });
  db.p('UPDATE run SET adapter_pid = ?').run(process.pid);
  db.close();
  for (const cwd of [proj, sub]) {
    const r = await embedderExtra.run(ctxFor(cwd));
    assert.strictEqual(r.code, 1, `cwd ${cwd}: ${r.text}`);
    assert.match(r.text, /run r-live/);
    assert.ok(fs.existsSync(dir), 'nothing was removed');
  }
});

