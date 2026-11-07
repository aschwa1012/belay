'use strict';
// gpu-smi-bound.test.cjs — the probe's nvidia-smi call settles within its bound even when the child never exits
// (a wedged driver). Stand-in executables stand for nvidia-smi, so no test depends on the host's GPU or driver.

process.env.BELAY_TEST_MODE = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { core, FIXTURES } = require('./helpers.cjs');

const P = core('gpu-probe.cjs');
const HANG = path.join(FIXTURES, 'smi-hang.cjs');
const CSV = path.join(FIXTURES, 'smi-csv.cjs');

test('the probe source calls nvidia-smi asynchronously', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'gpu-probe.cjs'), 'utf8');
  assert.ok(!/execFileSync|spawnSync|execSync/.test(src));
  assert.ok(P.defaultSmi({ exists: () => false }) instanceof Promise);
});

test('no nvidia-smi on the host settles null without starting a process', async () => {
  let ran = false;
  assert.strictEqual(await P.defaultSmi({ exists: () => false, run: () => { ran = true; } }), null);
  assert.strictEqual(ran, false);
});

test('a child that never exits settles null at the bound, and the child is killed through its handle', { timeout: 15000 }, async () => {
  const { execFile } = require('node:child_process');
  let child;
  const run = (...a) => { child = execFile(...a); return child; };
  const t0 = Date.now();
  const got = await P.defaultSmi({ exe: process.execPath, args: [HANG], boundMs: 400, run, exists: () => true });
  const ms = Date.now() - t0;
  assert.strictEqual(got, null);
  assert.ok(ms >= 350 && ms < 3000, `settled after ${ms} ms`);
  await new Promise((resolve) => { if (child.exitCode !== null || child.signalCode) return resolve(); child.once('exit', resolve); });
  assert.ok(child.exitCode !== null || child.signalCode, 'the stuck child was killed');
});

test('a child whose close never comes settles null at the bound; it is killed, its pipes destroyed and its handle released', { timeout: 15000 }, async () => {
  const calls = [];
  const pipe = (n) => ({ destroy: () => calls.push(n + '.destroy') });
  const fake = { kill: () => calls.push('kill'), unref: () => calls.push('unref'), stdin: pipe('stdin'), stdout: pipe('stdout'), stderr: pipe('stderr') };
  const t0 = Date.now();
  const got = await P.defaultSmi({ boundMs: 200, run: () => fake, exists: () => true });
  assert.strictEqual(got, null);
  assert.ok(Date.now() - t0 < 3000);
  assert.deepStrictEqual(calls, ['kill', 'stdin.destroy', 'stdout.destroy', 'stderr.destroy', 'unref']);
});

test('a stand-in that prints CSV is parsed to the card with the most memory', { timeout: 15000 }, async () => {
  const got = await P.defaultSmi({ exe: process.execPath, args: [CSV], exists: () => true });
  assert.deepStrictEqual(got, { name: 'NVIDIA GeForce RTX 5060 Laptop GPU', driver: '617.42', total_mb: 8151, used_mb: 252, free_mb: 7899 });
});

test('a child that fails to launch settles null', { timeout: 15000 }, async () => {
  assert.strictEqual(await P.defaultSmi({ exe: path.join(FIXTURES, 'no-such-smi.exe'), exists: () => true }), null);
  assert.strictEqual(await P.defaultSmi({ exists: () => true, run: () => { throw new Error('spawn'); } }), null);
});
