'use strict';
// methods-memory-status.cjs — memory.setStatus (ADR 0040 §2). A worker cannot verify a claim, its own or a
// peer's, so the engine admits only the orchestrator and the operator; this module holds the evidence rule.
// A status other than unverified needs a receipt that follows the grammar in memory-rows.cjs and, where it
// names a row, names one that exists. Setting unverified clears the receipt (the claim is back to unproven,
// so it keeps no evidence); who reset it and when are still recorded.
//
// ADR 0041 §5: verifying a row of a run's own namespace copies it into the run's project namespace, but only when that
// run's levers have `project_writes` on and name a project. Every other call answers exactly as it did before.

const fs = require('node:fs');
const { err } = require('./errors.cjs');
const rows = require('./rows.cjs');
const { parseReceipt, STATUSES } = require('./memory-rows.cjs');

const COPY_PREFIX = 'copy-of:';
const GIT_BOUND_MS = 10000;
const WORKTREES_MAX = 5;
const TEST_CLAIM = 'a test: receipt is the verifier\'s own statement that a test ran and passed; belay did not run it';
const noReceipt = (receipt, reason) => err('E_RECEIPT', `memory.setStatus: receipt ${JSON.stringify(receipt)} refused: ${reason}`, { receipt, reason });

// Existence checks for the receipt kinds that name a row. commit: is checked against git below; test: is the
// verifier's claim, and the answer says so.
function checkRef(E, parsed, receipt, id, status) {
  if (parsed.kind === 'checkpoint') {
    if (!rows.current(E.store, 'checkpoint', parsed.ref)) throw noReceipt(receipt, `no checkpoint ${parsed.ref}`);
  } else if (parsed.kind === 'task') {
    const task = rows.current(E.store, 'task', parsed.ref);
    if (!task) throw noReceipt(receipt, `no task ${parsed.ref}`);
    if (status === 'verified' && task.state !== 'done') throw noReceipt(receipt, `task ${parsed.ref} is ${task.state}, and a task receipt for verified needs it done`);
  } else if (parsed.kind === 'memory') {
    // A row cannot vouch for itself: that would be a receipt that proves nothing.
    if (parsed.ref === id) throw noReceipt(receipt, 'a row cannot be its own receipt');
    if (!E.store.p('SELECT 1 FROM memory_entries WHERE id = ?').get(parsed.ref)) throw noReceipt(receipt, `no memory row ${parsed.ref}`);
  }
}

// The worktrees a commit receipt can be checked in: the row's own worker's, then the other workers' of the row's run.
// Read from the worker rows, never from the caller.
function worktreesOf(E, row) {
  const out = [];
  const add = (w) => { if (w && typeof w === 'string' && !out.includes(w)) out.push(w); };
  try {
    if (row.worker_id) { const w = rows.current(E.store, 'worker', row.worker_id); if (w && w.run_id === row.run_id) add(w.worktree); }
    if (row.run_id) for (const r of E.store.p('SELECT DISTINCT worktree FROM worker WHERE run_id = ? AND worktree IS NOT NULL ORDER BY seq DESC LIMIT 20').all(row.run_id)) add(r.worktree);
  } catch { /* a store copy without the worker table knows no worktree */ }
  return out.slice(0, WORKTREES_MAX);
}

