'use strict';
// cmd-pause.cjs — build step 6e-4, design item 6, ADR 0023
// amendment 2, extended by build step 6f (ADR 0023 amendment 3 decision 6) with the run form.
// `belay pause <id>` and `belay resume <id> [--message <text>]` first try `worker.get`; on E_NOT_FOUND
// they read `run.list` and, if a run row has that id, take the run form through `core.control`.
// Both mode C, `ctx.command` picking the verb (the shape of cmd-message.cjs). run(ctx) ->
// { code, text, json }, never printing, never exiting.

const fs = require('fs');
const C = require('./config.cjs');
const { openCore } = require('../core/index.cjs');
const { callWorkerAdapter, pauseBoundMs, resumeBoundMs } = require('./adapter-pipe.cjs');
const { RESUME_WARM_MS, RESUME_MARGIN_MS } = require('./embedder-bounds.cjs');

const DEFAULT_INTERRUPT_TIMEOUT_MS = 5000; // the manager's own default (src/run/pause.cjs), unexposed here
const DEFAULT_EXIT_TIMEOUT_MS = 10000;

// build step 6f design item 7: the run form's own bound, computed from `n`, the run's live workers
// read from `worker.list` before the call.
function runPauseBoundMs(n) { return 5000 + 2 * n * pauseBoundMs() + 30000 + 5000; }
function runResumeBoundMs(n) { return 2 * n * resumeBoundMs() + 30000 + 5000; }

function usageError(command, message) {
  const usage = command === 'pause'
    ? 'usage: belay pause <worker-id|run-id> [--data <dir>] [--json]\n'
    : 'usage: belay resume <worker-id|run-id> [--message <text>] [--data <dir>] [--json]\n';
  return { code: 2, text: `belay ${command}: ${message}\n\n${usage}`, json: { error: message } };
}

function parseArgs(command, argv) {
  const positionals = [];
  let message = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--message') {
      if (command === 'pause') return { error: '--message is not an option of belay pause' };
      const v = argv[i + 1];
      if (v === undefined) return { error: '--message needs a value' };
      message = v;
      i += 1;
      continue;
    }
    if (typeof a === 'string' && a.startsWith('-')) return { error: `unknown option ${a}` };
    positionals.push(a);
  }
  if (positionals.length !== 1) return { error: `belay ${command} needs exactly one argument, a worker or run id; got ${positionals.length}` };
  return { id: positionals[0], message };
}

function bgText(tasks) {
  if (!tasks || !tasks.length) return 'no background tasks';
  return `${tasks.length} background task(s) stopped (${tasks.map((t) => `${t.task_id} ${t.status_after}`).join(', ')})`;
}

function renderPauseText(receipt) {
  if (!receipt.paused) return `belay pause: ${receipt.reason}\n`;
  if (receipt.already) {
    const at = new Date(receipt.paused_at).toISOString();
    return `worker ${receipt.worker_id} already paused by ${receipt.paused_by} at ${at}; session ${receipt.session_id}\n`;
  }
  const cache = receipt.cache_deadline ? new Date(receipt.cache_deadline.at).toISOString() : 'unknown';
  const killedPart = receipt.descendants && receipt.descendants.killed_after_exit.length
    ? `; killed ${receipt.descendants.killed_after_exit.length} surviving descendant(s)` : '';
  return `worker ${receipt.worker_id} parked: ${receipt.interrupted ? 'interrupted a running turn' : 'no turn was running'}; `
    + `${bgText(receipt.background_tasks)}; process exited in ${receipt.exit.ms_after_close} ms (${receipt.exit.graceful ? 'graceful' : 'killed'})`
    + `${killedPart}; session ${receipt.session_id} kept; cache deadline ${cache} (not enforced) (${receipt.established_by})\n`;
}

function renderResumeText(receipt) {
  if (!receipt.resumed) return `belay resume: ${receipt.reason}\n`;
  return `worker ${receipt.worker_id} resumed on its ${receipt.branch} branch after ${receipt.paused_for_ms} ms: `
    + `new pid ${receipt.new_pid}, session ${receipt.session_id}; sent ${receipt.text_bytes} bytes (${receipt.established_by})\n`;
}

