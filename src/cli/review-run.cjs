'use strict';
// review-run.cjs — `belay memory review` as a CLAIMED review, and its detached launcher.
//
// The Opus archive reviewer is a child belay must parent and see exit (invariant 1), and it spends money, so:
//   * the process that runs a review (this CLI, `belay memory review`) takes a store-level CLAIM first (core/review-claim.cjs: its pid and
//     creation time, the project, the job id), holds it while the child runs, and releases it with the outcome. A second review of the
//     project refuses while the claim's process is alive BY IDENTITY; a claim whose process is gone is taken over, recorded, and its
//     orphaned child (found by the job's worker row, killed by exact identity, ADR 0039) is stopped.
//   * on SIGINT, SIGTERM, SIGBREAK or SIGHUP the stage is told to fast-close: the child is killed by its exact pid before this process
//     exits. (A Windows terminate skips handlers; the claim and the takeover sweep are what cover that case.)
//   * `--start` is the launcher the panel's button runs: it checks, spawns this same command DETACHED so a hot reload of the panel cannot
//     end it, waits for the claim to appear as proof (invariant 5), prints it and exits. The detached CLI is the harness for the child.

const { spawn } = require('node:child_process');
const P = require('./panel-common.cjs');

const START_WAIT_MS = 20000;
const POLL_MS = 150;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];
const one = (s) => P.clean(s == null ? '' : s, 2000).replace(/\s+/g, ' ');
const codeOf = (e) => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The process facts, with a seam for tests (BELAY_TEST_MODE only; production never reads ctx.stageDeps).
function depsOf(ctx) {
  const t = (process.env.BELAY_TEST_MODE === '1' && ctx && ctx.stageDeps) || {};
  const PR = require('../core/process.cjs');
  return {
    pidAlive: t.pidAlive || require('../core/lock.cjs').pidAlive,
    createdOf: t.createdOf || ((pid) => PR.createdOf(pid)),
    killMany: t.killMany || ((targets) => PR.killMany(targets)),
    rowTarget: PR.rowTarget,
    spawnDetached: t.spawnDetached || spawnDetached,
    signals: t.signals || process,
    startWaitMs: t.startWaitMs || START_WAIT_MS,
  };
}

// Is the process a claim names gone? { dead, via }: `via` names what established it. Unprovable is alive (never kill or take over on a guess).
async function claimIsDead(claim, D) {
  if (!claim.pid || !D.pidAlive(claim.pid)) return { dead: true, via: `pid ${claim.pid} does not answer a pid check` };
  if (claim.created == null) return { dead: false, via: `pid ${claim.pid} answers a pid check and the claim has no creation time, so it cannot be shown to be another process` };
  let got = null;
  try { got = await D.createdOf(claim.pid); } catch { got = null; }
  if (!got || got.created == null) return { dead: false, via: `pid ${claim.pid} answers a pid check and the process snapshot could not read its creation time` };
  if (got.created !== claim.created) return { dead: true, via: `pid ${claim.pid} was created at ${got.created} and the claim says ${claim.created}: another process holds the pid` };
  if (claim.image && got.image && String(claim.image).toLowerCase() !== String(got.image).toLowerCase()) return { dead: false, via: `pid ${claim.pid} was created at ${claim.created} as the claim says, but its image is ${got.image}, not ${claim.image}; that proves nothing, so it is treated as alive` };
  return { dead: false, via: `pid ${claim.pid} is the claimed process (created ${claim.created})` };
}

