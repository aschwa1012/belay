'use strict';
// cmd-embedder-extra.cjs — `belay embedder delete <id>` (ADR 0050 amendment 3), the verb the panel's Memory menu needs beside fetch and
// verify (cmd-embedder.cjs). Mode W.
//
// delete: removes one model's directory from belay's model cache and nothing else. It REFUSES a model the current settings use (the run's
// profile, the CPU profile, any routed type, and nano, which embeds every note), naming who uses it, and a model that is not there. The
// receipt names the directory and the bytes the table lists for it.

const fs = require('node:fs');
const path = require('node:path');
const C = require('./config.cjs');
const K = require('../core/model-cache.cjs');
const MM = require('../core/memory-menu.cjs');

const USAGE = 'usage: belay embedder delete <model id> [--json]\n';
const fwd = (p) => String(p).replace(/\\/g, '/');
const fail = (code, message, json = {}) => ({ code, text: `belay embedder: ${message}\n`, json: { error: message, ...json } });

function deleteModel(ctx, argv) {
  const ids = argv.filter((a) => !a.startsWith('-'));
  if (ids.length !== 1 || argv.length !== 1) return fail(2, `delete takes exactly one model id\n\n${USAGE}`);
  const d = MM.describeForDelete(ids[0]);
  if (!d) return fail(2, `unknown model ${JSON.stringify(ids[0])}; nothing was removed`);
  const { levers } = MM.leversOf(C.discover(ctx.cwd));
  const by = MM.modelsInUse(levers)[d.entry.id];
  if (by) return fail(1, `${d.entry.id} is in use by the current settings (${by.join(', ')}); change them first. Nothing was removed`, { model: d.entry.id, in_use_by: by, removed: false });
  const root = K.cacheRoot();
  const dir = K.modelDir(d.entry, root);
  if (!fwd(path.resolve(dir)).startsWith(`${fwd(path.resolve(root))}/`)) return fail(1, `${dir} is outside the model cache ${root}; nothing was removed`);
  if (!fs.existsSync(dir)) return fail(1, `${d.entry.id} is not in the model cache (${dir}); nothing was removed`, { model: d.entry.id, removed: false });
  const bytes = d.entry.files.reduce((n, f) => n + f.bytes, 0);
  fs.rmSync(dir, { recursive: true, force: true });
  const gone = !fs.existsSync(dir);
  const r = { model: d.entry.id, dir, bytes, removed: gone };
  if (!gone) return { code: 1, text: `belay embedder delete: ${dir} is still there after the removal\n`, json: { ...r, error: 'still present' } };
  try { fs.rmdirSync(path.dirname(dir)); } catch { /* the parent holds other models */ }
  return { code: 0, text: `removed ${d.entry.id} from ${dir} (${bytes} bytes)\n`, json: r };
}

async function run(ctx) {
  return deleteModel(ctx, ctx.argv.slice(1));
}

module.exports = { run, USAGE };
