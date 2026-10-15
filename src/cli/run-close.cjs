'use strict';
// run-close.cjs — ADR 0029 decisions 3 and 4 and amendment 1, the write path of `belay run` between the
// orchestrator loop returning and run.end. Split out of cmd-run.cjs to keep that file under its line
// budget. It never imports src/run (the CLI must not, api.md §1); the kill mechanics are the shared ones in
// src/core/process.cjs and always take an exact pid, never a command-line match (ADR 0011 decision 2).

const processDefaults = require('../core/process.cjs');
const KL = require('../core/kill-log.cjs');
const { pidAlive } = require('../core/lock.cjs');
const { LIFE_CLAIMING_STATES } = require('../core/methods-run.cjs');

const KILL_GONE_BOUND_MS = 5000;
const FRESH_SNAPSHOT_NEEDS_MS = 1200; // a CIM snapshot takes about a second
// Amendment 1 item 2: the adapter's graceful stop takes up to 10,000 ms per worker (lifecycle.cjs).
const ADAPTER_STOP_PER_WORKER_MS = 10000;
const ADAPTER_STOP_SLACK_MS = 5000;

// ADR 0048 decision 5: the three ways a worker is left alive are told apart, and each names the command that can still prove it.
const withIdHint = (manual, id) => manual + '. Or run "belay worker kill ' + id + '", which proves the identity again from the row with a full snapshot budget';
const manualWithId = (w) => withIdHint(processDefaults.manualStopHint(w.pid, processDefaults.rowTarget(w).image), w.id);
function outcomeOf(e) {
  if (e.gone) return 'closed';
  if (e.refused) return e.kind === 'no_budget' ? 'refused_no_budget' : (e.kind === 'unverifiable' ? 'refused_unverifiable' : `refused_${e.kind || 'identity'}`);
  return e.signalled ? 'signalled_still_alive' : 'not_signalled_still_alive';
}

// A Codex `idle` row has no process by design (api.md §2): run.end closes it, belay run never kills it.
const hasProcess = (w) => !(w.substrate === 'codex' && w.state === 'idle');
const claimsLiveProcess = (w) => LIFE_CLAIMING_STATES.has(w.state) && hasProcess(w) && pidAlive(w.pid);

