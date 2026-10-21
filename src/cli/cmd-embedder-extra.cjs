'use strict';
// cmd-embedder-extra.cjs — `belay embedder delete <id>` (ADR 0050 amendment 3), the verb the panel's Memory menu needs beside fetch and
// verify (cmd-embedder.cjs). Mode W.
//
// delete: removes one model's directory from belay's model cache and nothing else. It REFUSES a model the current settings use (the run's
// profile, the CPU profile, any routed type or CPU pick, and nano, which embeds every note), a model the pinned routing of a LIVE run names (read
// from a copy of the store; a paused run counts), a store it cannot read, a config the runs would refuse, and a model that is not there; each
// refusal names who uses it and removes nothing. The folder is first RENAMED to a tombstone in the cache root: a rename moves it whole or fails
// (Windows refuses while a file in it is open, and then nothing was removed), so a delete never leaves half a model. The tombstone is then
// removed; if that fails the model is already gone, the answer says so, and the next delete or fetch sweeps it (K.sweepTombstones).
// Seams (tests): `seams.rename` and `seams.rm` stand in for the two file calls.

const fs = require('node:fs');
const path = require('node:path');
const C = require('./config.cjs');
const K = require('../core/model-cache.cjs');
const MM = require('../core/memory-menu.cjs');

const seams = { rename: (a, b) => fs.renameSync(a, b), rm: (p) => fs.rmSync(p, { recursive: true, force: true }) };

const USAGE = 'usage: belay embedder delete <model id> [--json]\n';
const fwd = (p) => String(p).replace(/\\/g, '/');
const fail = (code, message, json = {}) => ({ code, text: `belay embedder: ${message}\n`, json: { error: message, ...json } });

async function deleteModel(ctx, argv) {
  const ids = argv.filter((a) => !a.startsWith('-'));
  if (ids.length !== 1 || argv.length !== 1) return fail(2, `delete takes exactly one model id\n\n${USAGE}`);
  const d = MM.describeForDelete(ids[0]);
  if (!d) return fail(2, `unknown model ${JSON.stringify(ids[0])}; nothing was removed`);
  const found = C.discover(ctx.cwd);
  const { levers, error } = MM.leversOf(found);
  if (error) return fail(1, `the config's memory block is refused (${error}), so what uses this model cannot be told; fix it first. Nothing was removed`, { model: d.entry.id, removed: false });
  const live = await MM.liveRunUse(ctx.dataDir || C.dataDirOf(found, ctx));
  if (!live.ok) return fail(1, 'the store could not be read, so the live runs that may use this model cannot be told. Nothing was removed', { model: d.entry.id, removed: false });
  const by = MM.modelsInUse(levers, live.models)[d.entry.id];
  if (by) return fail(1, `${d.entry.id} is in use by the current settings or a live run (${by.join(', ')}); change them first. Nothing was removed`, { model: d.entry.id, in_use_by: by, removed: false });
  const root = K.cacheRoot();
  const dir = K.modelDir(d.entry, root);
  if (!fwd(path.resolve(dir)).startsWith(`${fwd(path.resolve(root))}/`)) return fail(1, `${dir} is outside the model cache ${root}; nothing was removed`);
  K.sweepTombstones(root);
  if (!fs.existsSync(dir)) return fail(1, `${d.entry.id} is not in the model cache (${dir}); nothing was removed`, { model: d.entry.id, removed: false });
  const bytes = d.entry.files.reduce((n, f) => n + f.bytes, 0);
  const tomb = path.join(root, `${K.TOMB}${path.basename(dir).split('/').join('__')}-${process.pid}-${Date.now()}`);
  try { seams.rename(dir, tomb); } catch (e) {
    return fail(1, `${d.entry.id} could not be moved out of the cache (${e.code || e.message}); a file in it may be open. Nothing was removed`, { model: d.entry.id, dir, removed: false });
  }
  let left = null;
  try { seams.rm(tomb); } catch (e) { left = e.code || e.message; }
  if (left === null && fs.existsSync(tomb)) left = 'still present';
  try { fs.rmdirSync(path.dirname(dir)); } catch { /* the parent holds other models, or is gone */ }
  const r = { model: d.entry.id, dir, bytes, removed: true, ...(left !== null ? { tombstone: tomb, tombstone_left: left } : {}) };
  const tail = left !== null ? `; its leftover files (${left}) at ${tomb} are removed by the next delete or fetch` : '';
  return { code: 0, text: `removed ${d.entry.id} from ${dir} (${bytes} bytes)${tail}\n`, json: r };
}

async function run(ctx) {
  return deleteModel(ctx, ctx.argv.slice(1));
}

module.exports = { run, USAGE, seams };
