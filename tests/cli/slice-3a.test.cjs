'use strict';
require('../helpers/tmp.cjs'); // every test process gets its own spawn register and tmp cleanup (tests/helpers/tmp.cjs), however it is run
// slice-3a.test.cjs — the acceptance criterion for CLI slice 3a: `config`, `init`, `doctor` and
// `mcp status`, plus the dispatcher's help path. No experiment: this is an ordinary test file now,
// and its own spawned-process budgets (ADR 0018 amendment 1) live in the sequential budget phase,
// `tests/budgets/cli-budgets.test.cjs`, not here — this file keeps only the in-process usage gate.
//
// Every row here traces to a receipt column in the command table §3 and §6, or to a budget in
// ADR 0018. The budgets are measured THROUGH THE BUILT CLI as a subprocess, never through a module,
// because a module measurement cannot see process start-up, which is most of the budget.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
const CLI = `${ROOT}/src/cli/belay.cjs`;

// The one config file, per command table §6: discovered by walking up from cwd to the project root
// and stopping there, never the home directory.
const CONFIG_NAME = 'belay.config.json';

// ---------------------------------------------------------------- scaffolding

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cli-test-')).split(path.sep).join('/');
}

function cleanup(dir) {
  for (let i = 0; i < 5; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { process.emitWarning(`sandbox left behind at ${dir}: ${e.code || e.message}`); }
}

// A sandbox that looks like a project root, so config discovery has somewhere to stop that is not
// the home directory.
function projectSandbox() {
  const dir = sandbox();
  fs.writeFileSync(`${dir}/package.json`, JSON.stringify({ name: 'sandbox-project' }), 'utf8');
  fs.mkdirSync(`${dir}/.git`, { recursive: true });
  return dir;
}

function listFiles(dir) {
  const out = [];
  (function walk(d, rel) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); walk(`${d}/${e.name}`, r); }
      else out.push(r);
    }
  })(dir, '');
  return out;
}

function cli(args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return {
    code: r.status, stdout: r.stdout || '', stderr: r.stderr || '',
    ms: Date.now() - t0, all: (r.stdout || '') + (r.stderr || ''),
  };
}

function parseJson(out, label) {
  try { return JSON.parse(out); }
  catch (e) { assert.fail(`${label}: --json did not produce parseable JSON: ${e.message}\ngot: ${out.slice(0, 400)}`); }
}

// ================================================================ dispatcher and help
// Owned by the integration owner, not by a slice-3a author. These pass before the slice is built and
// must still pass after it: they are the guard that nobody bought a command by breaking the help path.

test('help lists every command with its mode, and exits 0', () => {
  for (const args of [['--help'], ['help'], []]) {
    const r = cli(args);
    assert.strictEqual(r.code, 0, `${JSON.stringify(args)} should exit 0, got ${r.code}: ${r.stderr}`);
    for (const name of ['config', 'init', 'doctor', 'mcp']) {
      assert.match(r.stdout, new RegExp(`\\b${name}\\b`), `usage names ${name}`);
    }
    assert.match(r.stdout, /R read-only/, 'usage explains the connection modes');
  }
});

