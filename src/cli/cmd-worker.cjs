'use strict';
// cmd-worker.cjs — build step 6b, design item 3, ADR 0019
// decisions 1 and 6, extended by build step 6c, design
// item 5, ADR 0019 decisions 2-5 and amendment 1. `belay worker kill|rm|stop|restart <worker-id>`.
// `kill` needs no adapter: it reads the worker row, kills the exact pid the harness spawned through
// src/core/process.cjs (never src/run, api.md §1), and writes nothing — the adapter's own detector
// lands the dead row. `rm` is a core write, worker.forget, mode W. `stop` and `restart` reach the
// worker adapter's own pipe through src/cli/adapter-pipe.cjs's ladder. The contract is in
// src/cli/belay.cjs: run(ctx) -> { code, text, json }, never printing, never calling process.exit.

const fs = require('node:fs');
const path = require('node:path');

const C = require('./config.cjs');
const { isPathId } = require('../core/path-id.cjs');
const { openCore, pidAlive } = require('../core/index.cjs');
const P = require('../core/process.cjs');
const { DEATH_LAND_MS } = require('../core/exit-hold.cjs');
const { callWorkerAdapter, stopBoundMs, restartBoundMs } = require('./adapter-pipe.cjs');

const fwd = p => String(p).split(path.sep).join('/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TERMINAL_STATES = new Set(['stopped', 'dead', 'forgotten']);
const KILL_WAIT_MS = 2000;
// The terminal row can trail the death by the exit-event hold (exit-hold.cjs), but only a live adapter can still write it.
const terminalRowWaitMs = (row) => (row.adapter_pid && pidAlive(row.adapter_pid) ? DEATH_LAND_MS : KILL_WAIT_MS);
const KILL_WAIT_MS_TEXT = '2,000'; // display form of KILL_WAIT_MS, matching the brief's own prose

function usageError(message) {
  return {
    code: 2,
    text: `belay worker: ${message}\n\nusage: belay worker <kill|rm|stop|restart> <worker-id> [options] [--data <dir>] [--json]\n`,
    json: { error: message },
  };
}

function renderKillText(receipt) {
  if (!receipt.killed) return `belay worker kill: ${receipt.reason}\n`;
  const ms = receipt.ms_to_dead == null ? receipt.row_after_waited_ms : receipt.ms_to_dead;
  return `worker ${receipt.worker_id} pid ${receipt.pid}: killed, dead after ${ms} ms; row ${receipt.row_after.state} (${receipt.row_after_established_by})\n`;
}

function renderRmText(receipt) {
  if (!receipt.forgotten) return `belay worker rm: ${receipt.reason}\n`;
  const leases = receipt.left.leases_unreleased.length;
  const disk = receipt.left.on_disk.exists ? 'exists' : 'absent';
  return `worker ${receipt.worker_id}: forgotten (row seq ${receipt.row_after.seq} supersedes seq ${receipt.row_before.seq}); ${leases} leases left unreleased; workers/${receipt.worker_id} ${disk}\n`;
}

// Poll worker.get every 200 ms for up to boundMs until the row's state is terminal (ADR 0019 decision
// 1: the adapter's own detector, exit event at once, or a 1,000 ms pid poll that holds the death up to
// POLL_EXIT_HOLD_MS for the exit code, lands the dead row within this bound). Never a write; each read is worker.get's own owner-first-then-copy round trip.
async function waitForTerminalRow(core, workerId, boundMs) {
  const t0 = Date.now();
  let last = await core.worker.get({ worker_id: workerId }).catch(() => null);
  while (!(last && (last.state === 'stopped' || last.state === 'dead')) && Date.now() - t0 < boundMs) {
    await sleep(200);
    last = await core.worker.get({ worker_id: workerId }).catch(() => last);
  }
  return { row: last, ms: Date.now() - t0 };
}

async function runKill(core, workerId) {
  let w;
  try {
    w = await core.worker.get({ worker_id: workerId });
  } catch (e) {
    return {
      worker_id: workerId, run_id: null, killed: false, row: null,
      reason: e.message, established_by: `worker.get answered ${e.code || 'E_INTERNAL'}: ${e.message}`,
    };
  }

  if (TERMINAL_STATES.has(w.state)) {
    return {
      worker_id: workerId, run_id: w.run_id, killed: false, row: w,
      reason: `row seq ${w.seq} is ${w.state}; nothing to kill`,
      established_by: `worker.get row seq ${w.seq}`,
    };
  }
  if (w.pid == null) {
    return {
      worker_id: workerId, run_id: w.run_id, killed: false, row: w,
      reason: `row seq ${w.seq} carries no pid: a ${w.substrate} worker between turns has no process to kill`,
      established_by: `worker.get row seq ${w.seq}`,
    };
  }
  if (!w.pid_alive) {
    return {
      worker_id: workerId, run_id: w.run_id, killed: false, row: w,
      reason: `row seq ${w.seq} claims ${w.state} but pid ${w.pid} is dead; nothing to kill; the next run.attach supersedes it`,
      established_by: `worker.get row seq ${w.seq} plus a pid check`,
    };
  }

  // ADR 0045 decision 4: the signal below is this process's own, so the owner never sees it. A bound owner is asked whether it vouches
  // for this process as the operator (the worker marker is only the stopgap; a worker's child with the marker removed is refused here).
  const proof = await require('../core/operator-proof.cjs').operatorProof(core);
  if (proof.verified === false) {
    return {
      worker_id: workerId, run_id: w.run_id, pid: w.pid, killed: false, row: w,
      reason: `refused: the run's owner would not vouch for this process as the operator (${proof.via}); nothing was signalled`,
      established_by: proof.via,
    };
  }

  // Exactly src/run/stop.cjs's killWorkerRow sequence, through src/core/process.cjs (build step 6b
  // design item 1) rather than src/run/process.cjs, so this file never imports src/run. build step 6c
  // item 8: t0 is before killTree, so a kill the tree kill itself ended reads its true time.
  const t0 = Date.now();
  const aliveBeforeSignal = pidAlive(w.pid); // before the kill: the identity check itself takes about a second
  // ADR 0039: the row's pid_created is the identity; a pid held by a different process is refused, not killed.
  // The kill lock, as at every other kill site (ADR 0039 review): one kill per CLI process today, so it orders nothing yet, but a
  // second kill site in this process can never interleave with this one.
  const kp = await P.withKillLock(() => P.killProcess(P.rowTarget(w))).catch((e) => ({ tree: { ok: false, terminated: 0, ms: 0, error: e && e.message }, pidKill: { signalled: false, error: 'EIDENTITY' }, identity: null, refused: { refused: 'identity', detail: e && e.message } }));
  const { tree, pidKill } = kp;
  const goneAfterKill = await P.waitPidGone(w.pid, { timeoutMs: KILL_WAIT_MS });
  const ms_to_dead = goneAfterKill === null ? null : Date.now() - t0;
  // build step 6c item 8: killed: true only when this command's own signal found the process alive.
  // the snapshot tree kill (ADR 0039) is what actually ends it on the normal path, leaving killPid's own
  // ESRCH as the ordinary aftermath of a tree kill that worked, not evidence of an already-dead pid
  // (measured: terminated > 0 and ESRCH together on every successful kill this host produced) —
  // "already gone" is the tree kill finding nothing at all, confirmed right before the signal too.
  const alreadyGone = tree.terminated === 0 && (pidKill.error === 'ESRCH' || !aliveBeforeSignal);

  const rowWaitMs = terminalRowWaitMs(w);
  const waited = await waitForTerminalRow(core, workerId, rowWaitMs);
  const rowAfter = waited.row || w;
  const landed = rowAfter.state === 'stopped' || rowAfter.state === 'dead';
  const establishedBy = landed
    ? `the adapter's detector wrote seq ${rowAfter.seq} ${rowAfter.state} (${rowAfter.death_established_by}) within ${waited.ms} ms`
    : `no terminal row landed within ${rowWaitMs.toLocaleString('en-US')} ms; the row stands as seq ${rowAfter.seq} ${rowAfter.state}; the next run.attach supersedes it`;
  // Blocking finding, fix round: a fresh pidAlive after the wait (brief design item 3), never the
  // row's own pid_alive, which falls back to the pre-kill row when every worker.get inside the wait
  // fails. Same formula as src/run/stop.cjs:33, reusing `goneAfterKill` already in hand above.
  const pidAliveAfter = goneAfterKill === null ? pidAlive(w.pid) : false;

  const receipt = {
    worker_id: workerId, run_id: w.run_id, pid: w.pid, pid_alive_before: true, killed: true,
    tree: { ok: tree.ok, terminated: tree.terminated, ms: tree.ms },
    pid_kill: { signalled: pidKill.signalled, error: pidKill.error },
    ms_to_dead, pid_alive_after: pidAliveAfter,
    row_after: rowAfter, row_after_waited_ms: waited.ms, row_after_established_by: establishedBy,
  };
  receipt.identity = kp.identity;
  if (kp.refused && aliveBeforeSignal) {
    receipt.killed = false;
    receipt.refused = kp.refused.refused;
    receipt.detail = kp.refused.detail;
    receipt.kind = kp.refused.kind || null;
    if (kp.refused.manual) receipt.manual = kp.refused.manual;
    receipt.reason = `refused: pid ${w.pid} could not be shown to be this worker's process (${kp.refused.detail}); nothing was killed${kp.refused.manual ? `. ${kp.refused.manual}` : ''}`;
  } else if (alreadyGone) {
    receipt.killed = false;
    receipt.already_gone = true;
    receipt.reason = `pid ${w.pid} exited on its own between the read and the signal; nothing this command did ended it`;
  } else if (pidAliveAfter) {
    receipt.killed = false;
    receipt.reason = `pid ${w.pid} is still alive after the kill and a ${KILL_WAIT_MS_TEXT} ms wait`;
  }
  return receipt;
}

function dirSize(dir) {
  let total = 0, entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch { /* raced away */ } }
  }
  return total;
}

