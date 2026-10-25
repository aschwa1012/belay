'use strict';
// run-close-rows.cjs — run.end's two passes over its own workers' rows (ADR 0029 decision 1, amendments 1 and 2), moved out of
// methods-run.cjs to keep that file under its line budget: the life-claiming rows whose pid is dead are closed `dead` (releasing
// their leases, ADR 0026 amendment 1), and terminal rows with no head get one. Both read the worktree's HEAD, bounded.

const fs = require('node:fs');
const rows = require('./rows.cjs');
const { pidAlive } = require('./lock.cjs');
const { runCommand } = require('./evaluate.cjs');
const { appendDead } = require('./lease-holder-dead.cjs');

// ADR 0029 decision 1: HEAD of a worker's worktree, bounded, argv with no shell. Never throws.
const HEAD_BOUND_MS = 5000;
async function headOf(worktree) {
  if (!worktree) return { sha: null, error: 'the worker row names no worktree' };
  if (!fs.existsSync(String(worktree))) return { sha: null, error: `worktree ${worktree} does not exist` };
  const r = await runCommand(['git', 'rev-parse', 'HEAD'], String(worktree), HEAD_BOUND_MS);
  if (!r.executable) return { sha: null, error: `git could not be run: ${r.spawn_error}` };
  if (r.timed_out) return { sha: null, error: `git rev-parse HEAD timed out after ${HEAD_BOUND_MS} ms` };
  const sha = String(r.stdout || '').trim();
  if (r.exit_code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    return { sha: null, error: `git rev-parse HEAD in ${worktree} exited ${r.exit_code}: ${String(r.stderr || '').trim().slice(0, 200)}` };
  }
  return { sha, error: null };
}

// ADR 0029 decision 1 and amendment 1 item 1: the ending epoch's own workers, closed by the rule run.attach
// applies to the previous one. A claim is dead only by a pid check (invariant 4), except a Codex `idle`
// row: its process exits between turns by design (api.md §2), so its pid proves nothing and the row is
// closed with the run whatever the pid says. The row is re-read after the git call and nothing is written
// over one that moved on, or (for a pid-checked row) whose pid came back, in the meantime.
const CODEX_IDLE_BY = 'run.end: a Codex worker between turns has no process by design; its run ended (ADR 0029)';
const isCodexIdle = (w) => w.substrate === 'codex' && w.state === 'idle';
async function closeEpochWorkers(E, runId, by, lifeClaiming) {
  const marked = [];
  const t = Date.now();
  for (const w of rows.currentAll(E.store, 'worker')) {
    if (w.run_id !== runId || !lifeClaiming.has(w.state)) continue;
    const codexIdle = isCodexIdle(w);
    if (!codexIdle && pidAlive(w.pid)) continue;
    const head = await headOf(w.worktree);
    const cur = rows.current(E.store, 'worker', w.id);
    if (!cur || cur.seq !== w.seq || (!codexIdle && pidAlive(cur.pid))) continue;
    // The head the row carries: git's answer, else the head the row already had (never overwritten with null).
    const headSha = head.sha == null ? (cur.head_sha == null ? null : cur.head_sha) : head.sha;
    const { released } = appendDead(E, {
      ...cur, state: 'dead', exited_at: cur.exited_at == null ? t : cur.exited_at,
      death_established_by: codexIdle ? CODEX_IDLE_BY
        : `run.end: pid ${cur.pid} not alive when the run ended; no adapter wrote its exit (ADR 0029)`,
      head_sha: headSha, head_error: headSha != null ? null : (cur.head_error == null ? null : cur.head_error), paused_at: null, paused_by: null,
    }, by, t);
    marked.push({ worker_id: w.id, from_state: w.state, head_sha: headSha, ...(head.error ? { head_error: head.error } : {}), ...(released.length ? { leases_released: released } : {}) });
  }
  return marked;
}

// ADR 0029 amendment 2: a terminal (stopped or dead) row of the run that has a worktree and no head gets one
// appended row restating it with the worktree's head. Nothing but head_sha changes. Same seq re-read guard as
// closeEpochWorkers; git failing appends nothing and the entry names why. Rows closeEpochWorkers just wrote
// already carry a head (or a git error it reported) and are skipped, so nothing is double-written.
async function fillMissingHeads(E, runId, by, skip) {
  const filled = [];
  const t = Date.now();
  for (const w of rows.currentAll(E.store, 'worker')) {
    if (w.run_id !== runId || (w.state !== 'stopped' && w.state !== 'dead')) continue;
    if (w.head_sha != null || !w.worktree || skip.has(w.id)) continue;
    const head = await headOf(w.worktree);
    if (head.sha == null) { filled.push({ worker_id: w.id, state: w.state, head_sha: null, head_error: head.error }); continue; }
    const cur = rows.current(E.store, 'worker', w.id);
    if (!cur || cur.seq !== w.seq) continue;
    rows.append(E.store, 'worker', { ...cur, head_sha: head.sha, head_error: null }, by, t);
    filled.push({ worker_id: w.id, state: w.state, head_sha: head.sha });
  }
  return filled;
}

module.exports = { closeEpochWorkers, fillMissingHeads, headOf };