// Returns { adapter_pid, adapter_gone, adapter_wait_ms, adapter_wait_bound_ms, killed: [...], still_alive: [...],
// errors }. `marked_dead` is added by the caller from run.end's own result. Never throws on a failed read or
// kill: what could not be established is named in `errors`, and the caller makes that a failure (exit 1).
// `deps` is a test seam for the kill mechanics. `fast` (ADR 0037 decision 6, the console closing) is
// { requested(): bool, leftMs?(): ms the close has left, which cuts each kill wait } and is additive: absent, nothing changes. A fast close skips
// the adapter wait (the adapter is already gone) or cuts it short when the request arrives during it.
async function closeRunWorkers({ core, runId, graceMs, ownPid = process.pid, deps = {}, fast = null }) {
  const { killProcess, waitPidGone, withKillLock } = { ...processDefaults, ...deps };
  const { rowTarget } = processDefaults;
  const cut = { v: false }; // set when the budget's race timer fires or finalizeCut runs: a snapshot landing after it signals nothing
  const unrecorded = new Map(); // workers whose entry is not written yet, for a close the budget cuts (finalizeCut)
  const out = { adapter_pid: null, adapter_gone: true, adapter_wait_ms: 0, adapter_wait_bound_ms: graceMs, killed: [], still_alive: [], left_parked: [], errors: [] };
  const listRun = async () => {
    try { return ((await core.worker.list({})).workers || []).filter((w) => w.run_id === runId); }
    catch (e) { out.errors.push(`worker.list: ${(e && e.message) || String(e)}`); return null; }
  };

  // (a) The run row's adapter is the orchestrator's adapter once it attached, else this process itself
  // (belay run's own attach), which is alive by definition and must not be waited on.
  try {
    const got = await core.run.get();
    const pid = got && got.run ? got.run.adapter_pid : null;
    out.adapter_pid = Number.isInteger(pid) ? pid : null;
  } catch (e) { out.errors.push(`run.get: ${(e && e.message) || String(e)}`); }
  const before = await listRun();
  // A cut before the final listing still names the workers known now (finalizeCut).
  if (fast) { fast.progress = { out, unrecorded, cut }; for (const w of before || []) if (claimsLiveProcess(w)) unrecorded.set(w.id, { w, touched: () => false }); }
  const liveCount = before ? before.filter(claimsLiveProcess).length : 0;
  out.adapter_wait_bound_ms = Math.max(graceMs, liveCount * ADAPTER_STOP_PER_WORKER_MS + ADAPTER_STOP_SLACK_MS);
  if (out.adapter_pid != null && out.adapter_pid !== ownPid && pidAlive(out.adapter_pid)) {
    if (fast && fast.requested()) {
      out.adapter_gone = false; out.adapter_wait_ms = 0; out.fast_close = true;
    } else {
      // With `fast`, the wait runs in short slices so a request that arrives during it cuts it short at once
      // and no long poll is left running behind it.
      const t = Date.now();
      let ms = null;
      let cut = false;
      if (!fast) ms = await waitPidGone(out.adapter_pid, { timeoutMs: out.adapter_wait_bound_ms });
      else {
        for (;;) {
          const left = out.adapter_wait_bound_ms - (Date.now() - t);
          if (left <= 0) break;
          const got = await waitPidGone(out.adapter_pid, { timeoutMs: Math.min(100, left) });
          if (got !== null) { ms = Date.now() - t; break; }
          if (fast.requested()) { cut = true; break; }
        }
      }
      if (cut) { out.adapter_gone = false; out.adapter_wait_ms = Date.now() - t; out.fast_close = true; }
      else { out.adapter_gone = ms !== null; out.adapter_wait_ms = ms !== null ? ms : out.adapter_wait_bound_ms; }
    }
  }

  // (b) Whatever is still claiming a life with a live pid is this run's to stop. Listed again: the adapter
  // may have written its own rows while it was waited for.
  const workers = await listRun();
  // ADR 0023 amendment 5: a run quit while paused leaves its parked workers parked (no process, no pid to kill); named, not touched.
  out.left_parked = (workers || []).filter((w) => w.state === 'paused').map((w) => w.id);
  unrecorded.clear();
  for (const w of workers || []) {
    if (!claimsLiveProcess(w)) continue;
    unrecorded.set(w.id, { w, touched: () => false });
    // A fast close (decision 6) gives every wait only the time the close has left; the kill itself is always sent.
    const left = () => (fast && fast.leftMs ? fast.leftMs() : Infinity);
    // ADR 0039: the row's pid_created is the identity. A pid another process holds is refused and named, never killed.
    // A fast close (a console closing) starts its identity snapshot at the SIGHUP, so the kills below never wait on it.
    // The snapshot is fresh (<250 ms) or taken now. With less budget left than a snapshot takes, none is taken:
    // the kill is refused as no_budget, never as an unreadable snapshot, and the kill log says the same.
    // The kill lock: a `belay stop` worker phase killing at the same time goes first; a snapshot that started before
    // a signal sent in this process is re-taken at use (ADR 0048 decision 2), and the lock's wait is inside the
    // budget's race below. A snapshot that lands after the budget is spent signals nothing (`touched` stays false).
    let touched = false;
    unrecorded.get(w.id).touched = () => touched;
    const noBudget = () => fast && fast.snapshot && fast.leftMs && fast.leftMs() < FRESH_SNAPSHOT_NEEDS_MS && !(fast.snapshotPending && fast.snapshotPending());
    const killP = withKillLock(() => {
      if (noBudget()) return { noBudget: `no budget for a fresh snapshot in the fast close (${Math.round(fast.leftMs())} ms left, a snapshot needs ${FRESH_SNAPSHOT_NEEDS_MS} ms); nothing was signalled` };
      return killProcess(rowTarget(w), fast && fast.snapshot ? { snapshot: async () => { const r = await fast.snapshot(); if (cut.v || (fast.leftMs && fast.leftMs() <= 0)) return { snap: null, error: 'deadline', startSeq: null }; touched = true; return r; } } : {});
    }).catch((e) => ({ tree: null, pidKill: { signalled: false }, identity: null, refused: { refused: 'identity', detail: (e && e.message) || String(e) } }));
    const kp = fast && fast.leftMs ? await Promise.race([killP, new Promise((r) => { setTimeout(() => { cut.v = true; r(); }, Math.min(left(), 2147483647)).unref(); })]) : await killP;
    if (kp && kp.noBudget) {
      const rec = KL.begin('fastCloseSkip', rowTarget(w)); if (rec) rec({ ok: false, kind: 'no_budget', detail: kp.noBudget });
      const manual = manualWithId(w);
      unrecorded.delete(w.id);
      out.killed.push({ worker_id: w.id, pid: w.pid, gone: !pidAlive(w.pid), gone_ms: null, tree_terminated: null, signalled: false, outcome: pidAlive(w.pid) ? 'refused_no_budget' : 'closed', identity: null, refused: 'identity', kind: 'no_budget', detail: kp.noBudget, manual });
      if (pidAlive(w.pid)) out.still_alive.push({ worker_id: w.id, pid: w.pid, manual });
      continue;
    }
    const tree = kp && kp.tree; const sig = (kp && kp.pidKill) || { signalled: false };
    // A refused kill signalled nothing, so there is no death to wait for: one pid check, and the close's budget is
    // left for the next worker (a fast close that waited here lost every refusal with the deadline).
    const goneMs = kp && kp.refused ? (pidAlive(w.pid) ? null : 0) : await waitPidGone(w.pid, { timeoutMs: Math.max(100, Math.min(KILL_GONE_BOUND_MS, left())) });
    const entry = { worker_id: w.id, pid: w.pid, gone: goneMs !== null, gone_ms: goneMs, tree_terminated: tree && tree.terminated != null ? tree.terminated : null, signalled: !!(sig.signalled || (tree && tree.killed && tree.killed.includes(w.pid))), identity: kp ? kp.identity : null, ...(kp && kp.refused ? { refused: kp.refused.refused, kind: kp.refused.kind, detail: kp.refused.detail, ...(kp.refused.manual ? { manual: kp.refused.manual } : {}) } : {}), ...(kp ? {} : touched ? { refused: 'identity', kind: 'unverifiable', detail: 'the fast-close budget ran out while the kill was proving the process' } : { refused: 'identity', kind: 'no_budget', detail: 'the fast-close budget ran out before a snapshot could prove the process; nothing was signalled' }) };
    entry.outcome = outcomeOf(entry);
    const proved = entry.kind === 'mismatch' || entry.kind === 'absent'; // another process provably holds the pid: no advice to kill it
    if (!entry.gone && !entry.manual && !proved) entry.manual = manualWithId(w);
    else if (entry.manual && entry.outcome !== 'closed') entry.manual = withIdHint(entry.manual, w.id);
    if (kp && kp.signalled_at) entry.signalled_at = kp.signalled_at;
    if (kp && Number.isFinite(kp.snapshot_ms)) entry.snapshot_ms = kp.snapshot_ms;
    out.killed.push(entry); unrecorded.delete(w.id);
    if (!entry.gone) out.still_alive.push({ worker_id: w.id, pid: w.pid, outcome: entry.outcome, ...(entry.manual ? { manual: entry.manual } : {}) });
  }
  return out;
}