// The dead claim's child, if it outlived its parent: the job's worker row has its pid and creation time. Killed by exact identity.
async function sweepOrphan(h, claim, D) {
  let row = null;
  try { const got = await h.worker.get({ worker_id: claim.job }); row = got && (got.worker || got); } catch { row = null; }
  if (!row || !Number.isInteger(row.pid) || !D.pidAlive(row.pid)) return { swept: false, detail: `the claimed job ${claim.job} left no live child` };
  const r = (await D.killMany([D.rowTarget(row)]))[0] || {};
  // A refusal of kind `mismatch` or `absent` PROVES the child is gone (another process holds its pid, or no process does; ADR 0039), so the
  // pid answering a pid check is no reviewer. Only an unverifiable refusal, or a kill that was not sent, leaves the child possibly running.
  const gone = !r.killed && r.refused === 'identity' && (r.kind === 'mismatch' || r.kind === 'absent');
  const detail = r.killed ? `killed orphan pid ${row.pid} of job ${claim.job}`
    : gone ? `orphan pid ${row.pid} of job ${claim.job} is gone (${r.kind}: ${r.detail || 'identity check'})`
      : `orphan pid ${row.pid} of job ${claim.job} was not killed: ${r.detail || r.error || 'refused'}`;
  return { swept: !!r.killed || gone, pid: row.pid, kind: r.kind || null, refused: r.refused || null, detail };
}

const busy = (project, st, extra = '') => {
  const c = st.claim || {};
  const message = `an archive review of ${project} is already running (pid ${c.pid}, job ${c.job}, claim ${c.id}, since ${c.at ? new Date(c.at).toISOString() : '?'})${extra}`;
  return { code: 1, text: `belay memory review: ${one(message)}\n`, json: { error: { code: 'E_BUSY', message, project, claim: c } } };
};

// Run the review under a claim. `s` is stageCore's answer, `common` the stage's arguments, `runReview` the stage.
async function claimedReview({ s, project, ctx, common, runReview, renderStage }) {
  const D = depsOf(ctx);
  const h = common.core;
  const state = ((await s.rc.memory.reviewState({ project })).reviews || {})[project] || { state: 'none' };
  const notes = [];
  let replaces = null;
  if (state.state === 'running') {
    const dead = await claimIsDead(state.claim, D);
    if (!dead.dead) return busy(project, state, `; ${dead.via}`);
    replaces = state.claim.id;
    const orphan = await sweepOrphan(h, state.claim, D);
    // A child that outlived its claimant and could not be stopped is a reviewer still running (and paid for): a second one must not
    // start beside it. Nothing is claimed or spawned, and the dead claim stays, so the next attempt tries the sweep again.
    if (!orphan.swept && orphan.pid != null && D.pidAlive(orphan.pid)) {
      return busy(project, state, `; the dead claim's child pid ${orphan.pid} is still alive and could not be stopped (${orphan.detail}); no second review was started`);
    }
    notes.push(`took over the dead claim ${state.claim.id} (${dead.via}); ${orphan.detail}`);
  }
  const jobId = `archreview-${s.runId}-${Date.now().toString(36)}`;
  let me = null;
  try { me = await D.createdOf(process.pid); } catch { me = null; }
  let claim;
  try {
    claim = (await s.rc.memory.reviewClaim({ project, pid: process.pid, created: me ? me.created : null, image: me ? me.image : null, job: jobId, replaces })).claim;
  } catch (e) {
    if (codeOf(e) !== 'E_BUSY') throw e;
    return busy(project, { claim: e.detail && e.detail.claim }, '; another review took the claim first');
  }
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  for (const sig of SIGNALS) D.signals.on(sig, onSignal);
  const sink = { survivors: [], pids: [] };
  let out;
  try {
    out = await runReview({ ...common, force: true, jobId, sink, fast: () => interrupted });
  } catch (e) {
    out = { ran: false, error: { code: codeOf(e), message: String((e && e.message) || e).slice(0, 300) } };
  } finally {
    for (const sig of SIGNALS) D.signals.removeListener(sig, onSignal);
  }
  if (sink.survivors.length) out.survivor = sink.survivors[0];
  const failed = !!out.error || sink.survivors.length > 0;
  const summary = out.error ? `${out.error.code}: ${out.error.message}` : out.ran ? `ran as ${out.job}: ${JSON.stringify(out.result && out.result.counts)}` : `nothing to do (${out.reason})`;
  let release = null;
  try {
    release = (await s.rc.memory.reviewRelease({ project, claim_id: claim.id, ok: !failed, ...(failed ? { code: out.error ? out.error.code : 'E_SURVIVOR' } : {}), message: summary })).release;
  } catch (e) { notes.push(`the claim ${claim.id} could not be released: ${codeOf(e)}: ${one(e.message)}`); }
  const text = `${renderStage('review', out)}${notes.map((n) => `  ${one(n)}\n`).join('')}  claim: ${claim.id} (pid ${claim.pid}, job ${jobId})${release ? ' released' : ' NOT released'}\n`;
  return { code: failed ? 1 : 0, text, json: { run_id: s.runId, ...out, claim: { id: claim.id, project, pid: claim.pid, job: jobId, released: !!release, took_over: replaces }, ...(notes.length ? { notes } : {}) } };
}

