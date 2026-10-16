'use strict';
// cmd-memory-reembed.cjs — `belay memory embed --reembed --template v2 [--project <p>] [--dry-run]`. A note embedded before the
// `when` field was made from its whole stored text (template v1). This rebuilds the vector of each such note from its title and
// its When: line (template v2), but only where those fields exist: a note without a `when` cannot be rebuilt, stays v1, and the
// receipt names it. Search works over a store that holds both, but mixing is suboptimal: a v1 vector and a v2 vector of the same
// kind of note sit in different parts of the space. The operator runs this; nothing starts it. The listing and the dry run are
// reads. A real run is mode W: it warms the embedder first and refuses, writing nothing, if it cannot load. Re-running finds
// nothing left to rebuild.

const P = require('./panel-common.cjs');

const WARM_MS = 600000;
const clean = (s, cap = 160) => P.clean(s == null ? '' : s, cap);

function renderText(r) {
  const lines = [];
  const head = r.dry_run ? 'dry run: ' : '';
  lines.push(`${head}project ${clean(r.project, 64)}, template ${r.template}: ${r.total} embedded note${r.total === 1 ? '' : 's'}; ${r.already} already ${r.template}, ${r.eligible} ${r.dry_run ? 'would be rebuilt' : 'to rebuild'}, ${r.stays.length} stay${r.stays.length === 1 ? 's' : ''} v1 (no when)`);
  for (const n of r.rebuilt) lines.push(`  rebuilt ${clean(n.id, 64)}  ${clean(n.title || '(no title)')}`);
  for (const n of r.skipped) lines.push(`  skipped ${clean(n.id, 64)}  ${clean(n.reason, 40)}  ${clean(n.title || '(no title)')}`);
  for (const f of r.failed) lines.push(`  FAILED ${clean(f.id, 64)}  ${clean(f.code, 40)}: ${clean(f.message, 300)}`);
  if (r.dry_run) for (const n of r.would) lines.push(`  would rebuild ${clean(n.id, 64)}  ${clean(n.title || '(no title)')}`);
  for (const n of r.stays) lines.push(`  stays v1 ${clean(n.id, 64)}  no when to build it from  ${clean(n.title || '(no title)')}`);
  if (!r.dry_run) lines.push(`rebuilt ${r.rebuilt.length}, failed ${r.failed.length}, skipped ${r.skipped.length}; elapsed: ${r.elapsed_ms} ms`);
  else lines.push('nothing was written');
  return `${lines.join('\n')}\n`;
}

async function doReembed(core, opts, project, t0, fail) {
  if (opts.template !== 'v2') return fail(2, 'E_ARGS', '--reembed needs --template v2 (the only template a stored note can be rebuilt as)');
  if (!project) return fail(2, 'E_ARGS', 'no project: pass --project <p>, or set memory.project in the config');
  const plan = await core.memory.retemplate({ project, template: 'v2' });
  const base = { project, template: 'v2', dry_run: !!opts.dryRun, total: plan.total, already: plan.already, eligible: plan.eligible.length, stays: plan.stays };
  if (opts.dryRun || !plan.eligible.length) {
    const r = { ...base, would: opts.dryRun ? plan.eligible : [], rebuilt: [], skipped: [], failed: [], elapsed_ms: Date.now() - t0 };
    return { code: 0, text: renderText(r), json: r };
  }
  try {
    await core.memory.warm({ wait: true, timeout_ms: WARM_MS });
  } catch (e) {
    const d = e && e.detail;
    const fix = require('../run/embedder-guard.cjs').fixFor(e.code, d && d.cause, d && (d.phase || d.op_phase));
    return fail(1, e.code || 'E_INTERNAL', `the embedder cannot load, so nothing was rebuilt or written: ${e.message}`, { fix, eligible: plan.eligible.length, written: 0 });
  }
  const rebuilt = [], skipped = [], failed = [];
  for (const n of plan.eligible) {
    try {
      const r = await core.memory.embedNote({ id: n.id, reembed: 'v2' });
      if (r.reembedded) rebuilt.push({ id: r.id, title: r.title, from: r.from, to: r.to });
      else skipped.push({ id: r.id, title: r.title, reason: r.reason });
    } catch (e) {
      failed.push({ id: n.id, code: (e && e.code) || 'E_INTERNAL', message: (e && e.message) || String(e) });
    }
  }
  const r = { ...base, would: [], rebuilt, skipped, failed, elapsed_ms: Date.now() - t0 };
  return { code: failed.length ? 1 : 0, text: renderText(r), json: r };
}

module.exports = { doReembed };