async function runRm(core, dataDir, workerId) {
  let result;
  try {
    result = await core.worker.forget({ worker_id: workerId });
  } catch (e) {
    if (e.code === 'E_WORKER_LIVE') {
      return {
        worker_id: workerId, forgotten: false,
        reason: `${e.detail.state} with pid ${e.detail.pid} alive; kill it first`,
        error: { code: e.code, message: e.message, detail: e.detail },
      };
    }
    return {
      worker_id: workerId, forgotten: false, reason: e.message,
      error: { code: e.code || 'E_INTERNAL', message: e.message, detail: e.detail },
    };
  }
  // build step 6b design item 3: the core does not stat workers/<id> — this is the CLI's own read.
  const workerDir = fwd(path.join(dataDir, 'workers', workerId));
  let onDisk;
  try {
    if (!isPathId(workerId)) throw new Error('not a valid id'); // an older row's odd id is never joined into a path
    fs.statSync(workerDir);
    onDisk = { path: workerDir, exists: true, bytes: dirSize(workerDir) };
  } catch {
    onDisk = { path: workerDir, exists: false, bytes: null };
  }
  const establishedBy = core.isOwner()
    ? 'worker.forget in-process, having elected the store owner for this command'
    : 'worker.forget over the owner pipe';
  return {
    ...result, forgotten: true, established_by: establishedBy,
    left: { ...result.left, on_disk: onDisk },
  };
}

