'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { teardown, withTeardown } = require('../helpers/teardown.cjs');

test('a passing body with a failing teardown fails with the teardown error', async () => {
  const boom = new Error('teardown boom');
  await assert.rejects(withTeardown(async () => 'ok', [() => { throw boom; }]), (e) => e === boom);
  await assert.rejects(teardown(null, [async () => { throw boom; }]), (e) => e === boom);
  await assert.rejects(teardown(undefined, [() => { throw boom; }]), (e) => e === boom);
});

test('a failing body wins over a failing teardown', async () => {
  const body = new Error('body'); const td = new Error('teardown');
  await assert.rejects(withTeardown(async () => { throw body; }, [() => { throw td; }]), (e) => e === body);
  await teardown(body, [() => { throw td; }]); // with a body error set the helper itself does not throw
});

test('every step is attempted even when an early one throws, and the first error is the one reported', async () => {
  const ran = []; const first = new Error('first'); const second = new Error('second');
  await assert.rejects(teardown(null, [
    () => { ran.push(1); throw first; },
    async () => { ran.push(2); throw second; },
    () => { ran.push(3); },
  ]), (e) => e === first);
  assert.deepStrictEqual(ran, [1, 2, 3]);
});

test('sync and async steps both run, in order, and a clean teardown returns the body result', async () => {
  const ran = [];
  const r = await withTeardown(async () => 42, [() => { ran.push('sync'); }, async () => { await Promise.resolve(); ran.push('async'); }]);
  assert.strictEqual(r, 42);
  assert.deepStrictEqual(ran, ['sync', 'async']);
});