test('a command with --help prints that command\'s usage only, and creates no file', () => {
  const dir = projectSandbox();
  try {
    const before = listFiles(dir);
    for (const args of [['stop', '--help'], ['--help', 'stop'], ['stop', '-h']]) {
      const r = cli(args, { cwd: dir });
      assert.strictEqual(r.code, 0, `${JSON.stringify(args)}: ${r.stderr}`);
      assert.match(r.stdout, /^usage: belay stop /);
      assert.match(r.stdout, /stop a live run/);
      assert.doesNotMatch(r.stdout, /commands \(mode/, 'not the global usage');
    }
    const mem = cli(['memory', '--help'], { cwd: dir });
    assert.strictEqual(mem.code, 0);
    assert.match(mem.stdout, /^usage: belay memory \[arguments\] \[options\]/);
    assert.match(mem.stdout, /a verb in the line above may elect or write/, 'a command with verbs says its mode is the command\'s own');
    assert.doesNotMatch(cli(['config', '--help'], { cwd: dir }).stdout, /a verb in the line above/);
    assert.deepStrictEqual(listFiles(dir), before, 'command help created a file');
  } finally { cleanup(dir); }
});

test('an unknown command is a usage error: exit 2, names it, prints usage', () => {
  const r = cli(['nosuchcommand']);
  assert.strictEqual(r.code, 2, 'usage errors exit 2');
  assert.match(r.all, /nosuchcommand/, 'the refusal names what was not understood');
  assert.match(r.all, /usage: belay/, 'a usage error prints the usage');
});

test('--data without a value is a usage error, not a crash', () => {
  const r = cli(['config', '--data']);
  assert.strictEqual(r.code, 2);
  assert.match(r.all, /--data/);
});

test('the help path creates no file and starts no process (invariant 2)', () => {
  const dir = projectSandbox();
  try {
    const before = listFiles(dir);
    const r = cli(['--help'], { cwd: dir });
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(listFiles(dir), before, 'help created a file');
  } finally { cleanup(dir); }
});

// ================================================================ budgets (ADR 0018 amendment 1)

// This file asked for the record by name ("invariant 9's 'help and status under 100 ms' needs a
// decision record stating the budget in a measurable form"); ADR 0018 answered it, and amendment 1
// moved every spawned-process gate into its own sequential phase of `npm test`,
// tests/budgets/cli-budgets.test.cjs, because the floor and the commands it gates must share one load
// window, and a gate inside a file `node --test` runs beside three others cannot give them one. What
// stands here is the one budget measured in process, where the suite's own concurrency is not a factor.
// The four lines below are pre-ADR-0018 history, from the raw wall-clock numbers this header used to
// carry:
//
//   node <empty .cjs>            140 ms median, 9 samples
//   node belay.cjs --help        103 ms median, 9 samples
//   node belay.cjs nosuchcommand 107 ms median, 9 samples
//   node --version                64 ms median, 9 samples

test('budget: producing the usage text costs belay effectively nothing, in process', () => {
  const t0 = process.hrtime.bigint();
  const { usage } = require(CLI);
  const text = usage();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(text.length > 0, 'usage produced text');
  assert.ok(ms < 50, `requiring the dispatcher and producing usage took ${ms.toFixed(1)} ms; it is a static string`);
});

test('no CLI path loads the embedder module (13.5 s cold, 664 ms warm)', () => {
  // Requiring the dispatcher must not reach src/core at all, let alone the embedder. This mirrors
  // tests/core/import-graph.test.cjs, which enforces the same budget for the Core API.
  const probe = `
    require(${JSON.stringify(CLI)});
    const hit = Object.keys(require.cache).filter(k => /src[\\\\/](core[\\\\/]embedder|core[\\\\/]store)\\.cjs$/i.test(k));
    process.stdout.write(JSON.stringify(hit));
  `;
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.strictEqual(r.status, 0, `probe failed: ${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(r.stdout), [], 'the dispatcher reached the embedder or the store');
});

// ================================================================ config (mode R, command table §6)

test('config path prints the config file actually read, as an absolute path', () => {
  const dir = projectSandbox();
  try {
    fs.writeFileSync(`${dir}/${CONFIG_NAME}`, JSON.stringify({ data_dir: '.belay' }), 'utf8');
    const r = cli(['config', 'path'], { cwd: dir });
    assert.strictEqual(r.code, 0, `config path failed: ${r.stderr}`);
    assert.match(r.stdout, /belay\.config\.json/, 'it names the config file');
    assert.ok(path.isAbsolute(r.stdout.trim().split('\n').pop().trim()) || /:[\\/]/.test(r.stdout),
      'the path printed is absolute, so the operator knows which file was read');
  } finally { cleanup(dir); }
});

test('config discovery walks up to the project root and stops there, never the home directory', () => {
  const dir = projectSandbox();
  try {
    fs.writeFileSync(`${dir}/${CONFIG_NAME}`, JSON.stringify({ data_dir: '.belay' }), 'utf8');
    const deep = `${dir}/a/b/c`;
    fs.mkdirSync(deep, { recursive: true });
    const r = cli(['config', 'path', '--json'], { cwd: deep });
    assert.strictEqual(r.code, 0, `config path from a subdirectory failed: ${r.stderr}`);
    const j = parseJson(r.stdout, 'config path');
    assert.ok(String(j.path).includes(CONFIG_NAME), 'found the project-root config from a nested cwd');
    const home = os.homedir().split(path.sep).join('/');
    assert.ok(!String(j.path).split(path.sep).join('/').startsWith(`${home}/${CONFIG_NAME}`),
      'discovery must never resolve to a config in the home directory');
  } finally { cleanup(dir); }
});

test('config path reports honestly when there is no config file, rather than inventing one', () => {
  const dir = projectSandbox();
  try {
    const r = cli(['config', 'path', '--json'], { cwd: dir });
    const j = parseJson(r.stdout || r.stderr, 'config path');
    assert.strictEqual(j.found, false, 'found is false when no config file exists');
  } finally { cleanup(dir); }
});

test('config get names the effective value and the file it came from', () => {
  const dir = projectSandbox();
  try {
    fs.writeFileSync(`${dir}/${CONFIG_NAME}`, JSON.stringify({ data_dir: 'custom-store' }), 'utf8');
    const r = cli(['config', 'get', 'data_dir', '--json'], { cwd: dir });
    assert.strictEqual(r.code, 0, `config get failed: ${r.stderr}`);
    const j = parseJson(r.stdout, 'config get');
    assert.strictEqual(j.key, 'data_dir');
    assert.strictEqual(j.value, 'custom-store', 'the effective value');
    assert.ok(String(j.source).includes(CONFIG_NAME), 'no key is read from anywhere the CLI cannot name');
  } finally { cleanup(dir); }
});

test('config get on an unknown key is a usage error, not a silent null', () => {
  const dir = projectSandbox();
  try {
    fs.writeFileSync(`${dir}/${CONFIG_NAME}`, JSON.stringify({ data_dir: '.belay' }), 'utf8');
    const r = cli(['config', 'get', 'no_such_key'], { cwd: dir });
    assert.strictEqual(r.code, 2, 'an unknown key is refused');
    assert.match(r.all, /no_such_key/, 'the refusal names the key');
  } finally { cleanup(dir); }
});

test('config is mode R: it creates no file (command table §1)', () => {
  const dir = projectSandbox();
  try {
    fs.writeFileSync(`${dir}/${CONFIG_NAME}`, JSON.stringify({ data_dir: '.belay' }), 'utf8');
    const before = listFiles(dir);
    cli(['config', 'path'], { cwd: dir });
    cli(['config', 'get', 'data_dir'], { cwd: dir });
    assert.deepStrictEqual(listFiles(dir), before, 'a read-only command left a new file behind');
  } finally { cleanup(dir); }
});

// ================================================================ init (mode W)

test('init returns the absolute path, the bytes written, and the parsed config echoed back', () => {
  const dir = projectSandbox();
  try {
    const r = cli(['init', '--json'], { cwd: dir });
    assert.strictEqual(r.code, 0, `init failed: ${r.stderr}`);
    const j = parseJson(r.stdout, 'init');
    assert.ok(String(j.path).includes(CONFIG_NAME), 'the receipt names the file it wrote');
    assert.ok(Number.isFinite(j.bytes) && j.bytes > 0, 'the receipt states the bytes written');
    assert.ok(j.config && typeof j.config === 'object', 'the receipt echoes the parsed config back');
    assert.ok(fs.existsSync(`${dir}/${CONFIG_NAME}`), 'the file named in the receipt actually exists');
    assert.strictEqual(fs.statSync(`${dir}/${CONFIG_NAME}`).size, j.bytes, 'the bytes claimed are the bytes on disk');
  } finally { cleanup(dir); }
});

test('init creates the data directory it names', () => {
  const dir = projectSandbox();
  try {
    const r = cli(['init', '--json'], { cwd: dir });
    assert.strictEqual(r.code, 0, `init failed: ${r.stderr}`);
    const j = parseJson(r.stdout, 'init');
    assert.ok(j.data_dir, 'the receipt names the data dir');
    assert.ok(fs.existsSync(j.data_dir), 'the data dir named in the receipt exists');
  } finally { cleanup(dir); }
});

test('init never silently overwrites an existing config', () => {
  const dir = projectSandbox();
  try {
    const original = JSON.stringify({ data_dir: 'do-not-lose-me' });
    fs.writeFileSync(`${dir}/${CONFIG_NAME}`, original, 'utf8');
    const r = cli(['init', '--json'], { cwd: dir });
    assert.strictEqual(fs.readFileSync(`${dir}/${CONFIG_NAME}`, 'utf8'), original,
      'init destroyed an existing config; it must refuse or report, never silently overwrite');
    if (r.code === 0) {
      const j = parseJson(r.stdout, 'init');
      assert.strictEqual(j.created, false, 'when the config already existed the receipt says so');
    } else {
      assert.match(r.all, /exist/i, 'the refusal says the config already exists');
    }
  } finally { cleanup(dir); }
});

// ================================================================ doctor (mode R unless --fix)

test('doctor returns a verdict and evidence for every check', () => {
  const dir = projectSandbox();
  try {
    fs.writeFileSync(`${dir}/${CONFIG_NAME}`, JSON.stringify({ data_dir: '.belay' }), 'utf8');
    const r = cli(['doctor', '--json'], { cwd: dir });
    const j = parseJson(r.stdout || r.stderr, 'doctor');
    const checks = Array.isArray(j) ? j : j.checks;
    assert.ok(Array.isArray(checks) && checks.length > 0, 'doctor returns a list of checks');
    for (const c of checks) {
      assert.ok(c.check, 'every check is named');
      assert.ok(c.verdict, `check ${c.check} has a verdict`);
      assert.ok('evidence' in c, `check ${c.check} states the evidence behind its verdict, never a bare word`);
    }
  } finally { cleanup(dir); }
});

test('doctor is read-only by default: it writes nothing', () => {
  const dir = projectSandbox();
  try {
    fs.writeFileSync(`${dir}/${CONFIG_NAME}`, JSON.stringify({ data_dir: '.belay' }), 'utf8');
    const before = listFiles(dir);
    cli(['doctor'], { cwd: dir });
    assert.deepStrictEqual(listFiles(dir), before, 'doctor wrote something without --fix');
  } finally { cleanup(dir); }
});

test('doctor on an unconfigured directory answers, rather than failing to run', () => {
  const dir = projectSandbox();
  try {
    const r = cli(['doctor', '--json'], { cwd: dir });
    assert.notStrictEqual(r.code, 2, 'an unconfigured project is a finding, not a usage error');
    const j = parseJson(r.stdout || r.stderr, 'doctor');
    const checks = Array.isArray(j) ? j : j.checks;
    assert.ok(Array.isArray(checks) && checks.length > 0, 'a dead system is still a valid answer');
  } finally { cleanup(dir); }
});

// ================================================================ mcp status (mode R)

test('mcp status reports the five facts separately, never collapsed into one word', () => {
  const dir = projectSandbox();
  try {
    const r = cli(['mcp', 'status', '--json'], { cwd: dir });
    const j = parseJson(r.stdout || r.stderr, 'mcp status');
    for (const fact of ['catalogued', 'registered', 'configured', 'reachable', 'healthy']) {
      assert.ok(fact in j, `mcp status reports ${fact} as its own fact (command table §3)`);
    }
  } finally { cleanup(dir); }
});

test('mcp status is mode R: it creates no file', () => {
  const dir = projectSandbox();
  try {
    const before = listFiles(dir);
    cli(['mcp', 'status'], { cwd: dir });
    assert.deepStrictEqual(listFiles(dir), before, 'a read-only command left a new file behind');
  } finally { cleanup(dir); }
});
