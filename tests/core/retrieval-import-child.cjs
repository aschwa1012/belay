'use strict';
// Child of retrieval-levers.test.cjs: loads the lever spec, parses a default block and reports which GPU and CPU-rerank child modules loaded.
const path = require('node:path');
const src = path.resolve(__dirname, '..', '..', 'src', 'core');
const ML = require(path.join(src, 'memory-levers.cjs'));
const r = ML.parseMemoryBlock(undefined);
const RR = require(path.join(src, 'retrieval-routing.cjs'));
RR.resolveRouting({ levers: r.value, agentTypes: ['coder'], gpu: false });
const loaded = Object.keys(require.cache).filter((k) => path.basename(k) === 'gguf-models.cjs' || /^gpu[^.]*\.cjs$/i.test(path.basename(k)) || /^rerank-(cpu|worker)\.cjs$/.test(path.basename(k)));
process.stdout.write(JSON.stringify({ ok: !r.error, loaded }));
