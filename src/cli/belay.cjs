#!/usr/bin/env node
// belay.cjs — the CLI dispatcher. The human's window and hand (ADR 0009 §6); the orchestrator drives
// belay over MCP, not through this.
//
// This file is the shared manifest of CLI slice 3a and is owned by the integration owner alone. No
// command author edits it: each owns exactly one `cmd-*.cjs` and nothing else (CLAUDE.md, concurrency
// and authority). It is committed as a stub before the context experiment runs so that neither arm has
// to coordinate an edit to a shared file.
//
// Exit codes, lifted from prototypes/cli/harness.cjs: 0 ok, 2 usage error, 1 runtime error.
//
// Budgets it must not break (ADR 0005 §5, invariant 9):
//   --help and any usage error   < 500 ms over the host floor (ADR 0035; was 100 ms), zero processes spawned, zero files created
//   cold start to first output   < 300 ms
// Both are structural here rather than aspirational: the help text is a static string in this file,
// and a command module is `require`d only once its name has been matched. Nothing on the help path
// reaches src/core, and therefore nothing reaches the embedder (13.5 s cold, 664 ms warm).
'use strict';

const path = require('node:path');

const VERSION = '0.2.0';

// The slice-3a surface. `mode` is the connection mode each command declares, exactly one, per
// command table §1: R read-only, W store client, C run control. The remaining 18 commands of
// command table §3 arrive in later slices and are deliberately absent rather than stubbed.
const COMMANDS = {
  help:   { mode: 'R', module: null,               summary: 'print this usage and exit' },
  config: { mode: 'R', module: './cmd-config.cjs', summary: 'print which config file is read, and effective values' },
  init:   { mode: 'W', module: './cmd-init.cjs',   summary: 'write the config file and create the data dir' },
  doctor: { mode: 'R', module: './cmd-doctor.cjs', summary: 'check config, store and substrate binaries; read-only unless --fix' },
  mcp:    { mode: 'R', module: './cmd-mcp.cjs',    summary: 'mcp status: catalogued, registered, configured, reachable, healthy, separately' },
  run:    { mode: 'W', module: './cmd-run.cjs',    summary: 'spawn the headless orchestrator and hold its stdin; the store owner for the run' },
  stop:   { mode: 'C', module: './cmd-stop.cjs',   summary: "stop a live run: close the orchestrator's stdin, wait, kill by exact pid, then report and reap its workers" },
  status: { mode: 'R', module: './cmd-status.cjs', summary: 'the truth ladder for a run: six rungs, each naming what established it' },
  workers: { mode: 'R', module: './cmd-workers.cjs', summary: 'list a run\'s worker rows, derived liveness and the two harness-derived columns' },
  tasks:   { mode: 'R', module: './cmd-tasks.cjs',   summary: 'list a run\'s task rows: state, lease, holder liveness, checkpoint, dependencies' },
  receipts: { mode: 'R', module: './cmd-receipts.cjs', summary: "per-agent receipts for a run: model, turns, tokens, cost, tool calls, wall clock, checks, handoff" },
  transcript: { mode: 'R', module: './cmd-transcript.cjs', summary: "the orchestrator's stream.jsonl as panel entries: its text, one line per tool call, turn ends; -f follows, bounded" },
  notices: { mode: 'R', module: './cmd-notices.cjs', summary: "a run's events from store rows: pending requests, dead or stopped workers, stalls, review verdicts, pause and end" },
  agents:  { mode: 'R', module: './cmd-agents.cjs',  summary: "the orchestrator and each worker: role, model, effort, state, context size, cost; the run cost meter" },
  'wake-stream': { mode: 'R', module: './cmd-wake-stream.cjs', summary: "wake-stream --run <id> --nonce <n>: print the interactive run's wake lines from its harness-owned pipe; exits on close or after 15 s of silence" },
  memory:  { mode: 'R', module: './cmd-memory.cjs',  summary: 'memory search|list|show|timeline|verify|stats|export|import|embed|proposals|restore|archive purge: reads answer from the store or its copy; semantic and hybrid search need a live owner; verify, import, embed, restore and purge elect one (embed --dry-run only reads)' },
  usage:   { mode: 'R', module: './cmd-usage.cjs',   summary: 'usage [run-id] [--by task|worker|model|turn]: tokens and dollars per turn from the usage ledger; a turn with no dollars is not zero' },
  briefing: { mode: 'R', module: './cmd-briefing.cjs', summary: 'the resume line and orientation document for a worker or a task' },
  logs:    { mode: 'R', module: './cmd-logs.cjs',    summary: "a worker's stream.jsonl: path, byte offset, then the tail; -f follows, bounded" },
  diff:    { mode: 'R', module: './cmd-diff.cjs',    summary: 'rows added, updated, superseded or expired since a mark' },
  'take-control': { mode: 'C', module: './cmd-take-control.cjs', summary: "move a task's lease to the operator over the run pipe, then pause the worker that held it over its adapter's pipe" },
  task:    { mode: 'C', module: './cmd-task.cjs',    summary: 'task assign <task-id> <worker-id>: assign an open task to a live worker over the run pipe' },
  worker:  { mode: 'C', module: './cmd-worker.cjs',  summary: 'worker kill|rm|stop|restart <worker-id>: kill by the exact spawned pid, forget a dead worker\'s rows, or stop and restart over the adapter\'s pipe' },
  message: { mode: 'C', module: './cmd-message.cjs', summary: "message <worker-id> <text>: write a turn to a worker's stdin over the adapter's pipe (Codex: a resume process)" },
  pending: { mode: 'R', module: './cmd-pending.cjs', summary: 'list tool calls waiting on a verdict: id, worker, tool, input digest, age, whether the requesting adapter is alive' },
  approve: { mode: 'C', module: './cmd-decide.cjs', summary: 'approve <request-id>: allow one pending tool call over the owner pipe; the worker resumes at once' },
  deny:    { mode: 'C', module: './cmd-decide.cjs', summary: 'deny <request-id> [reason...]: refuse one pending tool call over the owner pipe; the worker is told the reason' },
  embedder: { mode: 'W', module: './cmd-embedder.cjs', summary: 'embedder fetch|verify [--model <id>]: fetch the embedding model into belay\'s cache (the only network use), or re-hash it against the table' },
  pause:   { mode: 'C', module: './cmd-pause.cjs', summary: "pause <worker-id|run-id>: park a worker over the adapter's pipe, or hold a run's wakes and park every live worker over the owner's pipe" },
  settings: { mode: 'W', module: './cmd-settings.cjs', summary: 'settings [<key> [<value>]]: the display settings, memory levers and per-agent defaults; with a value, writes the config file only' },
  resume:  { mode: 'C', module: './cmd-pause.cjs', summary: "resume <worker-id|run-id> [--message <text>]: relaunch a parked worker on its session, or resume a paused run and deliver its held wakes" },
};

