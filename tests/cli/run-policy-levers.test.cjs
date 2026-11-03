'use strict';
require('../helpers/tmp.cjs');
// run-policy-levers.test.cjs — the user's default plan for a run (ADR 0071 decision 3): the spec's `policy` over the config's `run.policy`
// over nothing, null turns a config default off for one run, a value v1 does not accept is refused at launch, and a run that states no
// plan has the levers it always had.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLevers } = require('../../src/cli/run-levers.cjs');
const { KNOWN_KEYS, parseSpec } = require('../../src/cli/run-spec.cjs');

const cfg = (run) => ({ config: { path: '/p/belay.config.json', memory: undefined, run } });
const PLAN = { fix: 'builder', integrate: 'on_hold' };

test('off when absent: no policy keys, belay ships no default', () => {
  const l = parseLevers({});
  assert.strictEqual(l.policy_default, undefined);
  assert.strictEqual(l.policy_source, undefined);
});

test('the spec key is known and its plan is the default', () => {
  assert.ok(KNOWN_KEYS.has('policy'));
  const l = parseLevers({ policy: PLAN });
  assert.deepStrictEqual([l.policy_default, l.policy_source], [PLAN, 'spec']);
});

test('the config run block is the default, the spec wins field by field, and null turns the default off for one run', () => {
  const c = cfg({ policy: { review: { worker: 'cfg-rev' }, fix: 'builder' } });
  const d = parseLevers({}, c);
  assert.deepStrictEqual([d.policy_default, d.policy_source], [{ review: { worker: 'cfg-rev' }, fix: 'builder' }, '/p/belay.config.json']);
  const both = parseLevers({ policy: { integrate: 'on_hold', fix: 'builder' } }, cfg({ policy: { review: { worker: 'cfg-rev' } } }));
  assert.deepStrictEqual(both.policy_default, { review: { worker: 'cfg-rev' }, integrate: 'on_hold', fix: 'builder' }, 'spec {fix, integrate} plus config {review} gives all three');
  assert.strictEqual(both.policy_source, 'spec + /p/belay.config.json');
  assert.deepStrictEqual(parseLevers({ policy: { review: { worker: 'spec-rev' } } }, c).policy_default, { review: { worker: 'spec-rev' }, fix: 'builder' }, 'a spec field beats the configs; the rest is filled');
  const off = parseLevers({ policy: null }, c);
  assert.deepStrictEqual([off.policy_default, off.policy_source], [undefined, 'spec (off)']);
});

test('a plan v1 does not accept is a usage error naming where it was written', () => {
  assert.match(parseLevers({ policy: { follow_up: 'wake' } }).error, /spec policy\.follow_up is not accepted in 0\.4\.0/);
  assert.match(parseLevers({ policy: { review: { pool: ['a'] } } }).error, /not accepted in 0\.4\.0/);
  assert.match(parseLevers({ policy: 'builder' }).error, /spec policy must be an object/);
  assert.match(parseLevers({}, cfg({ policy: { fix: 'x' } })).error, /run\.policy in \/p\/belay\.config\.json\.fix: "x" is not accepted in 0\.4\.0/);
});

test('an empty plan is no default', () => {
  assert.strictEqual(parseLevers({ policy: {} }).policy_default, undefined);
});

test('parseSpec carries the plan to the run, and refuses a bad one before anything starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pol-spec-'));
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'brief');
    const write = (extra) => { const p = path.join(dir, 'spec.json'); fs.writeFileSync(p, JSON.stringify({ worktree: dir, brief_file: 'brief.md', ...extra })); return p; };
    assert.deepStrictEqual(parseSpec(write({ policy: PLAN }), dir).levers.policy_default, PLAN);
    assert.match(parseSpec(write({ policy: { cut: {} } }), dir).error, /not accepted in 0\.4\.0/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
