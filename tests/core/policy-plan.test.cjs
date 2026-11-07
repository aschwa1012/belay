'use strict';
require('../helpers/tmp.cjs');
// policy-plan.test.cjs — ADR 0071 decisions 1 to 4: the plan's check against V1_ACCEPTS, the field-by-field precedence of a task's own
// plan over the user's default, the revision an amend writes, and the tag a listing shows. Pure; no store.

const { test } = require('node:test');
const assert = require('node:assert');
const PP = require('../../src/core/policy-plan.cjs');
const { WORKER_TYPES } = require('../../src/run/agent-defaults.cjs');

const refused = (v, re) => assert.throws(() => PP.check(v), (e) => e.code === 'E_ARGS' && re.test(e.message), JSON.stringify(v));

test('the four v1 targets are accepted and normalised', () => {
  assert.deepStrictEqual(PP.check({ review: { worker: 'rev-1' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' }),
    { review: { worker: 'rev-1' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' });
  assert.deepStrictEqual(PP.check({ review: { spawn: { agent_type: 'reviewer', worker_id: 'r2' } } }), { review: { spawn: { agent_type: 'reviewer', worker_id: 'r2' } } });
  assert.deepStrictEqual(PP.check({ review: { spawn: { agent_type: 'reviewer' } } }), { review: { spawn: { agent_type: 'reviewer' } } });
  assert.deepStrictEqual(PP.check({}), {}, 'an empty plan says nothing and is valid');
});

test('every value outside the allowlist is refused with E_ARGS "not accepted in 0.4.0"', () => {
  const notYet = /not accepted in 0\.4\.0/;
  refused({ cut: { when: 'deps_merged', worker: 'w' } }, notYet); // a field of the record that v1 does not take
  refused({ follow_up: 'wake' }, notYet);
  refused({ whatever: 1 }, notYet);
  refused({ review: { pool: ['a', 'b'] } }, notYet); // pool is held back with the other values of question 2
  refused({ review: { spawn: { agent_type: 'coder', substrate: 'codex' } } }, notYet);
  refused({ fix: { worker: 'w' } }, notYet);
  refused({ fix: { spawn: { agent_type: 'coder' } } }, notYet);
  refused({ fix: 'builder_or_new' }, notYet);
  refused({ re_review: 'refuter_or_wait' }, notYet);
  refused({ re_review: { pool: ['a'] } }, notYet);
  refused({ integrate: 'before_review' }, notYet);
});

test('malformed plans are refused', () => {
  for (const v of [null, 'fix', 7, [], true]) assert.throws(() => PP.check(v), (e) => e.code === 'E_ARGS');
  refused({ fix: undefined }, /undefined/);
  refused({ review: 'w1' }, /must be an object/);
  refused({ review: { worker: '../x' } }, /not a valid id/);
  refused({ review: { spawn: { agent_type: 'wizard' } } }, /agent_type must be one of/);
  refused({ review: { spawn: { agent_type: 'coder', worker_id: 'a b' } } }, /not a valid id/);
  for (const id of ['knowledge-run1', 'notereview-1', 'scrub-1', 'archreview-1']) refused({ review: { spawn: { agent_type: 'reviewer', worker_id: id } } }, /reserved for belay/);
  refused({ review: {} }, /exactly one/);
  refused({ review: { worker: 'a', spawn: { agent_type: 'coder' } } }, /exactly one/);
});

test('the agent types are the run manager\'s own', () => assert.deepStrictEqual(PP.AGENT_TYPES, WORKER_TYPES));

test('precedence: a task\'s own field beats the user default, field by field', () => {
  const def = { review: { worker: 'dflt' }, fix: 'builder', integrate: 'on_hold' };
  const rows = [
    [{}, def, def],
    [{ review: { worker: 'mine' } }, def, { review: { worker: 'mine' }, fix: 'builder', integrate: 'on_hold' }], // one field replaced, the rest filled
    [{ review: { spawn: { agent_type: 'reviewer' } } }, def, { review: { spawn: { agent_type: 'reviewer' } }, fix: 'builder', integrate: 'on_hold' }], // a field is a whole value
    [{ re_review: 'refuter' }, def, { ...def, re_review: 'refuter' }],
    [{ fix: 'builder', integrate: 'on_hold', review: { worker: 'mine' } }, { review: { worker: 'dflt' } }, { fix: 'builder', integrate: 'on_hold', review: { worker: 'mine' } }],
    [{}, null, null],
    [null, null, null],
    [{ fix: 'builder' }, null, { fix: 'builder' }],
  ];
  for (const [own, dflt, want] of rows) assert.deepStrictEqual(PP.resolve(own, dflt), want, JSON.stringify([own, dflt]));
});

test('forCreate stores the resolved plan at revision 1; no plan and no default stores nothing', () => {
  const run = { policy_default: JSON.stringify({ fix: 'builder' }) };
  const work = { acceptance: { commands: [] } };
  assert.deepStrictEqual(PP.forCreate(run, { policy: { integrate: 'on_hold' } }, work), { policy: { fix: 'builder', integrate: 'on_hold' }, policy_rev: 1 });
  assert.deepStrictEqual(PP.forCreate(run, {}, work), { policy: { fix: 'builder' }, policy_rev: 1 });
  assert.deepStrictEqual(PP.forCreate(null, {}, work), { policy: null, policy_rev: null });
  assert.deepStrictEqual(PP.forCreate({ policy_default: null }, { policy: {} }, work), { policy: null, policy_rev: null });
  assert.deepStrictEqual(PP.forCreate(run, { policy: null }, work), { policy: null, policy_rev: null }, 'null is "no plan": the default does not apply');
  assert.throws(() => PP.forCreate(run, { policy: { fix: 'x' } }, work), (e) => e.code === 'E_ARGS');
});

test('the default does not fill a fix task, a follow-up or a review task; a plan stated on one is kept', () => {
  const run = { policy_default: JSON.stringify({ fix: 'builder' }) };
  for (const t of [{ repairs: 'w' }, { follows_up: { root: 'w' } }, { acceptance: { verdict: true } }]) {
    assert.deepStrictEqual(PP.forCreate(run, {}, t), { policy: null, policy_rev: null }, JSON.stringify(t));
    assert.deepStrictEqual(PP.forCreate(run, { policy: { integrate: 'on_hold' } }, t).policy, { integrate: 'on_hold' });
  }
});

test('forAmend: every amend is the next revision, the stated plan replaces and is resolved over the default, null hands back', () => {
  const run = { policy_default: JSON.stringify({ fix: 'builder' }) };
  const task = { policy: { review: { worker: 'a' }, fix: 'builder' }, policy_rev: 1, acceptance: {} };
  assert.deepStrictEqual(PP.forAmend(run, task, { integrate: 'on_hold' }), { policy: { fix: 'builder', integrate: 'on_hold' }, policy_rev: 2 }, 'review is gone: the amend replaces');
  assert.deepStrictEqual(PP.forAmend(run, task, null), { policy: null, policy_rev: 2 });
  assert.deepStrictEqual(PP.forAmend(null, { policy: null, policy_rev: null }, { fix: 'builder' }), { policy: { fix: 'builder' }, policy_rev: 1 });
  assert.deepStrictEqual(PP.forAmend(null, { policy: null, policy_rev: 2 }, null), { policy: null, policy_rev: 3 });
  assert.throws(() => PP.forAmend(run, task, { integrate: 'x' }), (e) => e.code === 'E_ARGS');
});

test('tag: a short, stable reading of the plan', () => {
  assert.strictEqual(PP.tag({ review: { worker: 'w1' }, fix: 'builder', re_review: 'refuter', integrate: 'on_hold' }), 'r:w1 f:builder rr:refuter i:on_hold');
  assert.strictEqual(PP.tag({ review: { spawn: { agent_type: 'reviewer' } } }), 'r:spawn(reviewer)');
  assert.strictEqual(PP.tag({}), null);
  assert.strictEqual(PP.tag(null), null);
});