// A fast close the budget cut before every worker had an entry (ADR 0048 decision 4): what the close had recorded, and for
// each worker it had not, an entry that says nothing was signalled for want of budget (`unverifiable` when its kill was
// already proving the process), the manual hint and `belay worker kill`. Later pushes to the live record are ignored.
function finalizeCut(progress) {
  if (!progress) return null;
  const { out, unrecorded, cut: flag } = progress;
  if (flag) flag.v = true; // from here no kill of this close signals, whatever the clocks say
  const cut = { ...out, killed: [...out.killed], still_alive: [...out.still_alive], errors: [...out.errors], fast_close: true };
  for (const { w, touched } of unrecorded.values()) {
    const proving = touched();
    const manual = manualWithId(w);
    const alive = pidAlive(w.pid);
    const kind = proving ? 'unverifiable' : 'no_budget';
    const detail = proving ? 'the fast-close budget ran out while the kill was proving the process' : 'the fast-close budget ran out before a snapshot could prove the process; nothing was signalled';
    cut.killed.push({ worker_id: w.id, pid: w.pid, gone: !alive, gone_ms: null, tree_terminated: null, signalled: false, outcome: alive ? `refused_${kind}` : 'closed', identity: null, refused: 'identity', kind, detail, manual });
    if (alive) cut.still_alive.push({ worker_id: w.id, pid: w.pid, outcome: `refused_${kind}`, manual });
  }
  return cut;
}

// What the receipt carries under `workers_closed`.
function workersClosedBlock(closed, markedDead) {
  return {
    adapter_gone: closed.adapter_gone, adapter_wait_ms: closed.adapter_wait_ms,
    adapter_wait_bound_ms: closed.adapter_wait_bound_ms, adapter_pid: closed.adapter_pid,
    killed: closed.killed.map((k) => ({ worker_id: k.worker_id, pid: k.pid, gone: k.gone, outcome: k.outcome || null, signalled: !!k.signalled, ...(k.signalled_at ? { signalled_at: k.signalled_at } : {}), ...(Number.isFinite(k.snapshot_ms) ? { snapshot_ms: k.snapshot_ms } : {}), identity: k.identity || null, ...(k.refused ? { refused: k.refused, kind: k.kind || null, detail: k.detail, ...(k.manual ? { manual: k.manual } : {}) } : {}) })),
    marked_dead: markedDead, left_parked: closed.left_parked || [], errors: closed.errors,
  };
}

module.exports = { closeRunWorkers, workersClosedBlock, finalizeCut };
