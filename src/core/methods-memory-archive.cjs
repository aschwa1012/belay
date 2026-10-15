'use strict';
// methods-memory-archive.cjs — the archive's other methods:
//   memory.noteRestore       bring an archived note back to live, with a reason and a receipt (orchestrator, operator)
//   memory.archivePurge      operator only: write the full rows to archive-purged-<date>.jsonl, then remove them from
//                            the archive; returns the count, the path and the file's sha256. Archived notes only.
//                            Nothing purges automatically.
//   memory.proposals         read: the scrubber's proposals, the held queue and the stored drafts
//   memory.archivedDuplicates  read: the archived notes that duplicated a note, as restore candidates
// The two reads are SELECTs only, so they answer from a copy of the store and create no file.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { err } = require('./errors.cjs');
const L = require('./memory-lifecycle.cjs');
const C = require('./lifecycle-common.cjs');
const M = require('./methods-memory.cjs');
const N = require('./methods-memory-notes.cjs');
const { loadNote, parse } = require('./memory-facts.cjs');
const { validId } = require('./memory-rows.cjs');

const RESTORED_KEEP = 20;
const PURGE_IDS_MAX = 500;
const LIST_MAX = 200;
const esc = s => s.replace(/[\\%_]/g, c => `\\${c}`);

// ---- memory.noteRestore ---------------------------------------------------------------------------------------

async function noteRestore(E, caller, args) {
  C.allowKeys(args, ['id', 'reason'], 'memory.noteRestore');
  if (!validId(args.id)) throw err('E_ARGS', 'memory.noteRestore needs the id of an archived note', { field: 'id' });
  const reason = L.checkText(args.reason, 'reason', 500, 'memory.noteRestore: ');
  if (caller.role !== 'operator' && !N.notesLevers(E, caller)) throw err('E_LEVER_OFF', 'memory.noteRestore needs the run\'s memory.notes lever, and this run has it off', { lever: 'notes' });
  const out = E.store.tx(() => {
    const row = loadNote(E, args.id);
    if (!row || row.type !== 'note' || !row.namespace.startsWith('archive/')) throw err('E_NOT_FOUND', `no archived note ${args.id}${row ? ` (it is in ${row.namespace})` : ''}`, { id: args.id });
    const project = row.namespace.slice('archive/'.length);
    if (caller.role === 'orchestrator' && M.projectOf(E, caller) !== project) throw err('E_ROLE', `note ${row.id} is archived in project ${project}, not this run's`, { id: row.id, role: caller.role });
    N.release(E, row, project); // the same move as a resolved pending note: a clash with a live row of the same text is E_EXISTS
    const was = row.b.archived || null;
    const entry = { at: Date.now(), by: E.memoryWriter(caller), role: caller.role, run_id: caller.run_id, reason, was_archived: was };
    E.store.patchBody(row.id, b => { b.state = 'live'; b.restored = [...(b.restored || []), entry].slice(-RESTORED_KEEP); delete b.archived; return N.fitBody(b); });
    return { id: row.id, restored: true, namespace: N.projectNs(project), receipt: { kind: 'restore', ...entry }, history_stays_with: was && was.history_moved ? was.history_moved.to : null, row: C.rowOut(E, row.id) };
  });
  E.noteWrite();
  return out;
}

// ---- memory.archivePurge --------------------------------------------------------------------------------------

