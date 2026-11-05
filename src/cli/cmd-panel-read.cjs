'use strict';
// cmd-panel-read.cjs — one batched read for the GUI panel. Mode R. The panel used to start one belay process per read
// (agents, notices, the awaiting list, the transcript, settings), twenty to thirty-five a minute for as long as it was open.
// This verb runs those same reads in one process and prints their answers together, in the shape the panel's snapshot builder
// already takes:
//
//   { v: 1, at: <ms>, run_id, parts: { agents, notices, awaiting, transcript, settings } }
//
// where each part is null (not read this round), { json } (the read's own answer) or { error, timedOut? }. A part that fails
// does not hide the others, and a part that times out ends the round: the rest are not started, and the caller keeps what it
// had for them. The reads are the commands' own run(ctx), called one after another, never at once. Each closes its own core, so
// no connection to the store is held between rounds. The verb writes nothing, starts nothing of its own, and imports the
// embedder nowhere: every module is required only when its part is read.
//
//   belay panel-read [run-id] [--dir <orchestrator dir>] [--tail <n>] [--fixed] [--prev-mode <mode>] [--prev-run <id>] [--settings]
//
//   --fixed       the panel is the interactive orchestrator's own window: its transcript is never read, and settings are read
//                 from the project root that holds the data dir
//   --prev-mode   the run mode the panel saw last round, used for the transcript only when the agents read fails
//   --settings    read settings too (the panel asks every ten seconds)
//   --prev-run    the run the panel saw last round, named to the later reads when the agents read fails

const SUB_TIMEOUT_MS = 6000; // each part; the panel's own bound on this process is longer (index.tsx)
const ROUND_DEADLINE_MS = 20000; // the whole round, under the panel's 25 s bound: the parts done by then are returned and the rest stay null
const USAGE = 'usage: belay panel-read [run-id] [--dir <dir>] [--tail <n>] [--fixed] [--prev-mode <mode>] [--prev-run <id>] [--settings] [--data <dir>] [--json]\n';

const usageError = (message) => ({ code: 2, text: `belay panel-read: ${message}\n${USAGE}`, json: { error: message } });

function parseArgs(argv) {
  const out = { runId: null, dir: null, tail: null, fixed: false, prevMode: null, prevRun: null, settings: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { i += 1; return argv[i]; };
    if (a === '--dir') { out.dir = value(); if (!out.dir) return { error: '--dir needs a directory' }; }
    else if (a === '--tail') {
      const v = value();
      if (!/^[1-9][0-9]{0,3}$/.test(v || '') || Number(v) > 1000) return { error: '--tail needs a whole number from 1 to 1000' };
      out.tail = v;
    }
    else if (a === '--prev-mode') { out.prevMode = value(); if (!out.prevMode) return { error: '--prev-mode needs a value' }; }
    else if (a === '--prev-run') { out.prevRun = value(); if (!out.prevRun || out.prevRun.startsWith('-')) return { error: '--prev-run needs a run id' }; }
    else if (a === '--fixed') out.fixed = true;
    else if (a === '--settings') out.settings = true;
    else if (a.startsWith('-')) return { error: `unknown option ${a}` };
    else if (out.runId === null) out.runId = a;
    else return { error: 'too many arguments' };
  }
  return out;
}

// A data dir that ends in .belay sits in its project root; any other data dir is the root (the panel's projectRootOf).
const projectRootOf = (dataDir) => {
  const d = String(dataDir).split('\\').join('/').replace(/\/+$/, '');
  return /\/\.belay$/.test(d) ? d.slice(0, d.length - '/.belay'.length) || '/' : d;
};

const TIMED_OUT = 'E_TIMEOUT';
// The real bound: a read that outlives its time is abandoned (its promise is left to settle on its own), never joined.
function bound(promise, ms) {
  let timer;
  const clock = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: TIMED_OUT })), ms); timer.unref(); });
  return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
}

// One part from one read. exit 0 is { json }; any other exit is an error naming the read and its code; a thrown error is the same,
// and a timeout says so (the caller backs off on it).
async function part(label, read, d) {
  try {
    const r = await d.bound(Promise.resolve().then(read), d.timeoutMs);
    if (!r || r.code !== 0) {
      const said = r && r.json && r.json.error ? (typeof r.json.error === 'string' ? r.json.error : r.json.error.message) : '';
      return { error: `belay ${label} exit ${r ? r.code : '?'}${said ? `: ${String(said).slice(0, 100)}` : ''}` };
    }
    return { json: r.json };
  } catch (e) {
    if (e && e.code === TIMED_OUT) return { error: `belay ${label} timed out`, timedOut: true };
    return { error: `belay ${label} did not run: ${String((e && e.message) || e).slice(0, 100)}` };
  }
}

