'use strict';
// methods-memory-promote-note.cjs — the operator's decision on a nominated note, and the read that checks promoted
// text is still where it was put. `memory.notePromote { note_id, decision: approve | reject, reason? }` is the OPERATOR's
// alone (no tool call reaches it). belay NEVER edits CLAUDE.md or any instruction file: approve records `promoted_to:
// { target, text, at }` on the note and moves the nomination to `promoted`; the operator puts the text in the file.
//
//   approve  the text and target come from the newest stored draft (the scrubber's draft row, or in propose mode its
//            draft proposal) made after the nomination. No draft, no approval. The note stays in its namespace with
//            `promoted_to` set; the index and search read that field to retire it (index ranking owns that filter).
//   reject   the nomination is closed `rejected` with the independent sightings counted at that moment. A later
//            nomination needs a sighting that is not among them.
//
// `memory.promotedCheck { root, project? }` (operator) reads each promoted note's target file under `root` and says
// whether its `promoted_to.text` is still there. Report only; nothing changes.

const fs = require('node:fs');
const path = require('node:path');
const { err } = require('./errors.cjs');
const C = require('./lifecycle-common.cjs');
const N = require('./methods-memory-notes.cjs');
const { loadNote, parse } = require('./memory-facts.cjs');
const { validId } = require('./memory-rows.cjs');
const NM = require('./memory-nominate.cjs');

const DECISIONS = ['approve', 'reject'];
const REASON_MAX = 500;
const FILE_MAX = 4 * 1024 * 1024;

const norm = s => String(s).replace(/\s+/g, ' ').trim();

