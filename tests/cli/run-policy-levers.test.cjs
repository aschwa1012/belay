'use strict';
require('../helpers/tmp.cjs');
// run-policy-levers.test.cjs — the default plan for a run (ADR 0071 decision 3; the shipped plan is ADR 0074 amendment 4): the spec's `policy` over the
// config's `run.policy` over belay's shipped plan, field by field; null in the spec turns every default off for one run; a value v1 does
// not accept is refused at launch.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseLevers } = require('../../src/cli/run-levers.cjs');
const { KNOWN_KEYS, parseSpec } = require('../../src/cli/run-spec.cjs');
const { SHIPPED_PLAN } = require('../../src/cli/run-policy-levers.cjs');

const cfg = (run) => ({ config: { path: '/p/belay.config.json', memory: undefined, run } });
const PLAN = { fix: 'builder', integrate: 'on_hold' };
const SHIPPED = { build: { spawn: { agent_type: 'coder' } }, review: { spawn: { agent_type: 'reviewer' } }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' };

test('a run that states no plan takes belay\'s shipped plan: build, review, fix, re-review and merge', () => {
  assert.deepStrictEqual(SHIPPED_PLAN, SHIPPED);
  const l = parseLevers({});
  assert.deepStrictEqual([l.policy_default, l.policy_source], [SHIPPED, 'belay default']);
});

test('the spec key is known and its plan replaces the shipped plan field by field', () => {
  assert.ok(KNOWN_KEYS.has('policy'));
  const l = parseLevers({ policy: { review: { worker: 'rv' } } });
  assert.deepStrictEqual([l.policy_default, l.policy_source], [{ ...SHIPPED, review: { worker: 'rv' } }, 'spec + belay default']);
  assert.deepStrictEqual(parseLevers({ policy: PLAN }).policy_default, SHIPPED, 'fields equal to the shipped ones change nothing');
});

test('the config run block over the shipped plan, the spec over both field by field, and null turns every default off for one run', () => {
  const c = cfg({ policy: { review: { worker: 'cfg-rev' }, fix: 'builder' } });
  const d = parseLevers({}, c);
  assert.deepStrictEqual([d.policy_default, d.policy_source], [{ ...SHIPPED, review: { worker: 'cfg-rev' } }, '/p/belay.config.json + belay default']);
  const both = parseLevers({ policy: { build: { worker: 'b1' } } }, cfg({ policy: { review: { worker: 'cfg-rev' } } }));
  assert.deepStrictEqual(both.policy_default, { ...SHIPPED, build: { worker: 'b1' }, review: { worker: 'cfg-rev' } });
  assert.strictEqual(both.policy_source, 'spec + /p/belay.config.json + belay default');
  const off = parseLevers({ policy: null }, c);
  assert.deepStrictEqual([off.policy_default, off.policy_source], [undefined, 'spec (off)']);
});

test('a plan v1 does not accept is a usage error naming where it was written', () => {
  assert.match(parseLevers({ policy: { follow_up: 'wake' } }).error, /spec policy\.follow_up is not accepted in 0\.4\.0/);
  assert.match(parseLevers({ policy: { review: { pool: ['a'] } } }).error, /not accepted in 0\.4\.0/);
  assert.match(parseLevers({ policy: 'builder' }).error, /spec policy must be an object/);
  assert.match(parseLevers({}, cfg({ policy: { fix: 'x' } })).error, /run\.policy in \/p\/belay\.config\.json\.fix: "x" is not accepted in 0\.4\.0/);
});

test('an empty plan states nothing: the shipped plan stands', () => {
  assert.deepStrictEqual(parseLevers({ policy: {} }).policy_default, SHIPPED);
});

test('parseSpec carries the plan to the run, and refuses a bad one before anything starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'belay-pol-spec-'));
  try {
    fs.writeFileSync(path.join(dir, 'brief.md'), 'brief');
    const write = (extra) => { const p = path.join(dir, 'spec.json'); fs.writeFileSync(p, JSON.stringify({ worktree: dir, brief_file: 'brief.md', ...extra })); return p; };
    assert.deepStrictEqual(parseSpec(write({ policy: { review: { worker: 'rv' } } }), dir).levers.policy_default, { ...SHIPPED, review: { worker: 'rv' } });
    assert.strictEqual(parseSpec(write({ policy: null }), dir).levers.policy_default, undefined);
    assert.match(parseSpec(write({ policy: { cut: {} } }), dir).error, /not accepted in 0\.4\.0/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
