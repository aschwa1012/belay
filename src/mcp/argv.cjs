'use strict';
// argv.cjs — the adapter's command line, parsed once into its identity (ADR 0010 §1, invariant 3): role, run
// id, worker id, data dir and the flags that shape the process. Nothing in any request can change what this
// returns. Moved out of belay-mcp.cjs unchanged, to keep that file under its line budget.
//
// Usage: node belay-mcp.cjs --role orchestrator|worker --run <id> --data <dir>
//                           [--worker-id <id>] [--no-embed] [--log <file>] [--worktree <dir>]

const path = require('node:path');
const CP = require('../run/compaction.cjs'); // fs and path only; parses --compact-at
const AD = require('../run/agent-defaults.cjs'); // pure; checks the --agent-defaults file

const VALUE_FLAGS = new Set(['--role', '--run', '--data', '--worker-id', '--log', '--permit-wait-ms', '--compact-at', '--worktree', '--agent-defaults', '--bind']);
const BOOL_FLAGS = new Set(['--no-embed', '--experimental-worker-wait', '--permit', '--notes']);

function die(reason) {
  process.stderr.write(`belay-mcp: ${reason}\n`);
  process.exit(2);
}

// The file belay run wrote beside the adapter's mcp.json: { path, types }. A file that cannot be read or checked is a
// refusal at start, never a silent run without the defaults the operator configured.
function readAgentDefaults(file) {
  let parsed;
  try { parsed = JSON.parse(require('node:fs').readFileSync(file, 'utf8')); } catch (e) { die(`--agent-defaults ${file} could not be read: ${e.message}`); }
  const checked = AD.parseAgentsBlock(parsed && parsed.types);
  if (checked.error) die(`--agent-defaults ${file}: ${checked.error}`);
  return { path: parsed.path || null, types: checked.value };
}

function parseArgv(argv) {
  const out = { embed: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    // Kept as a named refusal (build 2): there is no headless mode of this adapter. Headlessness is a property
    // of the Claude session the CLI spawns (`claude -p`, ADR 0009 §1); this process's argv is identical either
    // way, which keeps identity argv-only (invariant 3). See src/run/launch.cjs orchestratorLaunchArgv.
    if (a === '--headless') {
      die('--headless is not a mode of this adapter; a headless orchestrator is a `claude -p` session '
        + 'that the CLI spawns with this adapter in its --mcp-config, and its argv is unchanged. '
        + 'See src/run/launch.cjs orchestratorLaunchArgv (ADR 0009 §1)');
    }
    if (a === '--no-embed') { out.embed = false; continue; }
    // Accepted and ignored. It gated worker_wait while ADR 0014 finding 1 was being probed; ADR 0015
    // admitted the tool, so the flag names the default. Kept so older probe drivers
    // that pass it still run against this adapter unchanged.
    if (a === '--experimental-worker-wait') continue;
    // --permit is a worker adapter's flag; the role check runs once argv is fully parsed.
    if (a === '--permit') { out.permit = true; continue; }
    // --notes (ADR 0047): the run has the notes lever on, so this worker adapter lists the notes fields. The run manager
    // passes it from the run row; it changes what is listed, never who the caller is.
    if (a === '--notes') { out.notes = true; continue; }
    if (BOOL_FLAGS.has(a)) continue;
    if (!VALUE_FLAGS.has(a)) die(`unknown argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) die(`${a} needs a value`);
    i += 1;
    if (a === '--role') out.role = v;
    else if (a === '--run') out.runId = v;
    else if (a === '--data') out.dataDir = v;
    else if (a === '--worker-id') out.workerId = v;
    else if (a === '--log') out.logFile = v;
    else if (a === '--bind') out.bind = v; // ADR 0045: the one-shot pipe this adapter claims its identity from, before it answers `initialize`
    else if (a === '--agent-defaults') out.agentDefaults = readAgentDefaults(v); // the run's resolved config `agents` block, for worker_spawn's agent_type
    else if (a === '--worktree') out.worktree = path.resolve(v).split('\\').join('/'); // ADR 0043 decision 1: the run's worktree
    else if (a === '--compact-at') { // ADR 0007 decision 3: the run's compact_at_tokens, for the workers this manager spawns
      out.compactAt = CP.parseCompactAt(/^\d+$/.test(v) ? Number(v) : NaN).value;
      if (!out.compactAt) die(`--compact-at must be a positive integer, got ${v}`);
    } else if (a === '--permit-wait-ms') {
      if (!/^-?\d+$/.test(v) || Number(v) <= 0) die(`--permit-wait-ms must be a positive integer, got ${v}`);
      out.permitWaitMs = Number(v);
    }
  }
  if (out.role !== 'orchestrator' && out.role !== 'worker') {
    die(`--role must be orchestrator or worker, got ${out.role === undefined ? '(missing)' : out.role}`);
  }
  if (!out.runId) die('--run <id> is required; a run id is part of this process\'s identity and cannot come from a request');
  if (out.role === 'worker' && !out.workerId) die('--worker-id <id> is required in worker role; a worker cannot name itself');
  if (out.role === 'orchestrator' && out.workerId) die('--worker-id is not accepted in orchestrator role');
  if (out.permit && out.role === 'orchestrator') die('--permit is a worker adapter\'s flag');
  if (out.notes && out.role !== 'worker') die('--notes is a worker adapter\'s flag');
  if (out.agentDefaults && out.role !== 'orchestrator') die('--agent-defaults is an orchestrator adapter\'s flag');
  out.permit = !!out.permit;
  out.notes = !!out.notes;
  if (out.permitWaitMs === undefined) out.permitWaitMs = 600000;
  const defaulted = !out.dataDir;
  out.dataDir = path.resolve(out.dataDir || path.join(process.cwd(), '.belay')).split('\\').join('/');
  // A store in a place nobody named is the silent divergence invariant 5 exists to prevent, so the
  // default is announced. api.md §1 writes --data unbracketed; the lead is settling whether it is
  // required. Until then it defaults and says so.
  if (defaulted) process.stderr.write(`belay-mcp: --data not given, defaulting to ${out.dataDir}\n`);
  if (out.logFile) {
    const lf = path.resolve(out.logFile).split('\\').join('/');
    if (lf === out.dataDir || lf.startsWith(`${out.dataDir}/`)) {
      // api.md §1: the data dir layout is fixed, and the one place a log may live inside it is a
      // worker's own directory, beside the adapter.log the run manager already writes there. A worker
      // adapter may only write under its own id: `workers/<worker-id>/` is the caller's directory, not
      // any worker's.
      const rest = lf.slice(out.dataDir.length + 1).split('/');
      const wellPlaced = out.workerId !== undefined
        && rest.length >= 3 && rest[0] === 'workers' && rest[1] === out.workerId;
      if (!wellPlaced) {
        die(`--log must not point inside the data dir except under workers/${out.workerId || '<worker-id>'}/, and only from the adapter whose id that is; api.md §1 fixes what lives there`);
      }
    }
    out.logFile = lf;
  }
  return out;
}

module.exports = { parseArgv, die };
