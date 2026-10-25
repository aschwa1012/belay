'use strict';
// argv-free-text.test.cjs — `message <id> <text...>` and `deny <id> [reason...]` end in free text. A global flag between two words
// of it is refused (exit 2) rather than taken out of the text; trailing --data and --json stay the documented form; a literal `--`
// ends option parsing. `belay stop` refuses an unknown option as a usage error. The spawned cases run the built CLI with --data in
// an mkdtemp directory and are waited for (spawnSync).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseGlobals } = require('../../src/cli/belay.cjs');

const CLI = path.resolve(__dirname, '..', '..', 'src', 'cli', 'belay.cjs');
const env = { ...process.env };
delete env.BELAY_WORKER_ID;
const belay = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
const sandbox = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `argv-${tag}-`)).split('\\').join('/');

test('a global flag inside message or deny text is refused, not stripped', () => {
  for (const argv of [
    ['message', 'w1', 'add', 'a', '--help', 'flag'],
    ['message', 'w1', 'print', '--json', 'output'],
    ['message', 'w1', 'see', '--data', 'notes', 'please'],
    ['message', 'w1', 'try', '-h'],
    ['message', 'w1', 'run', '--fix'],
    ['deny', 'r1', 'too', '--json', 'wide'],
  ]) {
    const g = parseGlobals(argv);
    assert.match(g.error || '', /inside the text of belay (message|deny)/, JSON.stringify(argv));
  }
});

test('globals before the text and after all of it still parse; -- makes every later word text', () => {
  const before = parseGlobals(['--json', 'message', '--data', 'd', 'w1', 'hello', 'there']);
  assert.deepStrictEqual([before.json, before.argv], [true, ['message', 'w1', 'hello', 'there']]);
  const trailing = parseGlobals(['message', 'w1', 'hello', 'there', '--json', '--data', 'd']);
  assert.strictEqual(trailing.error, undefined);
  assert.deepStrictEqual([trailing.json, trailing.argv], [true, ['message', 'w1', 'hello', 'there']]);
  const lit = parseGlobals(['message', 'w1', '--data', 'd', '--', 'add', 'a', '--help', 'flag', '--json']);
  assert.strictEqual(lit.error, undefined);
  assert.deepStrictEqual([lit.help, lit.json, lit.argv, lit.literal], [false, false, ['message', 'w1', 'add', 'a', '--help', 'flag', '--json'], 2]);
  // Only message and deny honour `--`: elsewhere it is an ordinary argument, so a settle reason of exactly `--` keeps the flag after it.
  const settle = parseGlobals(['memory', 'held', 'settle', 'n1', '--archive', '--reason', '--', '--if-awaiting', '--json']);
  assert.deepStrictEqual([settle.literal, settle.json, settle.argv], [null, true, ['memory', 'held', 'settle', 'n1', '--archive', '--reason', '--', '--if-awaiting']]);
  // Commands without free text are unchanged: a flag anywhere is still a global.
  const other = parseGlobals(['status', 'x', '--json', 'y']);
  assert.deepStrictEqual([other.error, other.json, other.argv], [undefined, true, ['status', 'x', 'y']]);
});

test('the built CLI: help inside message text is a usage error, never exit 0; --json inside it never answers in JSON', () => {
  const dir = sandbox('c1');
  const a = belay(dir, ['message', 'w1', 'add', 'a', '--help', 'flag', '--data', `${dir}/data`]);
  assert.strictEqual(a.status, 2, a.stderr);
  assert.doesNotMatch(a.stdout, /usage: belay <command>/);
  const b = belay(dir, ['message', 'w1', 'print', '--json', 'output', '--data', `${dir}/data`]);
  assert.strictEqual(b.status, 2);
  assert.doesNotMatch(b.stderr, /^\s*\{/);
  assert.strictEqual(fs.existsSync(`${dir}/data`), false);
});

test('the built CLI: a deny reason word after -- is text, before it an unknown option', () => {
  const dir = sandbox('deny');
  const bad = belay(dir, ['deny', 'r1', '-x', '--data', `${dir}/data`]);
  assert.strictEqual(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /unknown option -x/);
  const ok = belay(dir, ['deny', 'r1', '--data', `${dir}/data`, '--', '-x', 'is', 'risky']);
  assert.strictEqual(ok.status, 1, ok.stderr); // parsed; refused at runtime (no data dir), never a usage error
  assert.doesNotMatch(ok.stderr, /unknown option/);
});

test('belay stop with an unknown option is a usage error', () => {
  const dir = sandbox('c2');
  for (const opt of ['-x', '--force']) {
    const r = belay(dir, ['stop', opt, '--data', `${dir}/data`]);
    assert.strictEqual(r.status, 2, `${opt}: exit ${r.status}: ${r.stderr.slice(0, 160)}`);
    assert.match(r.stderr, new RegExp(`unknown option ${opt}`));
  }
});
