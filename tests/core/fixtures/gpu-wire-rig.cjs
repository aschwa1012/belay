'use strict';
// gpu-wire-rig.cjs — the scaffolding of the GPU wiring tests (gpu-wire-*.test.cjs): the REAL GPU model ids (so the profile table,
// the routing resolver and the providers recognise them) with FAKE table entries (8 dimensions, tiny files), the fake GPU child of
// gpu-worker-fake.cjs, and the owner-side seams (gpu-shared setTestOptions, heavy-tier setTestTable). No GPU, no runtime, no model.
// rig({ fake, probe }) -> { cache, table, clientOpts, install(), restore() }: install() points the shared GPU client and the probe
// at the fake child; restore() closes it and clears the seams.

const path = require('node:path');
const { core, sandbox, cleanup, FIXTURES } = require('../helpers.cjs');
const { writeCache } = require('./gpu-stub-runtime.cjs');

const SHA = 'a'.repeat(40), H = 'b'.repeat(64);
const FAKE = path.join(FIXTURES, 'gpu-worker-fake.cjs');
const MIB = 1048576;
const EMB4 = 'Qwen/Qwen3-Embedding-4B-GGUF', RR4 = 'giladgd/Qwen3-Reranker-4B-GGUF', RR06 = 'ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF';
const entry = (id, kind, extra) => ({ id, sha: SHA, runtime: 'gguf', kind, label: id, files: [{ path: 'm.gguf', bytes: 10, sha256: H }], pooling: kind === 'embedder' ? 'last' : null, query_prompt: kind === 'embedder' ? 'Q: ' : '', document_prompt: '', native_dims: kind === 'embedder' ? 8 : null, dims: kind === 'embedder' ? 8 : null, license: 'apache-2.0', context_size: 1024, vram_mb_ref: 500, ...extra });
const TABLE = { [EMB4]: entry(EMB4, 'embedder'), [RR4]: entry(RR4, 'reranker'), [RR06]: entry(RR06, 'reranker') };
const smi = () => ({ name: 'NVIDIA GeForce RTX 5060 Laptop GPU', driver: '617.42', total_mb: 8151, used_mb: 0, free_mb: 7899 });

function rig({ fake = {}, probe = {}, smi: smiFn } = {}) {
  const cache = sandbox();
  writeCache(cache, TABLE);
  const GS = core('gpu-shared.cjs'), HT = core('heavy-tier.cjs');
  const clientOpts = { workerPath: FAKE, workerOpts: { fake: { per_model: { [EMB4]: 700 * MIB, [RR4]: 800 * MIB, [RR06]: 300 * MIB }, ...fake } }, table: TABLE, cacheDir: cache };
  return {
    cache, table: TABLE, clientOpts,
    install() {
      GS.setTestOptions({ clientOpts, probeOpts: { table: TABLE, cacheDir: cache, runtimeDir: 'unused', record: false, smi: smiFn || smi, clientOpts: { ...clientOpts, workerOpts: { fake: { ...clientOpts.workerOpts.fake, ...probe } } } } });
      HT.setTestTable(TABLE);
    },
    async restore() { await GS.close(); await core('rerank-provider.cjs').closeAll(); await core('embed-provider.cjs').closeAll(); GS.setTestOptions(null); HT.setTestTable(undefined); cleanup(cache); },
  };
}

module.exports = { rig, TABLE, EMB4, RR4, RR06, FAKE, MIB };
