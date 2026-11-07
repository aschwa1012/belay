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
  assert.ok(h.includes('Do not hold a turn open in `mcp__belay__worker_wait`: every result, exception, death and digest you act on reaches you by a wake, and what it alone answers is status detail'));
  assert.ok(h.includes('only while some worker is mid-turn or, under a plan, belay holds the run for a step'));
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
  assert.match(d, /^A short status check, not a way to wait: the results, exceptions, deaths and digests you act on reach you by wakes, so end your turn to wait; this alone also reports workers idle without a task and dropped queued messages\. timeout_ms defaults to 5000\. /);
  assert.ok(!/all of this/.test(d), 'no claim that wakes deliver everything it answers');
  assert.ok(!/^Block until/.test(d), 'it no longer leads with blocking');
});

test('a worker_wait that names no timeout holds 5 s, not the run manager\'s 110 s; a named timeout is kept', () => {
  const T = require(path.join(ROOT, 'src/mcp/tools-orchestrator.cjs'));
  assert.strictEqual(T.WAIT_DEFAULT_MS, 5000);
  assert.deepStrictEqual(T.waitArgs({ worker_ids: ['w1'] }), { worker_ids: ['w1'], timeout_ms: 5000 });
  assert.deepStrictEqual(T.waitArgs({ timeout_ms: 700 }), { timeout_ms: 700 });
  assert.deepStrictEqual(T.waitArgs(undefined), { timeout_ms: 5000 });
  for (const bad of [0, -1, 'soon', null, NaN]) assert.deepStrictEqual(T.waitArgs({ timeout_ms: bad }), { timeout_ms: 5000 }, `timeout_ms ${bad} is the short default, never the run wait's 110 s`);
  const schema = require(path.join(ROOT, 'src/mcp/tools.cjs')).toolsFor('orchestrator').find((x) => x.name === 'worker_wait').inputSchema.properties.timeout_ms;
  assert.match(schema.description, /default 5000/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/mcp/belay-mcp.cjs'), 'utf8'), /name === 'worker_wait' \? require\('\.\/tools-orchestrator\.cjs'\)\.waitArgs\(args\)/, 'the adapter applies it to the tool call');
});