// build step 6c, design item 5: stop/restart flag parsing. `sub` is 'stop' or 'restart'; `rest` is
// ctx.argv after the subcommand. Returns { error } or { workerId, kill, timeoutMs, firstTurnTimeoutMs }.
function parseStopRestartArgs(sub, rest) {
  const out = { kill: false, timeoutMs: 10000, firstTurnTimeoutMs: 180000 };
  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (sub === 'stop' && a === '--kill') { out.kill = true; continue; }
    if (sub === 'stop' && a === '--timeout-ms') {
      const v = rest[i + 1];
      if (v === undefined || !/^\d+$/.test(v) || Number(v) <= 0) {
        return { error: `--timeout-ms needs a positive integer, got ${v === undefined ? '(missing)' : v}` };
      }
      out.timeoutMs = Number(v); i += 1; continue;
    }
    if (sub === 'restart' && a === '--first-turn-timeout-ms') {
      const v = rest[i + 1];
      if (v === undefined || !/^\d+$/.test(v) || Number(v) <= 0) {
        return { error: `--first-turn-timeout-ms needs a positive integer, got ${v === undefined ? '(missing)' : v}` };
      }
      out.firstTurnTimeoutMs = Number(v); i += 1; continue;
    }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    positionals.push(a);
  }
  if (positionals.length !== 1) {
    return { error: `belay worker ${sub} needs exactly one argument, a worker id; got ${positionals.length}` };
  }
  out.workerId = positionals[0];
  return out;
}

function renderStopText(receipt) {
  if (!receipt.stopped) return `belay worker stop: ${receipt.reason}\n`;
  const exitVal = receipt.exit_code != null ? receipt.exit_code : receipt.exit_signal;
  const how = receipt.killed ? 'killed' : (receipt.graceful ? 'graceful' : 'already gone');
  return `worker ${receipt.worker_id} pid ${receipt.pid}: stopped, exit ${exitVal} after ${receipt.ms_to_exit} ms, ${how}; session ${receipt.session_id || 'none'} (${receipt.established_by})\n`;
}

function renderRestartText(receipt) {
  if (!receipt.restarted) return `belay worker restart: ${receipt.reason}\n`;
  const usage = receipt.first_turn_timed_out
    ? 'timed out'
    : receipt.first_turn_usage ? `${receipt.first_turn_usage.output_tokens} out` : 'no usage';
  return `worker ${receipt.worker_id}: restarted, ${receipt.branch} (${receipt.reason}); pid ${receipt.old_pid} -> ${receipt.new_pid}; session ${receipt.session_id || 'none'}; first turn ${usage} (${receipt.established_by})\n`;
}