// Static string: no module is loaded to produce it, which is what keeps the path's cost to a few ms above the host floor (budget: 500 ms, ADR 0035).
function usage() {
  const rows = Object.entries(COMMANDS)
    .map(([name, c]) => `  ${name.padEnd(8)} ${c.mode}  ${c.summary}`)
    .join('\n');
  return [
    `belay ${VERSION} — orchestration harness`,
    '',
    'usage: belay <command> [options]',
    '',
    'commands (mode: R read-only, W store client, C run control):',
    rows,
    '',
    'global options:',
    '  --json            print machine-readable JSON instead of a table',
    '  --data <dir>      data directory (default: <cwd>/.belay)',
    '  -h, --help        print this usage',
    '',
    'Every command declares exactly one mode. A read-only command starts no process and',
    'creates no file.',
    '',
  ].join('\n');
}

// A command module exports:
//   run(ctx) -> Promise<{ code, text, json }>
// where ctx = { argv, cwd, dataDir, json, fix, emit? }.
//   argv    the arguments after the command name, flags already stripped
//   cwd     absolute, forward slashes
//   dataDir absolute, forward slashes; defaults to <cwd>/.belay
//   dataDirGiven true only when --data was on the command line
//   json    true when --json was given; the dispatcher prints ctx.json ? result.json : result.text
//   fix     true when --fix was given (doctor only; every other command ignores it)
//   command the matched command name (build step 6d: cmd-decide.cjs serves both approve and deny and
//           tells them apart by this field)
//   emit    ctx.emit(text) writes text to stdout immediately; defined only when --json was not given,
//           so a module that must print as events arrive (belay logs -f) has a sink. A module that
//           both emits and returns `text` prints both — logs -f returns `text` as a closing summary
//           only, everything already streamed through emit.
// `code` is 0 ok, 1 runtime error, 2 usage error. A module never calls process.exit and never prints
// outside `emit`: returning the receipt is what lets the tests assert it (invariant 5, no success
// without effect).

