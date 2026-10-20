'use strict';
// cmd-memory-lifecycle.cjs — `belay memory proposals|restore|archive purge` (the notes lifecycle). Called by
// cmd-memory.cjs with the open core. `proposals` and `restore --candidates` are mode R: they read the store (or its
// copy) and start no process. `restore` and `archive purge` write, so they elect an owner on demand and cmd-memory.cjs
// shuts it down again. The purge is the operator's alone: this CLI process is the operator, and no tool reaches it.

const path = require('node:path');
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
  const out = [`project: ${res.project || 'all'}`, `held: ${res.counts.held}  proposals: ${res.counts.proposals}  drafts: ${res.counts.drafts}  nominations: ${res.counts.nominations || 0}`];
  for (const [title, list] of [['held (waiting on the reviewer)', res.held], ['proposals (nothing applied)', res.proposals], ['drafts', res.drafts]]) {
    out.push('', `${title}:`);
    if (!list.length) out.push('  none'); else for (const r of list) out.push(rowLine(r));
  }
  if ((res.unjudged_reports || []).length) {
    out.push('', `reports of "wrong" no review judged (${res.unjudged_reports.length}; the reporter's task ended with no reviewer):`);
    for (const r of res.unjudged_reports.slice(0, 20)) out.push(`  ${r.id}  task ${r.task_id || '-'}  by ${one(r.by || '-')}  ${when(r.at)}  ${one(r.why || '').slice(0, 100)}`);
  }
  out.push('', 'nominated for an instruction file (the operator decides: belay memory promote <note-id> --approve|--reject):');
  const noms = res.nominations || [];
  if (!noms.length) out.push('  none');
  for (const n of noms) {
    const b = n.body || {}, c = b.counts || {};
    out.push(`  ${b.note_id}  [${b.state}]  ${c.tasks} tasks across ${c.runs} runs  nominated ${when(n.created_at)}  (${n.project})${n.note_state && n.note_state !== 'live' ? `  NOTE IS ${String(n.note_state).toUpperCase()}: reject it` : ''}${c.unrecorded ? `  [${c.unrecorded} sighting${c.unrecorded === 1 ? '' : 's'} not counted: delivery facts not recorded]` : ''}`);
    if (!n.drafts.length) out.push('    no draft yet: the scrubber drafts it at a run close');
    for (const d of n.drafts.slice(0, 1)) out.push(`    draft (${d.source}) -> ${d.target}, ${Buffer.byteLength(String(d.rule))} bytes, the whole rule (it reaches every later worker): ${one(d.rule)}${d.present ? `  [${d.present === 'present' ? 'already in the file' : 'not in the file'}]` : ''}`);
  }
  const pc = res.promoted_check;
  if (pc) {
    out.push('', `promoted notes whose text was removed from its file: ${pc.removed.length} of ${pc.checked}`);
    for (const r of pc.removed) out.push(`  ${r.note_id}  ${r.target}  (${r.state === 'file_missing' ? 'the file is gone' : 'text not found'})  ${one(r.text).slice(0, 100)}`);
  }
  return `${out.join('\n')}\n`;
}

// The directory a target file is relative to: the project root the config was found in, else the working directory.
const rootOf = (ctx, found) => path.resolve((found && found.found && found.dir) || (ctx && ctx.cwd) || process.cwd());

async function proposals(core, parsed, ctx, found) {
  const args = { root: rootOf(ctx, found) };
  if (parsed.opts.project) args.project = parsed.opts.project;
  if (parsed.opts.all) args.all = true;
  const res = await core.memory.proposals(args);
  // Reports of "wrong" that no review will judge (the reporter's task ended with no reviewer and no review job): listed for the operator.
  try { if (core.memory && typeof core.memory.held === 'function') res.unjudged_reports = (await core.memory.held({ ...(args.project ? { project: args.project } : {}), reports: true })).unjudged_reports || []; } catch { /* the list is extra; the proposals stand */ }
  return { code: 0, text: renderProposals(res), json: res };
}

async function promote(core, parsed, ctx, found) {
  const id = parsed.positional[0];
  const decision = parsed.opts.approve ? 'approve' : 'reject';
  const res = await core.memory.notePromote({ note_id: id, decision, ...(parsed.opts.reason ? { reason: parsed.opts.reason } : {}) });
  const lines = [`${decision === 'approve' ? 'approved' : 'rejected'} ${res.note_id}  nomination ${res.nomination.id}  at ${when(res.receipt.at)}${res.receipt.reason ? `  reason: ${one(res.receipt.reason)}` : ''}`];
  let check = null;
  if (decision === 'approve') {
    const p = res.promoted_to;
    check = await core.memory.promotedCheck({ root: rootOf(ctx, found), project: res.project });
    const mine = check.promoted.find(x => x.note_id === res.note_id);
    const state = mine ? mine.state : 'unknown';
    lines.push(`promoted to: ${p.target}`, `rule: ${one(p.text)}`,
      state === 'present' ? `the text is already in ${p.target}` : `the text is NOT yet in ${p.target} (${state}): belay does not edit instruction files; add it yourself`);
  } else lines.push('a new nomination needs a new independent sighting');
  return { code: 0, text: `${lines.join('\n')}\n`, json: { ...res, ...(check ? { text_check: check.promoted.find(x => x.note_id === res.note_id) || null } : {}) } };
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

const WRITES = { restore: p => !p.opts.candidates, archive: () => true, promote: () => true, scrub: () => true, review: () => true, resolve: () => true };
const writes = parsed => !!(WRITES[parsed.sub] && WRITES[parsed.sub](parsed));

module.exports = { VERB_FN: { proposals, restore, archive, promote, ...require('./cmd-memory-stages.cjs').VERB_FN }, writes };
