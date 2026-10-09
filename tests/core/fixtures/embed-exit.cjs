'use strict';
// embed-exit.cjs — loads the embedder, embeds once, and does NOT call close(). The process must end on
// its own: the embedder thread is unref'd when no request is in flight (review 1, L1). Prints one JSON line.
const { Embedder } = require('../../../src/core/embedder.cjs');
(async () => {
  const e = new Embedder();
  const info = await e.load(null);
  const v = await e.embed('exit check');
  console.log(JSON.stringify({ dim: info.dim, len: v.embedding.length }));
})().catch((x) => { console.log(JSON.stringify({ error: x.code || x.message })); process.exitCode = 1; });
