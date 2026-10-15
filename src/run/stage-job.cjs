'use strict';
// stage-job.cjs — what the run-close stages (the scrubber and the archive reviewer) share: one read-only child worker, spawned by
// the run manager (invariant 1) with Read, Glob and Grep, its answer read from its last message and its recorded cost checked against
// the cap. The child is stopped by the manager in a `finally` (by its exact pid, ADR 0039); on a fast close (`fast()` true) it is killed
// at once, before the caller goes on to run.end and the owner's shutdown. Nothing here writes the store but the receipts it is asked to;
// applying an answer is the core's (memory.scrubApply, memory.reviewApply).

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const BUILTINS = ['Read', 'Glob', 'Grep'];
const DIFF_MAX = 200 * 1024;
const FILE_CUT = 16 * 1024;
const GIT_BOUND_MS = 15000;
const FAST_POLL_MS = 100;
const KILL_BOUND_MS = 3000;
const FAST_SETTLE_MS = 300; // how long a fast close waits for a spawn to settle before its second kill
const OVERRUN_SHARE = 0.9; // a failed job that spent this much of its cap is an overrun: the budget flag stops a session at about the cap
const fwd = (p) => String(p).replace(/\\/g, '/');
const codeOf = (e) => (e && typeof e.code === 'string' && e.code.startsWith('E_') ? e.code : 'E_INTERNAL');
const coded = (code, message) => Object.assign(new Error(message), { code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readTemplate(name) {
  return fs.readFileSync(path.join(__dirname, 'prompts', name), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}
const fill = (tpl, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(String(v)), tpl);

// The child's answer: the JSON object in its last message, and the list under `key`. { list } or { error }.
function parseList(text, key) {
  const raw = String(text || '').trim();
  if (!raw) return { error: 'the job ended its turn with no text' };
  const tries = [raw];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fence) tries.push(fence[1]);
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a !== -1 && b > a) tries.push(raw.slice(a, b + 1));
  for (const t of tries) {
    let j;
    try { j = JSON.parse(t); } catch { continue; }
    if (j && Array.isArray(j[key])) return { list: j[key] };
  }
  return { error: `the job's final message holds no ${key} JSON` };
}

// The recorded cost is the binding check: a job that recorded none, or more than its cap, is not used.
function costError(cost, cap, what) {
  if (!(typeof cost === 'number' && cost > 0)) return coded('E_COST_CAP', `the ${what} recorded no cost, so its cap cannot be checked; its answer was not used`);
  if (cost > cap) return coded('E_COST_CAP', `the ${what} cost $${cost.toFixed(4)}, over its cap of $${cap}; its answer was not used`);
  return null;
}
// An overrun: the job spent its cap (or, failing for any reason, nearly all of it). Such a job is retried with half the items.
const overran = (cost, cap, failed) => typeof cost === 'number' && (cost > cap || (failed && cost >= cap * OVERRUN_SHARE));

// How many items the next attempt of a stage takes: the full count, or half of what the last attempt tried while the last thing the
// ledger says about the stage is an overrun, down to 1. A success (`successKind`, ok) ends the halving.
async function attemptLimit(core, stage, successKind, full) {
  let evs;
  try { evs = ((await core.memory.events({ kinds: ['stage_overrun', successKind] })) || {}).events || []; } catch { return full; }
  const mine = evs.filter((e) => (e.kind === 'stage_overrun' ? e.key === stage : e.ok === 1 || e.ok === true));
  const last = mine[mine.length - 1];
  if (!last || last.kind !== 'stage_overrun') return full;
  const tried = Array.isArray(last.row_ids) && last.row_ids.length ? last.row_ids.length : full;
  return Math.max(1, Math.min(full, Math.floor(tried / 2)));
}

const raceFast = (p, fast, tick = null) => {
  if (!fast && !tick) return p;
  let timer;
  const flagged = new Promise((res) => { timer = setInterval(() => { if (tick) tick(); if (fast && fast()) res('fast'); }, FAST_POLL_MS); });
  return Promise.race([p, flagged]).finally(() => clearInterval(timer));
};

// After a stop: is the child's pid still alive? Kill it again; if it still is, name it (in the result and on the `sink`, which the run keeps
// even when a fast close cuts the stage off). Returns the pid or null.
async function reportSurvivor(manager, workerId, kill, sink) {
  const rec = manager._worker(workerId);
  const P = require('./process.cjs');
  if (!(rec && rec.pid && P.pidAlive(rec.pid))) return null;
  await kill();
  if (!P.pidAlive(rec.pid)) return null;
  if (sink && Array.isArray(sink.survivors)) sink.survivors.push(rec.pid);
  return rec.pid;
}

// Spawn the child, wait for its turn, read its last text and cost, stop it. Resolves to { text, cost, error, survivor } and throws only
// for a spawn that never produced a worker or one a fast close cancelled. `manager` is a run manager (or a test double with spawn,
// wait, stop and _worker). `fast()` true: do not start, or kill the running child by its exact pid and fail E_ABORTED.
async function runChild({ manager, workerId, worktree, model, capUsd, wallMs, prompt, label, fast = null, sink = null }) {
  if (!manager || typeof manager.spawn !== 'function') throw coded('E_INTERNAL', `the run has no manager to spawn the ${label} with`);
  if (typeof manager._closed === 'function' && manager._closed()) throw coded('E_SHUTDOWN', `the run manager is shutting down, so the ${label} was not started`);
  if (fast && fast()) throw coded('E_ABORTED', `a fast close was requested, so the ${label} was not started`);
  const kill = () => Promise.resolve(manager.stop({ worker_id: workerId, mode: 'kill', timeout_ms: KILL_BOUND_MS })).catch(() => {});
  // The child's pid goes on the sink as soon as the manager has one (while spawn is still waiting for the ready event, too), so a stage cut off
  // by the close deadline can still find and kill it by that pid.
  const notePid = () => {
    const r = manager._worker && manager._worker(workerId);
    if (r && r.pid && sink && Array.isArray(sink.pids) && !sink.pids.some((p) => p.worker_id === workerId)) sink.pids.push({ worker_id: workerId, pid: r.pid });
  };
  const sp = Promise.resolve(manager.spawn({ substrate: 'claude-code', worktree, worker_id: workerId, model, allowed_tools: BUILTINS, tools: BUILTINS, max_budget_usd: capUsd, prompt })).then(() => null, (e) => ({ e }));
  notePid();
  const first = await raceFast(sp, fast, notePid);
  if (first === 'fast') { // kill at once (the record exists from the start of spawn), again if the spawn settles meanwhile, and name a survivor
    notePid(); // the pid may have arrived after the tick that saw the fast close: the close deadline's reaper reads the sink
    await kill();
    await Promise.race([sp, sleep(FAST_SETTLE_MS)]);
    notePid();
    await kill();
    await reportSurvivor(manager, workerId, kill, sink);
    throw coded('E_ABORTED', `a fast close was requested while the ${label} was starting; it was killed`); }
  notePid();
  if (first && first.e) throw first.e;
  let text = '', cost = null, error = null, survivor = null, aborted = false;
  try {
    const t0 = Date.now();
    let got, first = true;
    for (;;) { // a wait capped by MCP_TOOL_TIMEOUT (it says so) is asked again until the stage's own wall is spent
      got = await raceFast(manager.wait({ worker_ids: [workerId], timeout_ms: first ? wallMs : Math.max(1, wallMs - (Date.now() - t0)) }), fast, notePid); first = false;
      if (got === 'fast' || !(got.timed_out && got.timeout_capped && Date.now() - t0 < wallMs)) break;
    }
    const rec = manager._worker(workerId);
    if (got === 'fast') { aborted = true; error = coded('E_ABORTED', `a fast close was requested, so the ${label} was killed`); }
    else if (got.timed_out) error = coded('E_TIMEOUT', `the ${label} did not finish inside ${Math.round(wallMs / 1000)} s`);
    else if (got.event !== 'turn_end' || got.is_error) error = coded('E_WORKER_NOT_LIVE', `the ${label} ${got.event === 'turn_end' ? 'ended its turn in error' : `is ${got.event}`}`);
    text = rec && typeof rec.lastAssistantText === 'string' ? rec.lastAssistantText : '';
    cost = rec && typeof rec.costUsd === 'number' ? rec.costUsd : null;
  } finally {
    if (aborted) await kill(); else await Promise.resolve(manager.stop({ worker_id: workerId })).catch(() => {});
    survivor = await reportSurvivor(manager, workerId, kill, sink); // the child must be gone before run.end
  }
  return { text, cost, error, survivor };
}

function git(worktree, args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', worktree, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: GIT_BOUND_MS, windowsHide: true, encoding: 'utf8', ...opts }, (e, out) => resolve(e ? { error: e.killed ? 'git timed out' : 'git failed' } : { text: out }));
  });
}
async function diffText(worktree, base, head) {
  const d = await git(worktree, ['diff', '--no-color', base, head]);
  if (d.error) return `(${d.error} for ${String(base).slice(0, 12)}..${String(head).slice(0, 12)})\n`;
  return d.text.length > DIFF_MAX ? `${d.text.slice(0, DIFF_MAX)}\n(diff cut at ${DIFF_MAX} bytes)\n` : d.text || '(no change)\n';
}
// A file as it was at a commit, cut; or a sentence saying why it could not be read.
async function fileAt(worktree, sha, rel) {
  const r = await git(worktree, ['show', `${sha}:${rel}`]);
  if (r.error) return `(${rel} could not be read at ${String(sha).slice(0, 12)}: ${r.error})\n`;
  return r.text.length > FILE_CUT ? `${r.text.slice(0, FILE_CUT)}\n(file cut at ${FILE_CUT} bytes)\n` : r.text;
}

function writeFileIn(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true });
  const file = fwd(path.join(dir, name));
  fs.writeFileSync(file, text);
  return file;
}

// A receipt row; never throws.
async function receipt(core, fields) {
  try { return await core.memory.recordEvent(fields); } catch { return null; }
}
const failFields = (e) => ({ ok: false, code: codeOf(e), message: String((e && e.message) || e).slice(0, 300) });

module.exports = { BUILTINS, runChild, parseList, costError, overran, attemptLimit, readTemplate, fill, diffText, fileAt, writeFileIn, receipt, failFields, fwd, codeOf, coded, git };
