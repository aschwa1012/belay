'use strict';
// run-args.cjs — two small pieces of `belay run`'s argument handling, moved out of cmd-run.cjs for its line budget.

const L = require('../run/launch.cjs');

// ADR 0034 decision 1. The one test-only skip: BELAY_TEST_SKIP_EMBEDDER_WARMUP=1, honoured only together with
// BELAY_TEST_MODE=1. BELAY_CLAUDE_EXE is a production override and never skips it.
function warmupSkipped() {
  if (process.env.BELAY_TEST_MODE === '1' && process.env.BELAY_TEST_SKIP_EMBEDDER_WARMUP === '1') return 'BELAY_TEST_SKIP_EMBEDDER_WARMUP is set under BELAY_TEST_MODE';
  return null;
}

// ADR 0028 decision 5: `--effort <level>` (or `--effort=<level>`) is the one flag this command takes
// beyond the dispatcher's own; what is left is the positional spec path.
function parseEffort(argv) {
  const rest = [];
  let effort = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--effort' || a.startsWith('--effort=')) {
      const v = a === '--effort' ? argv[i + 1] : a.slice('--effort='.length);
      if (a === '--effort') i += 1;
      if (v === undefined || !L.EFFORT_LEVELS.includes(v)) {
        return { error: `--effort must be one of ${L.EFFORT_LEVELS.join(', ')}; got ${v === undefined ? 'nothing' : JSON.stringify(v)}` };
      }
      effort = v;
      continue;
    }
    rest.push(a);
  }
  return { rest, effort };
}

module.exports = { warmupSkipped, parseEffort };
