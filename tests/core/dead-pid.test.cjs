'use strict';
// dead-pid.test.cjs — the helper's pid can never collide with a real one: a process the host spawns holds a pid far below its floor,
// and a pid it hands out reads dead to the same check the product uses.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { deadPid, FLOOR, CEILING } = require('../helpers/dead-pid.cjs');
const { pidAlive } = require('../../src/core/lock.cjs');

test('deadPid hands out distinct pids that no process holds', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const p = deadPid();
    assert.ok(Number.isSafeInteger(p) && p > FLOOR - 4 && p <= CEILING, `pid ${p} is in the never-issued range`);
    assert.ok(!seen.has(p), `pid ${p} was handed out twice`);
    seen.add(p);
    assert.strictEqual(pidAlive(p), false, `pid ${p} reads alive`);
  }
});

test('a real process holds a pid far below the never-issued range', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { windowsHide: true, stdio: 'ignore' });
  const exited = new Promise((r) => child.once('exit', r));
  try {
    assert.ok(pidAlive(child.pid), 'the child runs');
    assert.ok(child.pid < FLOOR / 100, `the child's pid ${child.pid} is nowhere near ${FLOOR}`);
    assert.ok(process.pid < FLOOR / 100);
  } finally { child.kill(); await exited; }
});