// How many held notes wait on the operator, from the notices read (the panel's rule: the newest notes_held event, capped by its count).
function awaitingOf(noticesJson) {
  let n = 0;
  for (const e of (noticesJson && Array.isArray(noticesJson.events) ? noticesJson.events : [])) {
    if (e && e.kind === 'notes_held') n = Math.min(Number(e.count) || 0, Number(e.awaiting_operator) || 0);
  }
  return n;
}

// The pure part. d = { opts (parseArgs' result), reads: { agents, notices, awaiting, transcript, settings } (each async (argv) => { code, json }),
// now() -> ms, bound(promise, ms), timeoutMs }. No store, no process, no clock of its own.
async function round(d) {
  const { opts, reads } = d;
  const parts = { agents: null, notices: null, awaiting: null, transcript: null, settings: null };
  const stop = (p) => !!(p && p.timedOut);
  const t0 = d.now();
  const deadlineMs = d.deadlineMs || ROUND_DEADLINE_MS;
  let cut = false; // the round's own deadline passed: what is done is returned, the rest stays null
  // Each read gets what is left of the round's time, never more than its own bound. The label is the command as typed, like the panel's own error line.
  const read = async (verb, argv, label = verb) => {
    const left = deadlineMs - (d.now() - t0);
    if (left <= 0) { cut = true; return null; }
    return part([label, ...argv].join(' '), () => reads[verb](argv), { ...d, timeoutMs: Math.min(d.timeoutMs, left) });
  };
  let runId = opts.runId || null;
  const done = () => ({ v: 1, at: d.now(), run_id: runId, ...(cut ? { partial: true } : {}), parts });
  const agents = parts.agents = await read('agents', [...(opts.runId ? [opts.runId] : []), ...(opts.dir ? ['--dir', opts.dir] : [])]);
  const seen = agents && agents.json ? agents.json : null;
  // A failed agents read does not lose the run: the notices and transcript reads name the run the panel saw last.
  runId = opts.runId || (seen && typeof seen.run_id === 'string' ? seen.run_id : null) || opts.prevRun || null;
  const runArg = runId ? [runId] : [];
  if (cut || stop(agents)) return done();
  const notices = parts.notices = await read('notices', runArg);
  if (cut || stop(notices)) return done();
  if (notices.json && awaitingOf(notices.json) > 0) {
    parts.awaiting = await read('awaiting', ['held', '--awaiting'], 'memory');
    if (cut || stop(parts.awaiting)) return done();
  }
  const mode = opts.fixed ? 'interactive' : seen ? seen.mode : opts.prevMode;
  if (mode === 'headless') {
    parts.transcript = await read('transcript', [...runArg, ...(opts.tail ? ['--tail', opts.tail] : [])]);
    if (cut || stop(parts.transcript)) return done();
  }
  if (opts.settings) parts.settings = await read('settings', []);
  return done();
}

function textOf(r) {
  const rows = Object.entries(r.parts).map(([k, p]) => `  ${k.padEnd(10)} ${p === null ? 'not read' : p.error ? `error: ${p.error}` : 'ok'}`);
  return `panel-read ${r.run_id || '(no run)'} at ${r.at}\n${rows.join('\n')}\n`;
}

// The commands as the dispatcher would run them: the same ctx, each module loaded only when its part is read.
function realReads(ctx, load = require) {
  const sub = (module, command, argv, over = {}) => load(module).run({ ...ctx, argv, literal: null, command, json: true, fix: false, emit: undefined, now: undefined, reads: undefined, bound: undefined, timeoutMs: undefined, deadlineMs: undefined, ...over });
  const root = ctx.dataDirGiven ? projectRootOf(ctx.dataDir) : ctx.cwd;
  return {
    agents: (argv) => sub('./cmd-agents.cjs', 'agents', argv),
    notices: (argv) => sub('./cmd-notices.cjs', 'notices', argv),
    awaiting: (argv) => sub('./cmd-memory.cjs', 'memory', argv),
    transcript: (argv) => sub('./cmd-transcript.cjs', 'transcript', argv),
    settings: (argv) => sub('./cmd-settings.cjs', 'settings', argv, ctx.argv.includes('--fixed') ? { cwd: root } : {}),
  };
}

async function run(ctx) {
  const opts = parseArgs(ctx.argv);
  if (opts.error) return usageError(opts.error);
  const out = await round({ opts, reads: ctx.reads || realReads(ctx), now: ctx.now || (() => Date.now()), bound: ctx.bound || bound, timeoutMs: ctx.timeoutMs || SUB_TIMEOUT_MS, deadlineMs: ctx.deadlineMs });
  return { code: 0, text: textOf(out), json: out };
}

module.exports = { run, round, realReads, parseArgs, awaitingOf, projectRootOf, SUB_TIMEOUT_MS };
