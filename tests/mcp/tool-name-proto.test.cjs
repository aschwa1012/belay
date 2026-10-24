'use strict';
// tool-name-proto.test.cjs — a tool name is looked up among the routes' own keys, so a name that a plain object answers
// (constructor, toString, __proto__, hasOwnProperty) is no tool at all: the adapter says `no such tool`, never "belongs to undefined".

const test = require('node:test');
const assert = require('node:assert');
const T = require('../../src/mcp/tools.cjs');

test('Object.prototype keys are not tools', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.strictEqual(T.routeOf(name), undefined, name);
    assert.strictEqual(T.roleOf(name), undefined, name);
    for (const role of ['orchestrator', 'worker']) assert.strictEqual(T.allows(role, name, role === 'worker' ? 'w1' : null), false, `${role} ${name}`);
  }
  assert.strictEqual(T.routeOf(42), undefined);
  assert.strictEqual(T.roleOf('worker_spawn'), 'orchestrator');
  assert.strictEqual(T.routeOf('worker_spawn').role, 'orchestrator');
});