// build step 6c, design item 5, ADR 0019 decisions 2-5 and amendment 1: `stop` and `restart` reach the
// worker adapter's own pipe through adapter-pipe.cjs's ladder; the CLI itself never elects and never
// writes (worker.get and run.list, the ladder's first two rungs, are reads).
async function runStopOrRestart(ctx, sub, parsed) {
  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);
  const key = sub === 'stop' ? 'stopped' : 'restarted';
  const render = sub === 'stop' ? renderStopText : renderRestartText;

  if (!fs.existsSync(dataDir)) {
    const receipt = { worker_id: parsed.workerId, [key]: false, reason: `no such data dir: ${dataDir}`, error: null, ladder: [], last: null };
    return { code: 1, text: render(receipt), json: receipt };
  }

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    const caller = { role: 'operator', run_id: 'cli', pid: process.pid };
    const method = sub === 'stop' ? 'worker.stop' : 'worker.restart';
    const params = sub === 'stop'
      ? { worker_id: parsed.workerId, mode: parsed.kill ? 'kill' : 'graceful', timeout_ms: parsed.timeoutMs, caller }
      : { worker_id: parsed.workerId, first_turn_timeout_ms: parsed.firstTurnTimeoutMs, caller };
    const boundMs = sub === 'stop' ? stopBoundMs(parsed.timeoutMs) : restartBoundMs(parsed.firstTurnTimeoutMs);

    const { success, ...rest } = await callWorkerAdapter(core, dataDir, { workerId: parsed.workerId, method, params, boundMs });
    const receipt = { ...rest, [key]: success };
    return { code: success ? 0 : 1, text: render(receipt), json: receipt };
  } finally {
    // Never elects on this path (worker.get and run.list are reads), kept for symmetry with kill/rm.
    if (core.isOwner()) { try { await require('./release-owner.cjs').releaseOwnerOf(core); } catch { /* best effort */ } }
    await core.close();
  }
}

async function runKillOrRm(ctx, sub, workerId) {
  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  // Mode C for kill, mode W for rm: neither ever creates the data dir. cmd-stop.cjs's own rule.
  if (!fs.existsSync(dataDir)) {
    if (sub === 'kill') {
      const receipt = {
        worker_id: workerId, run_id: null, killed: false, row: null,
        reason: `no such data dir: ${dataDir}`, established_by: 'the data dir was stat-ed',
      };
      return { code: 1, text: renderKillText(receipt), json: receipt };
    }
    const receipt = {
      worker_id: workerId, forgotten: false, reason: `no such data dir: ${dataDir}`,
      error: { code: 'E_NOT_FOUND', message: `no such data dir: ${dataDir}` },
    };
    return { code: 1, text: renderRmText(receipt), json: receipt };
  }

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    const receipt = sub === 'kill' ? await runKill(core, workerId) : await runRm(core, dataDir, workerId);
    const ok = sub === 'kill' ? receipt.killed : receipt.forgotten;
    const text = sub === 'kill' ? renderKillText(receipt) : renderRmText(receipt);
    return { code: ok ? 0 : 1, text, json: receipt };
  } finally {
    // build step 6b, ADR 0019 decision 6: rm is mode W — with no owner alive this command's own
    // election won the lock, and its owner is shut down here so no owner.lock and no node process
    // outlives the command; kill never elects, so this is a no-op on that path.
    if (core.isOwner()) { try { await require('./release-owner.cjs').releaseOwnerOf(core); } catch { /* best effort */ } }
    await core.close();
  }
}

async function run(ctx) {
  const sub = ctx.argv[0];
  if (!['kill', 'rm', 'stop', 'restart'].includes(sub)) {
    return usageError(sub === undefined
      ? 'needs a subcommand: kill, rm, stop or restart'
      : `unknown subcommand ${sub}; this command has kill, rm, stop and restart`);
  }
  const rest = ctx.argv.slice(1);

  if (sub === 'kill' || sub === 'rm') {
    if (rest.length !== 1) return usageError(`belay worker ${sub} needs exactly one argument, a worker id; got ${rest.length}`);
    const workerId = rest[0];
    if (typeof workerId === 'string' && workerId.startsWith('-')) return usageError(`unknown option ${workerId}`);
    return runKillOrRm(ctx, sub, workerId);
  }

  const parsed = parseStopRestartArgs(sub, rest);
  if (parsed.error) return usageError(parsed.error);
  return runStopOrRestart(ctx, sub, parsed);
}

module.exports = { run };
