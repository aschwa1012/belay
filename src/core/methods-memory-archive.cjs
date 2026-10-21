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
const { recordEventSync } = require('./methods-ledger.cjs');

const RESTORED_KEEP = 20;
const PURGE_IDS_MAX = 500;
const LIST_MAX = 200;
const esc = s => s.replace(/[\\%_]/g, c => `\\${c}`);

// ---- memory.noteRestore ---------------------------------------------------------------------------------------

async function noteRestore(E, caller, args) {
  C.allowKeys(args, ['id', 'reason', 'settle_reports'], 'memory.noteRestore');
  if (args.settle_reports !== undefined && typeof args.settle_reports !== 'boolean') throw err('E_ARGS', 'memory.noteRestore settle_reports must be true or false', { field: 'settle_reports' });
  // Only the operator's own command may restore a note with its reports settled instead of held again.
  if (args.settle_reports === true && !require('./held-guard.cjs').explicitOperator(caller)) throw err('E_ROLE', 'memory.noteRestore settle_reports is the operator\'s own command: a restore by anyone else holds the note again for its unsettled reports', { role: caller.role });
  if (!validId(args.id)) throw err('E_ARGS', 'memory.noteRestore needs the id of an archived note', { field: 'id' });
  const reason = C.clean(L.checkText(args.reason, 'reason', 500, 'memory.noteRestore: ')).text;
  if (caller.role !== 'operator' && !N.notesLevers(E, caller)) throw err('E_LEVER_OFF', 'memory.noteRestore needs the run\'s memory.notes lever, and this run has it off', { lever: 'notes' });
  const out = E.store.tx(() => {
    const row = loadNote(E, args.id);
    if (!row || row.type !== 'note' || !row.namespace.startsWith('archive/')) throw err('E_NOT_FOUND', `no archived note ${args.id}${row ? ` (it is in ${row.namespace})` : ''}`, { id: args.id });
    const project = row.namespace.slice('archive/'.length);
    if (caller.role === 'orchestrator' && M.projectOf(E, caller) !== project) throw err('E_ROLE', `note ${row.id} is archived in project ${project}, not this run's`, { id: row.id, role: caller.role });
    const was = row.b.archived || null;
    // Back to where it came from: a note archived while pending returns to pending (and its resolution), never to live.
    const toPending = !!(was && typeof was.from === 'string' && was.from.startsWith('pending/'));
    if (toPending) {
      const to = N.pendingNs(project);
      const clash = E.store.p('SELECT id FROM memory_entries WHERE namespace = ? AND text_hash = ? AND id != ?').get(to, row.text_hash, row.id);
      if (clash) throw err('E_EXISTS', `note ${row.id} has the same text as ${clash.id} in ${to}`, { id: row.id, existing_id: clash.id });
      E.store.moveRow(row.id, row.namespace, to);
    } else {
      N.release(E, row, project); // the same move as a resolved pending note: a clash with a live row of the same text is E_EXISTS
    }
    // What the kept note took from this one comes back, so the lesson is counted once wherever it ends up.
    const returned = require('./memory-archive.cjs').untransfer(E, row);
    const entry = { at: Date.now(), by: E.memoryWriter(caller), role: caller.role, run_id: caller.run_id, reason, was_archived: was, history_returned: returned };
    E.store.patchBody(row.id, b => { b.state = toPending ? 'pending' : 'live'; b.restored = [...(b.restored || []), entry].slice(-RESTORED_KEEP); delete b.archived; if (!toPending) delete b.matches; return N.fitBody(b); });
    // A note archived with reports that were never settled is held again, in the same transaction, for those reports (a restore reopens the dispute); the
    // operator may settle them instead. A restore to pending writes no hold: a pending note is not live, and its reports wait.
    let reopened = null, settled = null;
    if (!toPending) {
      const RM = require('./report-marks.cjs');
      const fresh = loadNote(E, row.id);
      const open = RM.unsettled(fresh.b);
      if (open.length && args.settle_reports === true) {
        const keys = open.map(RM.reportKey);
        E.store.patchBody(row.id, b => { b.reports_settled = [...new Set([...(b.reports_settled || []), ...keys])]; b.restore_settled = { by: 'operator', at: entry.at, reason }; return N.fitBody(b); });
        settled = { keys, count: keys.length };
      } else if (open.length) {
        const threshold = (N.notesLevers(E, caller) || { notes_match_threshold: 0.8 }).notes_match_threshold;
        reopened = require('./memory-report-hold.cjs').holdReported(E, caller, { project, runId: caller.run_id, threshold, headSha: null, extra: { restored_from: (was && (was.review || was.held_row)) || null } }, fresh, open[open.length - 1]);
      }
    }
    return { id: row.id, restored: true, ...(reopened ? { held: reopened } : {}), ...(settled ? { settled } : {}), namespace: toPending ? N.pendingNs(project) : N.projectNs(project), receipt: { kind: 'restore', ...entry }, history_returned: returned, row: C.rowOut(E, row.id) };
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
  let written = null;
  let out;
  try {
    out = E.store.tx(() => {
    const { rows, skipped } = selectPurge(E, args);
    if (!rows.length) return { count: 0, path: null, sha256: null, ids: [], skipped };
    // The rows go to the file first and the file is read back; only then are they removed, in this transaction, so a
    // failed write leaves every row where it was.
    const { file, fd } = purgeFile(E.dataDir);
    written = file;
    try {
      const text = rows.map(r => { const { embedding, ...rest } = r; return JSON.stringify({ ...rest, embedding_b64: embedding ? Buffer.from(embedding).toString('base64') : null }); }).join('\n') + '\n';
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (fs.readFileSync(file, 'utf8').trim().split('\n').length !== rows.length) throw err('E_INTERNAL', `the purge file ${file} does not hold the ${rows.length} rows; nothing was removed`);
    for (const r of rows) E.store.p('DELETE FROM memory_entries WHERE id = ?').run(r.id);
    for (const ns of new Set(rows.map(r => r.namespace))) E.store.cache.delete(ns);
    // The receipt outlives the call: a ledger row names the file, its hash and the ids, in the same transaction.
    recordEventSync(E, caller, { kind: 'archive_purge', key: file, row_ids: rows.map(r => r.id), bytes: fs.statSync(file).size, sha256, ok: true, message: `purged ${rows.length} archived notes to ${file}` });
    return { count: rows.length, path: file, sha256, ids: rows.map(r => r.id), skipped };
    });
  } catch (e) {
    // The rows are still there, so the file written for them must not be left behind as if they were gone.
    if (written) { try { fs.unlinkSync(written); } catch { /* already gone */ } }
    throw e;
  }
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
  return E.store.p(`SELECT id, namespace, type, title, run_id, created_at, body FROM memory_entries WHERE ${nsClause} AND written_by = 'harness'${where ? ` AND ${where}` : ''} ORDER BY created_at DESC, id LIMIT ${LIST_MAX}`).all(nsParam, ...(params || [])).map(lite);
}

async function proposals(E, caller, args) {
  C.allowKeys(args, ['project', 'all', 'root'], 'memory.proposals');
  if (args.root !== undefined && caller.role !== 'operator') throw err('E_ROLE', 'memory.proposals reads instruction files under root only for the operator', { role: caller.role });
  const project = projectScope(E, caller, args);
  const heldWhere = args.all === true ? null : "json_extract(body, '$.state') = 'held'";
  const proposalRows = listNs(E, 'proposal', project), held = listNs(E, 'held', project, heldWhere), drafts = listNs(E, 'draft', project);
  // Nominations for promotion to an instruction file, each with its stored drafts; with the operator's root, whether each
  // draft's text is already in its target file and which promoted notes' text has been removed (a read; nothing changes).
  const nominations = require('./memory-nominate.cjs').listNominations(E, project, args.all === true);
  const out = { project, proposals: proposalRows, held, drafts, nominations, counts: { proposals: proposalRows.length, held: held.length, drafts: drafts.length, nominations: nominations.length }, limit: LIST_MAX };
  if (args.root !== undefined) {
    const P = require('./methods-memory-promote-note.cjs');
    for (const n of nominations) for (const d of n.drafts) d.present = P.textPresent(args.root, d.target, d.rule).state;
    out.promoted_check = P.checkPromoted(E, args.root, project);
  }
  return out;
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
