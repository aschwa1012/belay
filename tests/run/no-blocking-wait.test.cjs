'use strict';
require('../helpers/temp-root.cjs').enforceSafeTemp(process.env); // scratch never lands in an indexed folder, even for a bare `node file`
// no-blocking-wait.test.cjs — ADR 0037 amendment 7: the orchestrator waits by the wake in both modes. Both prompts and the worker_wait
// description steer away from holding a turn open in worker_wait and leave it at most a short check; the headless prompt no longer offers
// the run wait as the way to receive exceptions and the digest.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const flat = (s) => s.replace(/\s+/g, ' ');
const read = (f) => flat(fs.readFileSync(path.join(ROOT, 'src/run/prompts', f), 'utf8'));

test('the headless prompt waits by the wake: no blocking wait, at most a short check', () => {
  const h = read('orchestrator.md');
  assert.ok(h.includes('To wait for a worker that is working, end your turn: belay wakes you'));
  assert.ok(h.includes('Do not hold a turn open in `mcp__belay__worker_wait`: what it returns also reaches you by a wake.'));
  assert.ok(h.includes('Use it at most as a short check, with `worker_ids` and `timeout_ms: 5000`'));
  assert.ok(h.includes('you do not need to call it.'), 'under a plan the run wait is not needed');
  assert.ok(!h.includes('wait on its id'), 'every "wait on its id" is now "end your turn until its wake"');
  assert.ok(!h.includes('wait for the run instead of ending your turn'), 'no advice to hold the run open by waiting');
});

test('the interactive prompt says the run wait returns nothing the wakes do not', () => {
  const t = read('orchestrator-interactive.md');
  assert.ok(t.includes('`worker_ids` returns the same exceptions and steps; you do not need to call it.'));
  assert.ok(t.includes('Never call it in a loop.'));
});

test('the worker_wait description says wakes deliver what it returns, and to use it at most as a short check', () => {
  const d = require(path.join(ROOT, 'src/mcp/tools.cjs')).toolsFor('orchestrator').find((x) => x.name === 'worker_wait').description;
  assert.match(d, /^A short status check, not a way to wait: wakes deliver all of this without a call, so end your turn to wait\. /);
  assert.ok(!/^Block until/.test(d), 'it no longer leads with blocking');
});