function purgeFile(dir) {
  const stamp = new Date().toISOString().slice(0, 10);
  for (let n = 1; n < 1000; n += 1) {
    const file = path.join(dir, `archive-purged-${stamp}${n === 1 ? '' : `-${n}`}.jsonl`).split('\\').join('/');
    try { return { file, fd: fs.openSync(file, 'wx') }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw err('E_INTERNAL', 'could not find an unused archive-purged file name');
}

function selectPurge(E, args) {
  const ns = args.project ? `archive/${args.project}` : null;
  const archived = ns ? E.store.p("SELECT * FROM memory_entries WHERE type = 'note' AND namespace = ?").all(ns)
    : E.store.p("SELECT * FROM memory_entries WHERE type = 'note' AND namespace LIKE 'archive/%'").all();
  if (args.ids) {
    const by = new Map(archived.map(r => [r.id, r]));
    const skipped = args.ids.filter(id => !by.has(id)).map(id => ({ id, reason: 'not an archived note' }));
    return { rows: args.ids.map(id => by.get(id)).filter(Boolean), skipped };
  }
  const cutoff = Date.now() - args.older_than_days * 86400000;
  return { rows: archived.filter(r => { const a = parse(r.body).archived; return a && typeof a.at === 'number' && a.at < cutoff; }), skipped: [] };
}

async function archivePurge(E, caller, args) {
  C.allowKeys(args, ['ids', 'older_than_days', 'project', 'confirm'], 'memory.archivePurge');
  if (caller.role !== 'operator') throw err('E_ROLE', 'memory.archivePurge is the operator\'s alone', { role: caller.role });
  if (args.confirm !== true) throw err('E_ARGS', 'memory.archivePurge removes rows for good: pass confirm true', { field: 'confirm' });
  if ((args.ids === undefined) === (args.older_than_days === undefined)) throw err('E_ARGS', 'memory.archivePurge takes ids or older_than_days, one of them', { field: 'ids' });
  if (args.ids !== undefined && (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > PURGE_IDS_MAX || args.ids.some(x => !validId(x)))) throw err('E_ARGS', `ids must be an array of 1 to ${PURGE_IDS_MAX} note ids`, { field: 'ids' });
  if (args.older_than_days !== undefined && !(Number.isFinite(args.older_than_days) && args.older_than_days >= 0)) throw err('E_ARGS', 'older_than_days must be a number of days, 0 or more', { field: 'older_than_days' });
  if (args.project !== undefined && (typeof args.project !== 'string' || !args.project)) throw err('E_ARGS', 'project must be a project name', { field: 'project' });
  const out = E.store.tx(() => {
    const { rows, skipped } = selectPurge(E, args);
    if (!rows.length) return { count: 0, path: null, sha256: null, ids: [], skipped };
    // The rows go to the file first and the file is read back; only then are they removed, in this transaction, so a
    // failed write leaves every row where it was.
    const { file, fd } = purgeFile(E.dataDir);
    try {
      const text = rows.map(r => { const { embedding, ...rest } = r; return JSON.stringify({ ...rest, embedding_b64: embedding ? Buffer.from(embedding).toString('base64') : null }); }).join('\n') + '\n';
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (fs.readFileSync(file, 'utf8').trim().split('\n').length !== rows.length) throw err('E_INTERNAL', `the purge file ${file} does not hold the ${rows.length} rows; nothing was removed`);
    for (const r of rows) E.store.p('DELETE FROM memory_entries WHERE id = ?').run(r.id);
    for (const ns of new Set(rows.map(r => r.namespace))) E.store.cache.delete(ns);
    return { count: rows.length, path: file, sha256, ids: rows.map(r => r.id), skipped };
  });
  E.noteWrite();
  return out;
}

// ---- reads ----------------------------------------------------------------------------------------------------

function projectScope(E, caller, args) {
  if (args.project !== undefined && (typeof args.project !== 'string' || !args.project)) throw err('E_ARGS', 'project must be a project name', { field: 'project' });
  if (caller.role === 'orchestrator') {
    const mine = M.projectOf(E, caller);
    if (args.project && args.project !== mine) throw err('E_ROLE', `this run's project is ${mine || 'none'}, not ${args.project}`, { role: caller.role });
    return mine;
  }
  return args.project || null;
}

const lite = r => ({ id: r.id, namespace: r.namespace, type: r.type, title: r.title, run_id: r.run_id, created_at: r.created_at, body: parse(r.body) });

function listNs(E, kind, project, where, params) {
  const nsClause = project ? 'namespace = ?' : "namespace LIKE ? ESCAPE '\\'";
  const nsParam = project ? `${kind}/${project}` : `${kind}/%`;
  return E.store.p(`SELECT id, namespace, type, title, run_id, created_at, body FROM memory_entries WHERE ${nsClause}${where ? ` AND ${where}` : ''} ORDER BY created_at DESC, id LIMIT ${LIST_MAX}`).all(nsParam, ...(params || [])).map(lite);
}

async function proposals(E, caller, args) {
  C.allowKeys(args, ['project', 'all'], 'memory.proposals');
  const project = projectScope(E, caller, args);
  const heldWhere = args.all === true ? null : "json_extract(body, '$.state') = 'held'";
  const proposalRows = listNs(E, 'proposal', project), held = listNs(E, 'held', project, heldWhere), drafts = listNs(E, 'draft', project);
  return { project, proposals: proposalRows, held, drafts, counts: { proposals: proposalRows.length, held: held.length, drafts: drafts.length }, limit: LIST_MAX };
}

async function archivedDuplicates(E, caller, args) {
  C.allowKeys(args, ['id'], 'memory.archivedDuplicates');
  if (!validId(args.id)) throw err('E_ARGS', 'memory.archivedDuplicates needs the id of a note', { field: 'id' });
  const kept = E.store.p('SELECT id, namespace, status, type FROM memory_entries WHERE id = ?').get(args.id);
  if (!kept || kept.type !== 'note') throw err('E_NOT_FOUND', `no note ${args.id}`, { id: args.id });
  const project = kept.namespace.includes('/') ? kept.namespace.slice(kept.namespace.indexOf('/') + 1) : null;
  const scoped = projectScope(E, caller, { project });
  if (caller.role === 'orchestrator' && scoped !== project) throw err('E_ROLE', `note ${kept.id} is in another project`, { role: caller.role });
  const rows = E.store.p(`SELECT id, namespace, title, body FROM memory_entries WHERE type = 'note' AND namespace = ?
    AND json_extract(body, '$.archived.kind') = 'duplicate' AND json_extract(body, '$.archived.of') = ? ORDER BY created_at DESC LIMIT ${LIST_MAX}`).all(`archive/${project}`, args.id);
  const live = kept.namespace === `project/${project}` && (kept.status || 'unverified') !== 'refuted';
  return {
    id: args.id, namespace: kept.namespace, kept_live: live,
    candidates: rows.map(r => { const a = parse(r.body).archived || {}; return { id: r.id, title: r.title, archived_at: a.at, reason: a.reason, review: a.review, history_moved: a.history_moved || null }; }),
    note: live ? 'the kept note is live: these stay archived unless restored' : 'the kept note is no longer live: each candidate can be restored with memory.noteRestore',
  };
}

module.exports = { noteRestore, archivePurge, proposals, archivedDuplicates };
