'use strict';
// cmd-config.cjs — CLI slice 3a, mode R. The contract is in src/cli/belay.cjs:
// run(ctx) -> { code, text, json }, never printing, never calling process.exit, always returning the
// receipt that proves what happened (invariant 5). The acceptance criterion is
// tests/cli/slice-3a.test.cjs, written before this file and not edited to make it pass.
//
// command table §6: `config path` prints which file was actually read; `config get <key>` prints the
// effective value and where it came from. Mode R, so nothing here creates a file or a process —
// discovery is `existsSync` up a bounded walk and one `readFileSync`.

const C = require('./config.cjs');

const USAGE = [
  'usage: belay config [path|get <key>]',
  '',
  '  config            the file that would be read, and every effective value',
  '  config path       the absolute path of the config file actually read',
  '  config get <key>  one effective value and the file it came from',
  '',
  `keys: ${C.KEY_NAMES.join(', ')}`,
  '',
].join('\n');

function usageError(message) {
  return { code: 2, text: `belay config: ${message}\n\n${USAGE}`, json: { error: message, usage: USAGE.trim() } };
}

// "Where it came from" is a file path or the word default, and a not-found answer says where it
// looked. Neither is ever an empty string, because an operator reading this is trying to find out
// which file is in force.
function sourceLine(eff) {
  return eff.source === 'default' ? 'default' : eff.source;
}

function pathResult(found, json) {
  const payload = {
    found: found.found,
    path: found.path,
    dir: found.dir,
    parse_error: found.parse_error || null,
    searched: found.searched,
    stopped_at: found.stopped_at,
    stopped_because: found.stopped_because,
  };
  if (json) return { code: 0, text: '', json: payload };

  if (!found.found) {
    const lines = [
      `no ${C.CONFIG_NAME} was found.`,
      `looked in ${found.searched.length} director${found.searched.length === 1 ? 'y' : 'ies'}, stopping at ${found.stopped_because}:`,
      ...found.searched.map((p) => `  ${p}`),
      '',
      'belay init writes one.',
      '',
    ];
    return { code: 0, text: lines.join('\n'), json: payload };
  }
  // The path is the last line and nothing else is on it, so `belay config path | tail -1` is a path.
  const head = found.parse_error ? `warning: ${found.parse_error}\n` : '';
  return { code: 0, text: `${head}${found.path}\n`, json: payload };
}

function getResult(found, key, ctx) {
  if (!key) return usageError('get needs a key');
  const eff = C.effective(found, key, { dataDirOverride: C.overrideOf(ctx) });
  if (!eff) {
    return usageError(`unknown key ${key}; the keys are ${C.KEY_NAMES.join(', ')}`);
  }
  const payload = {
    key: eff.key,
    value: eff.value,
    source: eff.source,
    resolved: eff.resolved,
    describe: eff.describe,
    config_found: found.found,
  };
  if (eff.allowed) payload.allowed = eff.allowed;
  if (eff.invalid) payload.invalid = eff.invalid;
  if (ctx.json) return { code: 0, text: '', json: payload };
  const warn = eff.invalid ? `warning: ${eff.key}: ${eff.invalid.reason}\n` : '';
  return { code: 0, text: `${warn}${eff.key} = ${JSON.stringify(eff.value)}  (from ${sourceLine(eff)})\n`, json: payload };
}

function summary(found, ctx) {
  const rows = C.all(found, { dataDirOverride: C.overrideOf(ctx) });
  const payload = {
    found: found.found,
    path: found.path,
    parse_error: found.parse_error || null,
    values: Object.fromEntries(rows.map((r) => [r.key, {
      value: r.value, source: r.source, resolved: r.resolved, ...(r.invalid ? { invalid: r.invalid } : {}),
    }])),
  };
  if (ctx.json) return { code: 0, text: '', json: payload };

  const width = Math.max(...C.KEY_NAMES.map((k) => k.length));
  const lines = [
    found.found ? `config: ${found.path}` : `config: none found (belay init writes one)`,
  ];
  if (found.parse_error) lines.push(`warning: ${found.parse_error}`);
  lines.push('');
  for (const r of rows) {
    lines.push(`  ${r.key.padEnd(width)}  ${JSON.stringify(r.value)}  (from ${sourceLine(r)})`);
    if (r.invalid) lines.push(`  ${''.padEnd(width)}  invalid in file: ${r.invalid.reason}`);
  }
  lines.push('');
  return { code: 0, text: lines.join('\n'), json: payload };
}

async function run(ctx) {
  const [sub, ...rest] = ctx.argv;
  const found = C.discover(ctx.cwd);

  if (sub === undefined) return summary(found, ctx);
  if (sub === 'path') return pathResult(found, ctx.json);
  if (sub === 'get') return getResult(found, rest[0], ctx);
  return usageError(`unknown subcommand ${sub}`);
}

module.exports = { run, USAGE };
