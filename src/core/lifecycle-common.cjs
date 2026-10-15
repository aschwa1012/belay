'use strict';
// lifecycle-common.cjs — what the lifecycle methods (scrubApply, reviewApply, noteRestore, the purge and the reads)
// share: the harness-channel check, the run's notes context, and the one way a lifecycle row is written.

const crypto = require('node:crypto');
const { err } = require('./errors.cjs');
const M = require('./methods-memory.cjs');
const N = require('./methods-memory-notes.cjs');
const { parse } = require('./memory-facts.cjs');

// A harness-only method: the channel is set by the process that built the caller (core.harness()), never by an
// argument, so a model's tool call cannot take it. The run manager and the run-end jobs hold it.
function needHarness(caller, method) {
  if (caller.channel !== 'harness') throw err('E_ROLE', `${method} is a harness call: it travels on the run manager's own channel, not a tool call`, { method, role: caller.role });
}

function allowKeys(args, keys, method) {
  for (const k of Object.keys(args)) if (!keys.includes(k)) throw err('E_ARGS', `${method}: ${k} is not an argument; use ${keys.join(', ')}`, { field: k });
}

// The notes lever block and project of the caller's run. `notes` off is E_LEVER_OFF; no project is E_ARGS.
function notesContext(E, caller, method) {
  const lv = N.notesLevers(E, caller);
  if (!lv) throw err('E_LEVER_OFF', `${method} needs the run's memory.notes lever, and this run has it off`, { lever: 'notes' });
  const project = M.projectOf(E, caller);
  if (!project) throw err('E_ARGS', `${method}: this run has no project, so there are no notes to act on`, { field: 'project' });
  return { lv, project, runId: caller.run_id };
}

// One lifecycle row (a held mark, a proposal, a draft), written by the harness and scrubbed like any project text.
// The text carries a nonce, so two rows are never one by hash and nothing here is a dedup update.
function putRow(E, caller, { ns, type, text, title, body, runId }) {
  const s = M.scrub(true, { text: `${text} [${crypto.randomUUID().slice(0, 8)}]`, title, body });
  return E.store.storeIn({
    namespace: ns, worker_id: E.writtenBy(caller), type, text: s.text, title: s.title, body: s.body, redactions: s.redactions,
    run_id: runId || caller.run_id, source: 'harness', written_by: E.memoryWriter(caller),
  });
}

// A row as the lifecycle returns it: where it is, what it is, and its body.
function rowOut(E, id) {
  const r = E.store.p('SELECT id, namespace, type, title, run_id, written_by, created_at, updated_at, body FROM memory_entries WHERE id = ?').get(id);
  return r ? { ...r, body: parse(r.body) } : null;
}

module.exports = { needHarness, allowKeys, notesContext, putRow, rowOut };