// Is `text` in the file `target` under `root`? { state: present | absent | file_missing | target_unsafe | unreadable }.
// A target outside root (absolute, or climbing out with ..) is not read. Whitespace is collapsed on both sides, so
// a rule re-wrapped by the operator still counts. Reads only.
// Is `file` strictly inside `dir`? Lexical, on already resolved paths.
function inside(dir, file) {
  const rel = path.relative(dir, file);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function textPresent(root, target, text, cache) {
  if (typeof root !== 'string' || !root || typeof target !== 'string' || !target || path.isAbsolute(target)) return { state: 'target_unsafe' };
  const file = path.resolve(root, target);
  if (!inside(path.resolve(root), file)) return { state: 'target_unsafe' };
  let body;
  try {
    // A junction or symlink under root can lead anywhere: the real file must be inside the real root.
    if (!inside(fs.realpathSync(root), fs.realpathSync(file))) return { state: 'target_unsafe', file };
    const st = fs.statSync(file);
    if (!st.isFile()) return { state: 'file_missing', file };
    if (st.size > FILE_MAX) return { state: 'unreadable', file, reason: `over ${FILE_MAX} bytes` };
    if (cache && cache.has(file)) body = cache.get(file);
    else { body = norm(fs.readFileSync(file, 'utf8')); if (cache) cache.set(file, body); }
  } catch (e) {
    return e && e.code === 'ENOENT' ? { state: 'file_missing', file } : { state: 'unreadable', file, reason: e && e.code };
  }
  return { state: body.includes(norm(text)) ? 'present' : 'absent', file };
}

function checkArgs(args) {
  C.allowKeys(args, ['note_id', 'decision', 'reason'], 'memory.notePromote');
  if (!validId(args.note_id)) throw err('E_ARGS', 'memory.notePromote needs the note_id of a nominated note', { field: 'note_id' });
  if (!DECISIONS.includes(args.decision)) throw err('E_ARGS', `memory.notePromote decision must be one of ${DECISIONS.join(', ')}`, { field: 'decision' });
  if (args.reason !== undefined && args.reason !== null && (typeof args.reason !== 'string' || Buffer.byteLength(args.reason) > REASON_MAX)) throw err('E_ARGS', `memory.notePromote reason must be text of at most ${REASON_MAX} bytes`, { field: 'reason' });
  return args.reason ? C.clean(args.reason.trim()).text : null;
}

// memory.notePromote { note_id, decision, reason? } → { note_id, decision, receipt, promoted_to?, nomination, note }
async function promoteNote(E, caller, args) {
  if (caller.role !== 'operator' || caller.channel === 'harness') throw err('E_ROLE', 'memory.notePromote decides a promotion to an instruction file: only the operator, from the CLI, decides (not a tool call, and not the run process\'s harness channel)', { role: caller.role });
  const reason = checkArgs(args);
  const note = loadNote(E, args.note_id);
  if (!note || note.type !== 'note') throw err('E_NOT_FOUND', `no note ${args.note_id}`, { id: args.note_id });
  if (!note.namespace.startsWith('project/')) throw err('E_ARGS', `note ${note.id} is in ${note.namespace}: only a live note of a project is promoted`, { id: note.id });
  const project = note.namespace.slice('project/'.length);
  const last = NM.latestByNote(E, project, note.id).get(note.id);
  if (!last || last.body.state !== 'nominated') {
    throw err('E_ARGS', `note ${note.id} is not nominated (${last ? `its latest nomination is ${last.body.state}` : 'it was never nominated'}), so there is nothing to decide`, { id: note.id });
  }
  if (args.decision === 'approve') {
    const state = NM.notCandidate({ status: note.status }, note.b || {});
    if (state) throw err('E_ARGS', `note ${note.id} is ${state} now, so it is not promoted; reject the nomination instead`, { id: note.id, state });
  }
  const at = Date.now();
  const receipt = { kind: args.decision, at, by: 'operator', reason, nomination: last.id };
  // The independent sightings at the moment of rejection: a later nomination needs one that is not among them.
  let counted = null;
  if (args.decision === 'reject') {
    const row = E.store.p('SELECT id, task_id, run_id, written_by, created_at, body FROM memory_entries WHERE id = ?').get(note.id);
    counted = await NM.countFor(E, row);
  }
  const out = E.store.tx(() => {
    if (args.decision === 'approve') {
      const draft = NM.draftsFor(E, project, note.id, last.created_at)[0];
      if (!draft) throw err('E_ARGS', `note ${note.id} has no drafted rule yet: the scrubber drafts the text and target at a run's close, and an approval takes them from that draft`, { id: note.id });
      if (typeof draft.target !== 'string' || path.isAbsolute(draft.target) || !inside(path.resolve('/r'), path.resolve('/r', draft.target))) throw err('E_ARGS', `the drafted target ${JSON.stringify(String(draft.target).slice(0, 80))} is absolute or outside the project, so it is not promoted`, { id: note.id });
      const promoted = { target: draft.target, text: draft.rule, at };
      receipt.draft = { id: draft.id, source: draft.source };
      E.store.patchBody(note.id, b => { b.promoted_to = promoted; b.promotion = { ...receipt }; return N.fitBody(b); });
      E.store.patchBody(last.id, b => { b.state = 'promoted'; b.decision = { ...receipt, promoted_to: promoted }; return b; });
      return { promoted_to: promoted };
    }
    E.store.patchBody(last.id, b => { b.state = 'rejected'; b.rejected = { at, reason, keys: counted.keys }; b.decision = { ...receipt, keys: counted.keys.length }; return b; });
    return {};
  });
  E.noteWrite();
  return {
    note_id: note.id, decision: args.decision, project, receipt, ...(out.promoted_to ? { promoted_to: out.promoted_to } : {}),
    nomination: C.rowOut(E, last.id), note: C.rowOut(E, note.id),
  };
}

// memory.promotedCheck { root, project? } → { project, root, checked, removed: [...], promoted: [...] }
async function promotedCheck(E, caller, args) {
  if (caller.role !== 'operator') throw err('E_ROLE', 'memory.promotedCheck reads the operator\'s instruction files, and only the operator asks', { role: caller.role });
  C.allowKeys(args, ['root', 'project'], 'memory.promotedCheck');
  if (typeof args.root !== 'string' || !args.root) throw err('E_ARGS', 'memory.promotedCheck needs root: the directory the target files are relative to', { field: 'root' });
  if (args.project !== undefined && (typeof args.project !== 'string' || !args.project)) throw err('E_ARGS', 'project must be a project name', { field: 'project' });
  return checkPromoted(E, args.root, args.project || null);
}

function checkPromoted(E, root, project) {
  const where = project ? 'namespace = ?' : "namespace LIKE 'project/%'";
  const rows = E.store.p(`SELECT id, namespace, title, body FROM memory_entries WHERE type = 'note' AND ${where} AND json_extract(body, '$.promoted_to') IS NOT NULL ORDER BY created_at DESC, id LIMIT 500`).all(...(project ? [`project/${project}`] : []));
  const files = new Map();
  const promoted = rows.map(r => {
    const p = (parse(r.body) || {}).promoted_to || {};
    const res = textPresent(root, p.target, p.text || '', files);
    return { note_id: r.id, project: r.namespace.slice('project/'.length), title: r.title, target: p.target, text: p.text, promoted_at: p.at, ...res };
  });
  const removed = promoted.filter(p => p.state === 'absent' || p.state === 'file_missing');
  return { project, root, checked: promoted.length, removed, promoted };
}

module.exports = { promoteNote, promotedCheck, checkPromoted, textPresent };