const fwd = p => String(p).split('\\').join('/');

function parseGlobals(argv) {
  const rest = [];
  const out = { json: false, fix: false, dataDir: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--fix') { out.fix = true; continue; }
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a === '--data') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) return { error: '--data needs a directory' };
      out.dataDir = fwd(path.resolve(v));
      i += 1;
      continue;
    }
    rest.push(a);
  }
  out.argv = rest;
  return out;
}

async function main(argv) {
  const g = parseGlobals(argv);
  if (g.error) {
    process.stderr.write(`belay: ${g.error}\n\n${usage()}`);
    return 2;
  }

  const name = g.argv[0];

  // Help before anything else, so that `belay --help`, `belay help` and a bare `belay` all stay on
  // the static path and never load a command module.
  if (g.help || name === undefined || name === 'help') {
    process.stdout.write(usage());
    return 0;
  }

  const spec = COMMANDS[name];
  if (!spec) {
    process.stderr.write(`belay: unknown command ${name}\n\n${usage()}`);
    return 2;
  }

  const cwd = fwd(process.cwd());
  const ctx = {
    argv: g.argv.slice(1),
    cwd,
    dataDir: g.dataDir || `${cwd}/.belay`,
    dataDirGiven: !!g.dataDir,
    json: g.json,
    fix: g.fix,
    command: name,
  };
  // Defined only when --json is not given (the comment block above states the contract this serves).
  if (!ctx.json) ctx.emit = (text) => { process.stdout.write(text); };

  let result;
  try {
    // Lazy: the module is loaded only now, once its name has matched.
    const mod = require(spec.module);
    result = await mod.run(ctx);
  } catch (e) {
    const detail = e && e.code ? `${e.code}: ${e.message}` : (e && e.message) || String(e);
    process.stderr.write(`belay ${name}: ${detail}\n`);
    return 1;
  }

  if (!result || typeof result.code !== 'number') {
    process.stderr.write(`belay ${name}: command returned no receipt, which is a bug in the command\n`);
    return 1;
  }
  const body = ctx.json ? `${JSON.stringify(result.json ?? null, null, 2)}\n` : (result.text ?? '');
  (result.code === 0 ? process.stdout : process.stderr).write(body);
  return result.code;
}

// A write to a stream is not done until its callback fires; an empty write queues behind the pending
// ones and fires after them, so it is the drain marker (it also covers write() having returned false).
const drained = s => new Promise(resolve => { s.write('', () => resolve()); });

// A mode-R command ends the process once stdout and stderr have drained. Against a wedged owner the
// libuv pipe connect that the dial timer abandoned cannot be cancelled and waits up to 30 s in
// WaitNamedPipeW, which keeps the event loop alive; a read verb has nothing left to wait for. Write
// verbs and `run` keep the natural exit: their close, owner shutdown and receipt write run to the end.
// `io` is the tests' seam: fake streams and a stub exit. The default is the process itself.
async function finish(argv, code, io = { stdout: process.stdout, stderr: process.stderr, exit: c => process.exit(c) }) {
  process.exitCode = code;
  const g = parseGlobals(argv);
  const spec = g.error ? null : COMMANDS[g.argv[0]];
  if (!spec || spec.mode !== 'R') return;
  await Promise.all([drained(io.stdout), drained(io.stderr)]);
  // An owner this command released while another client was still attached keeps serving until the last one is gone (ADR 0050);
  // exiting here would pull the store from under that client. Nothing is waited on when no owner was retired.
  await require('../core/retire.cjs').idle();
  io.exit(code);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  main(argv)
    .then(code => finish(argv, code))
    .catch(e => { process.stderr.write(`belay: ${(e && e.stack) || e}\n`); process.exitCode = 1; });
}

module.exports = { main, finish, usage, COMMANDS, parseGlobals, VERSION };
