'use strict';
// handback-facts.test.cjs — a reviewer's first message states, as a fact, belay's own acceptance result for the task it reviews:
// from that task's latest results, at the head they were judged on, and never an instruction about re-running.

const test = require('node:test');
const assert = require('node:assert');
const HB = require('../../src/run/handback.cjs');

const review = { id: 'r1', depends_on: ['w1'], acceptance: { verdict: true } };
const assigned = { task: review, new_lease: { id: 'lease-1' } };
const results = (over = {}) => ({ passed: true, head_sha: 'abcdef0123456789', checks: [{ kind: 'command', argv: ['node', '--test'], passed: true }, { kind: 'files_within_owned', passed: true }], ...over });
const getter = (rows) => async (id) => { if (!rows[id]) throw new Error('gone'); return rows[id]; };

test('a verdict task gets one fact line per reviewed task, with the head and the check names', async () => {
  const f = await HB.facts(getter({ w1: { id: 'w1', results: results() } }), assigned);
  assert.strictEqual(f, "\n\nbelay's acceptance checks for w1 passed at abcdef012345 (node --test; files_within_owned).");
  const msg = HB.rule(assigned, f);
  assert.match(msg, /findings": \[\.\.\.\] \}\.\n\nbelay's acceptance checks for w1 passed/);
  assert.ok(msg.indexOf("belay's acceptance") < msg.indexOf(HB.reviewStandard().slice(0, 40)), 'before the Review standard');
  assert.ok(!/re-?run|do not run|need not/i.test(f), 'a fact only');
});

test('several reviewed tasks each get a line; a failing one says it did not pass', async () => {
  const two = { task: { ...review, depends_on: ['w1', 'w2'] }, new_lease: { id: 'l' } };
  const f = await HB.facts(getter({ w1: { results: results() }, w2: { results: results({ passed: false, head_sha: '1234567890abcdef' }) } }), two);
  assert.deepStrictEqual(f.trim().split('\n').map((l) => l.replace(/ \(.*$/, '')), ["belay's acceptance checks for w1 passed at abcdef012345", "belay's acceptance checks for w2 did not pass at 1234567890ab"]);
});

test('nothing is said without results, with stale results, for a work task, or when the task cannot be read', async () => {
  assert.strictEqual(await HB.facts(getter({ w1: { results: null } }), assigned), '');
  assert.strictEqual(await HB.facts(getter({ w1: { results: results({ stale: 'acceptance amended' }) } }), assigned), '');
  assert.strictEqual(await HB.facts(getter({}), assigned), '');
  assert.strictEqual(await HB.facts(getter({ w1: { results: results() } }), { task: { id: 'c', depends_on: ['w1'], acceptance: {} }, new_lease: { id: 'l' } }), '');
  assert.strictEqual(HB.rule({ task: { id: 'c', acceptance: {} }, new_lease: { id: 'l' } }).includes("belay's acceptance"), false);
});