// build step 6f design item 7: one line per fact — the interrupt, each worker, not_paused,
// already_parked, the timeout.
function renderRunPauseText(receipt) {
  if (!receipt.paused) return `belay pause: ${receipt.reason}\n`;
  if (receipt.already) return `run ${receipt.run_id} already paused by ${receipt.run.paused_by} at ${new Date(receipt.run.paused_at).toISOString()}\n`;
  const lines = [`run ${receipt.run_id} paused`];
  const i = receipt.interrupt;
  lines.push(i ? `orchestrator interrupt: sent ${i.sent}, ${i.response_subtype || 'no response'} in ${i.response_ms == null ? 'n/a' : i.response_ms + ' ms'}, turn_ended ${i.turn_ended}` : 'orchestrator interrupt: none');
  for (const w of receipt.workers || []) lines.push(`worker ${w.worker_id}: parked`);
  for (const w of receipt.not_paused || []) lines.push(`worker ${w.worker_id}: not paused (${w.error && w.error.code}: ${w.error && w.error.message})`);
  for (const id of receipt.already_parked || []) lines.push(`worker ${id}: already parked`);
  lines.push(receipt.timeout ? `timeout: ${receipt.timeout.remaining_ms} ms remained, clock stopped` : 'timeout: none');
  lines.push('');
  return lines.join('\n');
}

function renderRunResumeText(receipt) {
  if (!receipt.resumed) return `belay resume: ${receipt.reason}\n`;
  const lines = [`run ${receipt.run_id} resumed after ${receipt.span_ms} ms`];
  for (const w of receipt.workers_resumed || []) lines.push(`worker ${w.worker_id}: resumed`);
  for (const w of receipt.left_parked || []) {
    // item 1 (ADR 0023 amendment 4 decision 3): two more reasons in their own words, alongside the two
    // 6i already rendered (kept verbatim: tests/cli/run-pause-3.test.cjs's (h3)/(h4) assert their text).
    const why = w.already_parked ? ' (already parked before this pause)'
      : w.re_paused ? ' (paused again, by another identity, after this pause began)'
      : w.not_this_pause ? ' (paused, but not by this pause)'
      : w.park_unconfirmed ? ` (this pause's park was not confirmed; try belay resume ${w.worker_id})`
      : w.error ? ` (${w.error.code}: ${w.error.message})` : '';
    lines.push(`worker ${w.worker_id}: left parked${why}`);
  }
  lines.push(`held wakes delivered: ${(receipt.held_wakes || []).length}`);
  lines.push(receipt.timeout ? `timeout: re-armed for ${receipt.timeout.armed_ms} ms` : 'timeout: none');
  lines.push('');
  return lines.join('\n');
}

// item 1 (ADR 0023 amendment 4 decision 3): a park_unconfirmed entry exits 1 as an error entry does —
// exported so tests/cli/run-pause-4.test.cjs's (h10) can assert it without a real run process.
function resumeHadErrors(result) {
  return Array.isArray(result.left_parked) && result.left_parked.some((w) => w.park_unconfirmed || (w.error && !w.already_parked));
}

async function workerForm(core, dataDir, command, id, msgText) {
  const key = command === 'pause' ? 'paused' : 'resumed';
  const render = command === 'pause' ? renderPauseText : renderResumeText;
  const caller = { role: 'operator', run_id: 'cli', pid: process.pid };
  let result;
  if (command === 'pause') {
    result = await callWorkerAdapter(core, dataDir, {
      workerId: id, method: 'worker.pause', params: { worker_id: id, caller },
      boundMs: pauseBoundMs(DEFAULT_INTERRUPT_TIMEOUT_MS, DEFAULT_EXIT_TIMEOUT_MS),
    });
  } else {
    const params = { worker_id: id, caller };
    if (msgText != null) params.message = msgText;
    result = await callWorkerAdapter(core, dataDir, { workerId: id, method: 'worker.resume', params, boundMs: resumeBoundMs() });
  }
  const { success, ...rest } = result;
  const receipt = { ...rest, [key]: success };
  return { code: success ? 0 : 1, text: render(receipt), json: receipt };
}

