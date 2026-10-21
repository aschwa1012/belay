'use strict';
// cmd-memory-embed-heavy.cjs — `belay memory embed --model <gguf embedder id> --project <p>`: drain a heavy embedder's backlog (ADR 0050
// decision 4). The backlog is derived from the rows (the visible notes of project/<p> with no vector under the model), so a re-run finds
// nothing left. Mode W: an owner write (memory.drainHeavy, bounded passes), with progress on stderr between passes. The CPU never runs a
// heavy embedder, so a machine with no GPU runtime fails here by name and writes nothing.

const P = require('./panel-common.cjs');

const clean = (s, cap = 160) => P.clean(s == null ? '' : s, cap);
const PASSES = 10000; // a backstop: a pass that writes nothing stops the loop

async function doHeavy(core, opts, project, t0, fail, write = (m) => process.stderr.write(m)) {
  const RP = require('../core/retrieval-profiles.cjs'); // a pure table
  const d = RP.describeModel(opts.model);
  if (!d || d.kind !== 'embedder' || d.runtime !== 'gguf') return fail(2, 'E_ARGS', `--model must name a heavy (GPU) embedder (${Object.keys(RP.GGUF_KINDS).filter((id) => RP.GGUF_KINDS[id] === 'embedder').join(', ')}); nano embeds every note on write and has no backlog`);
  if (opts.reembed || opts.template !== undefined) return fail(2, 'E_ARGS', '--model drains a heavy embedder and does not go with --reembed or --template');
  if (opts.dryRun) return fail(2, 'E_ARGS', '--dry-run is not offered with --model: a drain is the only way to see the heavy backlog, and it writes only vectors');
  if (!project) return fail(2, 'E_ARGS', 'no project: pass --project <p>, or set memory.project in the config');
  const namespaces = [`project/${project}`];
  let total = null, written = 0, last = null;
  for (let pass = 0; pass < PASSES; pass += 1) {
    try { last = await core.memory.drainHeavy({ model: opts.model, namespaces }); } catch (e) {
      const dd = e && e.detail;
      return fail(1, (e && e.code) || 'E_INTERNAL', `the ${opts.model} embedder failed, so the drain stopped (${written + (dd && dd.written ? dd.written : 0)} written, the rest stay in the backlog): ${(e && e.message) || e}`, { written: written + (dd && dd.written ? dd.written : 0) });
    }
    if (total === null) total = last.total;
    written += last.written;
    write(`belay: ${opts.model}: ${written} of ${total} embedded, ${last.remaining} left\n`);
    if (last.done || last.written === 0) break;
  }
  const r = { project, model: opts.model, dims: last.dims, total, embedded: written, remaining: last.remaining, done: last.done, elapsed_ms: Date.now() - t0 };
  const text = !total ? `no notes of project ${clean(project, 64)} are behind ${clean(opts.model, 80)}; nothing to embed\n`
    : `project ${clean(project, 64)}: embedded ${written} of ${total} note${total === 1 ? '' : 's'} with ${clean(opts.model, 80)} (${last.dims} dims); ${last.remaining} left${last.done ? '' : ' (the pass wrote nothing, so the drain stopped)'}; elapsed ${r.elapsed_ms} ms\n`;
  return { code: last.done ? 0 : 1, text, json: r };
}

module.exports = { doHeavy };
