'use strict';
// worker-guard.cjs — the CLI's stopgap for the identity bind (ADR 0045, still unbuilt for the operator's side). Every command
// that writes opens the core as the operator, and the CLI ships beside the adapter a worker's Bash can see, so a worker that ran
// `belay memory verify` acted as the operator. The run manager now puts BELAY_WORKER_ID into every worker's environment
// (src/run/env.cjs), and the dispatcher asks this module before it loads a command: under that marker the write verbs refuse.
// A marker is not a boundary. A worker that unsets it passes, and so does one that opens the store itself. It stops the
// accident and the casual act, and it makes the refusal a row in the worker's own stream.

const READ_MEMORY_VERBS = new Set(['search', 'list', 'show', 'timeline', 'stats', 'export', 'proposals']);

// Verbs that read in one form and write in another are judged by the command's own parser (memory-render parseArgs) and its own
// write test (cmd-memory-lifecycle writes()), never by scanning tokens: `--reason --candidates` is a value, not the flag. Anything the
// parser rejects is refused. `held` lists unless it settles, `restore --candidates` lists, `embed --dry-run` only plans.
// `export --out <file>` writes that file as the operator, where the worker's own tools may not reach, so it is a write; to stdout it reads.
function isMemoryRead(argv) {
  if (argv[0] === 'export') { const parsed = require('./memory-render.cjs').parseArgs(argv); return !parsed.error && !parsed.opts.out; }
  if (READ_MEMORY_VERBS.has(argv[0])) return true;
  if (argv[0] !== 'held' && argv[0] !== 'restore' && argv[0] !== 'embed') return false;
  const parsed = require('./memory-render.cjs').parseArgs(argv);
  if (parsed.error) return false;
  if (parsed.sub === 'embed') return parsed.opts.dryRun === true;
  if (parsed.sub === 'restore' && !parsed.opts.candidates) return false;
  return !require('./cmd-memory-lifecycle.cjs').writes(parsed);
}

// `mode` is the command's declared mode (R read-only, W store client, C run control). Returns a refusal message, or null.
function workerRefusal({ name, mode, argv = [], fix = false, env = process.env }) {
  const id = env.BELAY_WORKER_ID;
  if (typeof id !== 'string' || !id) return null;
  let verb = null;
  if (name === 'settings') verb = argv.length >= 2 ? 'settings' : null; // mode W for its write form only: `settings` and `settings <key>` read the config
  else if (mode !== 'R') verb = name;
  else if (name === 'doctor' && fix) verb = 'doctor --fix';
  else if (name === 'memory' && !isMemoryRead(argv)) verb = `memory ${argv[0] === undefined ? '' : argv[0]}`.trim();
  if (!verb) return null;
  return `belay ${verb}: refused. This process runs inside worker ${id} (BELAY_WORKER_ID is set), and the CLI acts as the operator; `
    + 'a worker is not the operator. A worker reads and writes through its belay MCP tools. The read commands still answer.\n';
}

module.exports = { workerRefusal, READ_MEMORY_VERBS };
