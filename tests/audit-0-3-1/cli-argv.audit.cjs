'use strict';
// Audit 0.3.1, mcp-cli slice: CLI argument handling. Each test states what should hold and FAILS on the code as it stands; see
// the 0.3.1 mcp-cli audit report. Not globbed by `npm test`. Run alone: node --test tests/audit-0-3-1/cli-argv.audit.cjs
// Sandboxed: every command gets --data inside an mkdtemp directory; each CLI child is waited for (spawnSync).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');
const env = { ...process.env };
delete env.BELAY_WORKER_ID;
const belay = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
const sandbox = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `aud-${tag}-`)).split('\\').join('/');

// C1. parseGlobals (belay.cjs:93-109) strips --json, --fix, -h/--help and --data <v> from anywhere in argv, so the words of
// `message <id> <text...>` (and `deny <id> [reason...]`) lose them, or the command never runs.
test('C1a: a message whose words include --help is sent, not answered with the usage', () => {
  const dir = sandbox('c1a');
  const r = belay(dir, ['message', 'w1', 'add', 'a', '--help', 'flag', '--data', `${dir}/data`]);
  assert.ok(!(r.status === 0 && /usage: belay <command>/.test(r.stdout)), `exit ${r.status}; the message was not sent and the usage was printed with exit 0`);
});

test('C1b: a message whose words include --json keeps the word', () => {
  const dir = sandbox('c1b');
  const r = belay(dir, ['message', 'w1', 'print', '--json', 'output', '--data', `${dir}/data`]);
  // The command fails (no such worker); the point is how it answers: --json was taken as the global flag.
  assert.ok(!/^\s*\{/.test(r.stderr), `the word --json was taken as the output flag: stderr ${JSON.stringify(r.stderr.slice(0, 120))}`);
});

// C2. `belay stop -x` is not a usage error: the unknown option is taken as the run id (exit 1, "no live run").
test('C2: belay stop with an unknown option is a usage error', () => {
  const dir = sandbox('c2');
  const r = belay(dir, ['stop', '-x', '--data', `${dir}/data`]);
  assert.strictEqual(r.status, 2, `exit ${r.status}: ${r.stderr.slice(0, 160)}`);
});