// build step 6f design item 7: `belay pause <run-id>`/`belay resume <run-id>` over the owner's pipe.
async function runForm(core, command, run, msgText) {
  if (command === 'resume' && msgText != null) return usageError('resume', '--message is not an option of a run resume (ADR 0023 amendment 3 decision 6)');
  if (run.ended_at != null) {
    const receipt = { run_id: run.id, [command === 'pause' ? 'paused' : 'resumed']: false, reason: `run ${run.id} has already ended (ended_at ${run.ended_at}, ${run.exit_reason})`, ended_at: run.ended_at };
    return { code: 1, text: (command === 'pause' ? renderRunPauseText : renderRunResumeText)(receipt), json: receipt };
  }
  const { workers } = await core.worker.list({});
  // design item 9 (adapter-pipe.cjs's own bound formula, cmd-pause.cjs:129): `n` is the workers the call
  // would actually act on — live ones to park for a pause, already-parked ones a resume might relaunch —
  // never the other verb's own count.
  const nLive = workers.filter((w) => w.run_id === run.id && (w.state === 'starting' || w.state === 'running') && w.pid_alive === true).length;
  const nParked = workers.filter((w) => w.run_id === run.id && w.state === 'paused').length;
  const n = command === 'pause' ? nLive : nParked;
  const method = command === 'pause' ? 'run.pause' : 'run.resume';
  // ADR 0034: resuming an embedder-failure pause first re-loads the model in the run's owner, which can take up to
  // RESUME_WARM_MS; without it the CLI would report a failure for a resume that went on to take effect.
  const embedderPause = command === 'resume' && /embedder-failure [(]/.test(run.paused_by || '');
  const boundMs = command === 'pause' ? runPauseBoundMs(n) : runResumeBoundMs(n) + (embedderPause ? RESUME_WARM_MS + RESUME_MARGIN_MS : 0);
  const render = command === 'pause' ? renderRunPauseText : renderRunResumeText;
  const key = command === 'pause' ? 'paused' : 'resumed';
  try {
    const result = await core.control(method, { run_id: run.id }, { timeoutMs: boundMs });
    const receipt = { run_id: run.id, [key]: true, ...result };
    // design item 9: exits 1 when the orchestrator was mid-turn and its interrupt was not confirmed, as
    // the worker form does, and when a run resume left a worker parked on an actual error (not merely
    // already_parked before this pause) — a resume that did not fully succeed is not a clean 0.
    const interruptUnconfirmed = command === 'pause' && result.interrupt
      && result.interrupt.turn_was_running === true && result.interrupt.turn_ended !== true;
    const resumeFailed = command === 'resume' && resumeHadErrors(result);
    return { code: interruptUnconfirmed || resumeFailed ? 1 : 0, text: render(receipt), json: receipt };
  } catch (e) {
    const reason = e.code === 'E_NOT_FOUND' && e.detail && e.detail.controls
      ? `a run pause exists only for a headless run or an interactive run (ADR 0023 amendment 5); its workers can be paused one by one (this owner is not a belay run process)`
      : e.message;
    const receipt = { run_id: run.id, [key]: false, reason, error: { code: e.code, message: e.message, detail: e.detail } };
    return { code: 1, text: render(receipt), json: receipt };
  }
}

async function run(ctx) {
  const command = ctx.command; // 'pause' or 'resume', per belay.cjs's COMMANDS table
  const parsed = parseArgs(command, ctx.argv);
  if (parsed.error) return usageError(command, parsed.error);
  const { id, message: msgText } = parsed;
  const key = command === 'pause' ? 'paused' : 'resumed';
  const renderWorker = command === 'pause' ? renderPauseText : renderResumeText;

  const found = C.discover(ctx.cwd);
  const dataDir = C.dataDirOf(found, ctx);

  // Mode C: never creates the data dir.
  if (!fs.existsSync(dataDir)) {
    const receipt = { worker_id: id, [key]: false, reason: `no such data dir: ${dataDir}`, error: null, ladder: [], last: null };
    return { code: 1, text: renderWorker(receipt), json: receipt };
  }

  const core = await openCore({ dataDir, caller: { role: 'operator', run_id: 'cli', pid: process.pid } });
  try {
    // Try the worker form first (rung 1 of its own ladder is worker.get). Only a rung-1 failure —
    // the id names no worker at all, or its row is forgotten — is worth trying the run form for;
    // any deeper failure (a dead adapter, E_BUSY, …) really is about a worker and is returned as-is.
    const wr = await workerForm(core, dataDir, command, id, msgText);
    if (wr.json[key] === true) return wr;
    if (!Array.isArray(wr.json.ladder) || wr.json.ladder.length !== 1) return wr;

    let runRow = null;
    try {
      const { runs } = await core.run.list();
      runRow = runs.find((r) => r.id === id) || null;
    } catch { /* the run read itself failed; fall through to the worker's own refusal below */ }
    if (runRow) return await runForm(core, command, runRow, msgText);

    // Neither a worker nor a run: design item 7's "naming both reads", built on the worker form's own
    // natural refusal (which already names the worker read) rather than a shape of its own.
    wr.json.reason = `${wr.json.reason}; and no run has id ${id} either`;
    wr.text = renderWorker(wr.json);
    return wr;
  } finally {
    if (core.isOwner()) { try { await core.shutdownOwner(); } catch { /* best effort */ } }
    await core.close();
  }
}

// build step 6i fix round (should-fix, item 4): exported so tests/cli/run-pause-3.test.cjs's (h3)/(h4)
// can assert the rendered line, not only the receipt's own fields, for a wording a planted revert could
// otherwise change unnoticed.
module.exports = { run, runPauseBoundMs, runResumeBoundMs, renderRunResumeText, resumeHadErrors };