// ---- the detached launcher -----------------------------------------------------------------------------------------------

// The real detach: the child belongs to no job of the caller's and has no console window; the caller can exit.
function spawnDetached({ args, cwd }) {
  const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore', cwd, env: process.env });
  const exit = { code: undefined };
  child.once('exit', (code, signal) => { exit.code = code === null ? `signal ${signal}` : code; });
  child.once('error', (e) => { exit.code = `spawn error ${e.code || e.message}`; });
  child.unref();
  return { pid: child.pid, exited: () => exit.code };
}

// `belay memory review --project p --start`: check, launch detached, wait for the claim to show, print it, exit.
async function launch({ core, s, project, parsed, ctx, release }) {
  const D = depsOf(ctx);
  await release(s.rc); // the launcher holds no store: the detached CLI elects its own owner
  const before = ((await core.memory.reviewState({ project })).reviews || {})[project];
  if (before && before.state === 'running') { // the launcher is a write path: liveness is pid AND creation time, never a pid alone
    const dead = await claimIsDead(before.claim, D);
    if (!dead.dead) return busy(project, before, `; ${dead.via}`);
  }
  const args = [process.argv[1], 'memory', 'review', '--project', project, '--run', s.runId, '--data', s.dataDir, ...(s.worktree ? ['--worktree', s.worktree] : []), ...(parsed.opts.all ? ['--all'] : [])];
  const startedAt = Date.now();
  const child = D.spawnDetached({ args, cwd: s.worktree });
  if (!Number.isInteger(child.pid)) return { code: 1, text: 'belay memory review --start: the detached review did not start (no pid)\n', json: { error: { code: 'E_INTERNAL', message: 'no pid' } } };
  for (;;) {
    const st = ((await core.memory.reviewState({ project })).reviews || {})[project];
    const c = st && st.claim;
    if (c && c.pid === child.pid && c.at >= startedAt - 1000) {
      const ended = st.state === 'ended';
      const text = `archive review of ${project} ${ended ? `ended at once: ${st.release.ok ? 'ok' : st.release.code}${st.release.summary ? `: ${one(st.release.summary)}` : ''}` : 'started'}: pid ${c.pid}, job ${c.job}, claim ${c.id}\n`;
      return { code: ended && !st.release.ok ? 1 : 0, text, json: { started: !ended, project, run_id: s.runId, pid: c.pid, job: c.job, claim_id: c.id, ...(ended ? { ended: { ok: st.release.ok, code: st.release.code, summary: st.release.summary } } : {}) } };
    }
    const gone = child.exited();
    if (gone !== undefined) {
      const message = `the detached review (pid ${child.pid}) exited (${gone}) before it took the claim; nothing was reviewed`;
      return { code: 1, text: `belay memory review --start: ${message}\n`, json: { error: { code: 'E_INTERNAL', message, pid: child.pid } } };
    }
    if (Date.now() - startedAt > D.startWaitMs) {
      const message = `the detached review (pid ${child.pid}) took no claim within ${Math.round(D.startWaitMs / 1000)} s; it may still start (see belay notices)`;
      return { code: 1, text: `belay memory review --start: ${message}\n`, json: { error: { code: 'E_TIMEOUT', message, pid: child.pid } } };
    }
    await sleep(POLL_MS);
  }
}

module.exports = { claimedReview, launch, claimIsDead, sweepOrphan, SIGNALS };
