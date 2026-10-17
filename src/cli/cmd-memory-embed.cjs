'use strict';
// cmd-memory-embed.cjs — `belay memory embed [--project <p>] [--dry-run]`. Notes handed back under
// on_embedder_failure keyword are stored without a vector and are never embedded automatically; this is the
// intentional run that does it. The listing and the dry run are reads (no owner is elected, nothing is written);
// a real run is mode W: it warms the embedder first and refuses, writing nothing, if it cannot load, then embeds each note
// through memory.embedNote, which also runs the near-duplicate check the note skipped (it records the matches in the note and an event, as a
// hand-back does, and moves, merges or deletes nothing). The receipt names what was embedded, what failed and why, the matches
// recorded, and the elapsed time. Re-running finds nothing left and embeds nothing.

const P = require('./panel-common.cjs');

const WARM_MS = 600000; // memory.warm's longest wait: nothing else is waiting on the model here

const clean = (s, cap = 160) => P.clean(s == null ? '' : s, cap);

// The note-match levers: the config's memory block when it sets them, else the defaults. The block is validated whole by
// parseMemoryBlock (as a run validates it), so a malformed config or value is refused, never replaced by a default.
function leversOf(found) {
  if (found && found.parse_error) return { error: found.parse_error };
  const block = found && found.config ? found.config.memory : undefined;
  if (block === undefined) return { args: {}, source: 'default' };
  const parsed = require('../core/memory-levers.cjs').parseMemoryBlock(block);
  if (parsed.error) return { error: `${found.path}: ${parsed.error}` };
  const args = {};
  for (const k of ['notes_match_threshold', 'notes_match_n']) if (block[k] !== undefined) args[k] = parsed.value[k];
  return { args, source: Object.keys(args).length ? found.path : 'default' };
}

function fail(code, error, message, extra = {}) {
  return { code, text: `belay memory embed: ${clean(message, 600)}\n`, json: { error: { code: error, message, ...extra } } };
}

function renderText(r) {
  const lines = [];
  if (r.dry_run) {
    lines.push(`dry run: ${r.found} note${r.found === 1 ? '' : 's'} of project ${clean(r.project, 64)} would be embedded; nothing was written`);
    for (const n of r.notes) lines.push(`  ${clean(n.id, 64)}  ${clean(n.title || '(no title)')}`);
    return `${lines.join('\n')}\n`;
  }
  if (!r.found) return `no unembedded notes in project ${clean(r.project, 64)}; nothing to embed\n`;
  lines.push(`project ${clean(r.project, 64)}: ${r.found} unembedded note${r.found === 1 ? '' : 's'}; embedded ${r.embedded.length}, failed ${r.failed.length}, already embedded ${r.already_embedded.length}`);
  for (const n of r.embedded) {
    lines.push(`  embedded ${clean(n.id, 64)}  ${clean(n.title || '(no title)')}${n.matches.length ? `  ${n.matches.length} match${n.matches.length === 1 ? '' : 'es'} recorded` : ''}`);
    for (const m of n.matches) lines.push(`      close to ${clean(m.id, 64)} (${m.similarity})  ${clean(m.title || '')}`);
  }
  for (const f of r.failed) lines.push(`  FAILED ${clean(f.id, 64)}  ${clean(f.code, 40)}: ${clean(f.message, 300)}`);
  lines.push(`matches recorded: ${r.matches_recorded} on ${r.with_matches.length} note${r.with_matches.length === 1 ? '' : 's'} (threshold ${r.levers.notes_match_threshold}, up to ${r.levers.notes_match_n}, from ${clean(r.levers.source, 120)})${r.with_matches.length ? '; recorded for review in body.matches and a note_matches event; every note stays where it was and nothing was merged, archived or deleted' : ''}`);
  lines.push(`elapsed: ${r.elapsed_ms} ms`);
  return `${lines.join('\n')}\n`;
}

async function doEmbed(core, parsed, ctx, found) {
  const { opts } = parsed;
  const t0 = Date.now();
  const project = opts.project || (found && found.config && found.config.memory && found.config.memory.project) || null;
  if (opts.template !== undefined && !opts.reembed) return fail(2, 'E_ARGS', '--template goes with --reembed: belay memory embed --reembed --template v2');
  if (opts.reembed) return require('./cmd-memory-reembed.cjs').doReembed(core, opts, project, t0, fail);
  const lv = leversOf(found);
  if (lv.error) return fail(2, 'E_ARGS', `the config's memory levers are invalid, so nothing was embedded: ${lv.error}`);
  if (!project) {
    const u = await core.memory.unembedded({});
    const where = u.total ? `; notes without a vector are in: ${Object.entries(u.by_project).map(([p, n]) => `${clean(p, 64)} ${n}`).join(', ')}` : '';
    return fail(2, 'E_ARGS', `no project: pass --project <p>, or set memory.project in the config${where}`);
  }
  const listed = await core.memory.unembedded({ project, list: true });
  const base = { project, dry_run: !!opts.dryRun, found: listed.total };
  if (opts.dryRun || !listed.total) {
    const r = { ...base, notes: listed.notes.map(n => ({ id: n.id, title: n.title })), embedded: [], failed: [], already_embedded: [], matches_recorded: 0, with_matches: [], elapsed_ms: Date.now() - t0 };
    return { code: 0, text: renderText({ ...r, levers: {} }), json: r };
  }

  // The embedder first: a model that cannot load refuses the whole run and writes nothing.
  try {
    await core.memory.warm({ wait: true, timeout_ms: WARM_MS });
  } catch (e) {
    const d = e && e.detail;
    const fix = require('../run/embedder-guard.cjs').fixFor(e.code, d && d.cause, d && (d.phase || d.op_phase));
    return fail(1, e.code || 'E_INTERNAL', `the embedder cannot load, so nothing was embedded or written: ${e.message}`, { fix, found: listed.total, written: 0 });
  }

  const embedRun = `embed-${Date.now().toString(36)}-${require('node:crypto').randomBytes(3).toString('hex')}`;
  const embedded = [], failed = [], already = [];
  for (const n of listed.notes) {
    try {
      const r = await core.memory.embedNote({ id: n.id, embed_run: embedRun, ...lv.args });
      if (!r.embedded) already.push(n.id);
      else embedded.push({ id: r.id, title: r.title, state: r.state, namespace: r.namespace, compared: r.compared, matches: r.matches, embedding_model: r.embedding_model, dim: r.dim, notes_match_threshold: r.notes_match_threshold, notes_match_n: r.notes_match_n });
    } catch (e) {
      failed.push({ id: n.id, code: (e && e.code) || 'E_INTERNAL', message: (e && e.message) || String(e) });
    }
  }
  const withMatches = embedded.filter(n => n.matches.length).map(n => n.id);
  const D = require('../core/memory-levers.cjs').DEFAULTS;
  const r = {
    ...base, embedded, failed, already_embedded: already, with_matches: withMatches, embed_run: embedRun, matches_recorded: embedded.reduce((s, n) => s + n.matches.length, 0),
    levers: { notes_match_threshold: lv.args.notes_match_threshold ?? D.notes_match_threshold, notes_match_n: lv.args.notes_match_n ?? D.notes_match_n, source: lv.source },
    elapsed_ms: Date.now() - t0,
  };
  return { code: failed.length ? 1 : 0, text: renderText(r), json: r };
}

module.exports = { doEmbed };
