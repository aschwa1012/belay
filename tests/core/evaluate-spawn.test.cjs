'use strict';
// evaluate.cjs spawn edges: a missing cwd is named as one (B3), and npm/npx on Windows run as node plus their script (B2).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { core } = require('./helpers.cjs');

const { runCommand, resolveWindowsShim } = core('evaluate.cjs');

test('a missing cwd reports "cwd does not exist: <path>", not a spawn error naming the executable', async () => {
  const missing = path.join(os.tmpdir(), `belay-no-such-cwd-${process.pid}`).split(path.sep).join('/');
  const r = await runCommand([process.execPath, '-e', ''], missing, 5000);
  assert.strictEqual(r.executable, false);
  assert.strictEqual(r.exit_code, null);
  assert.strictEqual(r.spawn_error, `cwd does not exist: ${missing}`);
});

test('an existing cwd still runs the command', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-cwd-ok-'));
  try {
    const r = await runCommand([process.execPath, '-e', 'process.exit(0)'], dir, 20000);
    assert.strictEqual(r.executable, true);
    assert.strictEqual(r.exit_code, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('resolveWindowsShim: npm and npx become node plus the script beside node on win32, and nothing else changes', () => {
  const exe = 'C:/nodejs/node.exe';
  const yes = () => true;
  const no = () => false;
  const npm = resolveWindowsShim(['npm', 'test', '--', '-x'], 'win32', exe, yes);
  assert.deepStrictEqual(npm.map((s) => s.split(path.sep).join('/')), [exe, 'C:/nodejs/node_modules/npm/bin/npm-cli.js', 'test', '--', '-x']);
  assert.ok(resolveWindowsShim(['NPX.cmd', 'x'], 'win32', exe, yes)[1].split(path.sep).join('/').endsWith('/npx-cli.js'));
  assert.deepStrictEqual(resolveWindowsShim(['npm', 'test'], 'linux', exe, yes), ['npm', 'test'], 'not on other platforms');
  assert.deepStrictEqual(resolveWindowsShim(['npm', 'test'], 'win32', exe, no), ['npm', 'test'], 'no script found: as written');
  assert.deepStrictEqual(resolveWindowsShim(['node', 'x.js'], 'win32', exe, yes), ['node', 'x.js']);
  assert.deepStrictEqual(resolveWindowsShim(['./npm', 'x'], 'win32', exe, yes), ['./npm', 'x'], 'a path is the caller\'s own file');
});

test('npm resolves and runs where belay spawns commands, without a shell', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-npm-'));
  try {
    const r = await runCommand(['npm', '--version'], dir, 60000);
    assert.strictEqual(r.executable, true, JSON.stringify(r));
    assert.strictEqual(r.exit_code, 0, JSON.stringify(r));
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
