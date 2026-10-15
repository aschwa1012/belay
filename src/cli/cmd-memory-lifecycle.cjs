'use strict';
// cmd-memory-lifecycle.cjs — `belay memory proposals|restore|archive purge` (the notes lifecycle). Called by
// cmd-memory.cjs with the open core. `proposals` and `restore --candidates` are mode R: they read the store (or its
// copy) and start no process. `restore` and `archive purge` write, so they elect an owner on demand and cmd-memory.cjs
// shuts it down again. The purge is the operator's alone: this CLI process is the operator, and no tool reaches it.

const P = require('./panel-common.cjs');

const one = s => P.clean(s == null ? '' : s, 2000).replace(/\s+/g, ' ');
const when = ms => (typeof ms === 'number' ? new Date(ms).toISOString() : '-');

function rowLine(r) {
  const b = r.body || {};
  const what = r.type === 'proposal' ? `${b.entry ? `${b.entry.action}${b.entry.kind ? ` ${b.entry.kind}` : ''}${b.entry.resolve ? ` ${b.entry.resolve}` : ''}` : '?'} ${b.note_id}${b.entry && b.entry.of ? ` of ${b.entry.of}` : ''}`
    : r.type === 'held' ? `${b.kind} ${b.note_id}${b.of ? ` against ${b.of}` : ''}  [${b.state}]`
      : `rule for ${b.note_id} -> ${b.target}`;
  const why = b.reason ? `  ${one(b.reason).slice(0, 100)}` : '';
  return `  ${r.id}  run ${r.run_id || '-'}  ${when(r.created_at)}  ${what}${why}`;
}

function renderProposals(res) {
  const out = [`project: ${res.project || 'all'}`, `held: ${res.counts.held}  proposals: ${res.counts.proposals}  drafts: ${res.counts.drafts}`];
  for (const [title, list] of [['held (waiting on the reviewer)', res.held], ['proposals (nothing applied)', res.proposals], ['drafts', res.drafts]]) {
    out.push('', `${title}:`);
    if (!list.length) out.push('  none'); else for (const r of list) out.push(rowLine(r));
  }
  return `${out.join('\n')}\n`;
}

async function proposals(core, parsed) {
  const args = {};
  if (parsed.opts.project) args.project = parsed.opts.project;
  if (parsed.opts.all) args.all = true;
  const res = await core.memory.proposals(args);
  return { code: 0, text: renderProposals(res), json: res };
}

async function restore(core, parsed) {
  const id = parsed.positional[0];
  if (parsed.opts.candidates) {
    const res = await core.memory.archivedDuplicates({ id });
    const lines = [`note ${id} (${res.namespace}) is ${res.kept_live ? 'live' : 'not live'}; ${res.note}`];
    if (!res.candidates.length) lines.push('no archived duplicates'); else for (const c of res.candidates) lines.push(`  ${c.id}  archived ${when(c.archived_at)}  ${one(c.title).slice(0, 80)}`);
    return { code: 0, text: `${lines.join('\n')}\n`, json: res };
  }
  const res = await core.memory.noteRestore({ id, reason: parsed.opts.reason });
  const stays = res.history_returned ? `\nits sightings came back from ${res.history_returned.from}` : '';
  return { code: 0, text: `restored ${res.id} to ${res.namespace}  reason: ${one(res.receipt.reason)}  at ${when(res.receipt.at)}${stays}\n`, json: res };
}

async function archive(core, parsed) {
  if (parsed.positional[0] !== 'purge') return { code: 2, text: `belay memory archive: unknown action ${one(parsed.positional[0])}; expected purge\n`, json: { error: 'unknown action' } };
  const o = parsed.opts;
  const args = { confirm: true, ...(o.idList ? { ids: o.idList } : { older_than_days: o.days }), ...(o.project ? { project: o.project } : {}) };
  const res = await core.memory.archivePurge(args);
  const skipped = res.skipped && res.skipped.length ? `\nskipped: ${res.skipped.map(s => `${s.id} (${s.reason})`).join(', ')}` : '';
  const text = res.count ? `purged ${res.count} archived note${res.count === 1 ? '' : 's'}  file: ${res.path}  sha256: ${res.sha256}${skipped}\n` : `nothing purged; no file written${skipped}\n`;
  return { code: 0, text, json: res };
}

const WRITES = { restore: p => !p.opts.candidates, archive: () => true, scrub: () => true, review: () => true, resolve: () => true };
const writes = parsed => !!(WRITES[parsed.sub] && WRITES[parsed.sub](parsed));

module.exports = { VERB_FN: { proposals, restore, archive, ...require('./cmd-memory-stages.cjs').VERB_FN }, writes };