// ADR 0040 §2, commit receipts: a commit the row's run can see in git, when the run has a worktree that git answers
// in. git rev-parse --verify exits 1 for a name that is no commit there (refused), and otherwise (no repository, no
// git, a timeout) the worktree is passed over; when none answered, the answer says the commit was not checked.
async function checkCommit(E, row, sha, receipt) {
  const trees = worktreesOf(E, row);
  const misses = [];
  const { runCommand } = require('./evaluate.cjs');
  for (const wt of trees) {
    if (!fs.existsSync(wt)) continue;
    const r = await runCommand(['git', 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`], wt, GIT_BOUND_MS);
    if (r.exit_code === 0) return { kind: 'commit', checked: true, found: true, worktree: wt, commit: String(r.stdout || '').trim() };
    if (r.exit_code === 1) misses.push(wt);
  }
  if (misses.length) throw noReceipt(receipt, `no commit ${sha} in ${misses.join(', ')}`);
  return { kind: 'commit', checked: false, reason: trees.length ? 'git did not answer in any worktree of the row\'s run' : 'no worktree is known for the row\'s run; the receipt was checked by syntax only' };
}

// The levers and project of the run that wrote the row, from that run's latest row. A store without the columns, an
// unparseable lever block and a run with no project all mean "no copy".
function projectCopyTarget(E, row) {
  if (!row.run_id || row.namespace !== `run/${row.run_id}` || String(row.provenance || '').startsWith(COPY_PREFIX)) return null;
  let run;
  try { run = E.store.p('SELECT project, memory_levers FROM run WHERE id = ? ORDER BY seq DESC LIMIT 1').get(row.run_id); } catch { return null; }
  if (!run || !run.project || !run.memory_levers) return null;
  let levers;
  try { levers = typeof run.memory_levers === 'string' ? JSON.parse(run.memory_levers) : run.memory_levers; } catch { return null; }
  return levers && levers.project_writes === true ? `project/${run.project}` : null;
}

// The receipt for the copy: a memory_event of kind project_write, ok or failed with its code. A store that has no
// ledger table cannot take one, and that does not undo the copy.
async function recordCopy(E, caller, row, ev) {
  try {
    await require('./methods-ledger.cjs').recordEvent(E, caller, {
      kind: 'project_write', run_id: row.run_id, worker_id: row.worker_id || undefined, task_id: row.task_id || undefined, key: `${COPY_PREFIX}${row.id}`, ...ev,
    });
  } catch { /* the copy's own result below still names what happened */ }
}

// Copy a verified run row into the project namespace and verify the copy with the same receipt. The status change
// on the source has already been written; a failed copy is returned and recorded, never swallowed.
async function copyVerified(E, caller, row, namespace, receipt, at) {
  try {
    // A project namespace is always scrubbed (ADR 0040 §3), whatever the source run's redact lever was. A copy whose
    // text the scrub changed does not carry the source's vector, which was made from the unscrubbed text.
    const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
    const s = require('./methods-memory.cjs').scrub(true, { text: row.text, title: row.title, body: parse(row.body), tags: parse(row.tags) || undefined, provenance: undefined });
    const keepVec = s.text === row.text;
    const vec = keepVec && row.embedding && row.dim ? Array.from(new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.dim * 4))) : null;
    const was = parse(row.redactions);
    const copy = E.store.store({
      namespace, worker_id: E.writtenBy(caller), written_by: E.memoryWriter(caller), type: row.type, text: s.text, title: s.title, body: s.body,
      redactions: s.redactions || (was && !was.disabled ? was : null), tags: s.tags, provenance: `${COPY_PREFIX}${row.id}`,
      run_id: row.run_id, task_id: row.task_id, turn: row.turn, source: row.source,
      ...(vec ? { embedding: vec, embedding_model: row.embedding_model, embedding_revision: row.embedding_revision, dim: row.dim } : {}),
    });
    const status = E.store.setStatus(copy.id, { status: 'verified', receipt, by: E.writtenBy(caller), at });
    E.noteWrite();
    await recordCopy(E, caller, row, { ok: true, row_ids: [copy.id], newest_row_id: copy.id, message: `copied ${row.id} to ${namespace}` });
    return { ok: true, id: copy.id, namespace, action: copy.action, status: status.status, source_id: row.id };
  } catch (e) {
    const code = e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL';
    await recordCopy(E, caller, row, { ok: false, code, row_ids: [row.id], message: String((e && e.message) || e).slice(0, 300) });
    return { ok: false, namespace, code, message: String((e && e.message) || e).slice(0, 300), source_id: row.id };
  }
}

async function setStatus(E, caller, args) {
  const { id, status, receipt } = args;
  if (typeof id !== 'string' || !id) throw err('E_ARGS', 'memory.setStatus needs an id', { field: 'id' });
  if (!STATUSES.includes(status)) throw err('E_ARGS', `memory.setStatus status must be one of ${STATUSES.join(', ')}`, { field: 'status', value: status });
  if (!E.store.p('SELECT 1 FROM memory_entries WHERE id = ?').get(id)) throw err('E_NOT_FOUND', `no memory row ${id}`, { id });
  let kept = null, check = null;
  if (status !== 'unverified') {
    // Before any write: a refused receipt changes nothing.
    if (typeof receipt === 'string' && receipt.startsWith('review:')) throw noReceipt(receipt, 'a review: receipt is written only by belay, when it applies a reviewer\'s verdict whose citations it has checked (memory.noteVerdicts)');
    const parsed = parseReceipt(receipt);
    if (parsed.error) throw noReceipt(receipt, parsed.error);
    checkRef(E, parsed, receipt, id, status);
    if (parsed.kind === 'commit') check = await checkCommit(E, E.store.p('SELECT id, worker_id, run_id FROM memory_entries WHERE id = ?').get(id), parsed.ref, receipt);
    else if (parsed.kind === 'test') check = { kind: 'test', checked: false, claim: TEST_CLAIM };
    kept = receipt;
  }
  // checkCommit awaited git: run.end may have committed meanwhile (audit D42). Checked in the tick of the first write. Once the status
  // has landed, its project copies follow it to the end (a copy must never keep a status its source lost), so they are not re-checked.
  E.assertRunOpen(caller, 'memory.setStatus');
  const at = Date.now();
  const out = E.store.setStatus(id, { status, receipt: kept, by: E.writtenBy(caller), at });
  E.noteWrite();
  if (check) out.receipt_check = check;
  const row = E.store.p('SELECT * FROM memory_entries WHERE id = ?').get(id);
  if (status === 'verified') {
    const target = projectCopyTarget(E, row);
    if (target) out.project_copy = await copyVerified(E, caller, row, target, kept, at);
  }
  const followed = await followCopies(E, caller, row, { status, receipt: kept, at }, out.project_copy && out.project_copy.id);
  if (followed.length) out.copies = followed;
  return out;
}

// A copy outlives its run, so it must never keep a status its source has lost: a row refuted (or set back to
// unverified) after it was verified would otherwise stay verified in the project namespace, and the index and
// the corpus would go on serving it. Every row that names this one as its source (copy-of:<id>, written here or
// by the run's summary copy) takes the same status and receipt, and each change is a project_write event.
async function followCopies(E, caller, row, change, skipId) {
  const copies = E.store.p('SELECT id, namespace, status FROM memory_entries WHERE provenance = ? AND id <> ?').all(`${COPY_PREFIX}${row.id}`, row.id);
  const out = [];
  for (const c of copies) {
    if (c.id === skipId) continue;
    try {
      const s = E.store.setStatus(c.id, { status: change.status, receipt: change.receipt, by: E.writtenBy(caller), at: change.at });
      E.noteWrite();
      await recordCopy(E, caller, row, { ok: true, row_ids: [c.id], newest_row_id: c.id, message: `set copy ${c.id} in ${c.namespace} to ${change.status}, as its source ${row.id}` });
      out.push({ ok: true, id: c.id, namespace: c.namespace, status: s.status, source_id: row.id });
    } catch (e) {
      const code = e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL';
      const message = String((e && e.message) || e).slice(0, 300);
      await recordCopy(E, caller, row, { ok: false, code, row_ids: [c.id], message });
      out.push({ ok: false, id: c.id, namespace: c.namespace, code, message, source_id: row.id });
    }
  }
  return out;
}

module.exports = { setStatus };
