'use strict';
// embedder-mode.test.cjs — memory.on_embedder_failure (ADR 0034 amendment 1): required (the default), keyword and off; the old
// names stop and continue are accepted as required and keyword; anything else is refused. TYPES lists every memory lever.

const test = require('node:test');
const assert = require('node:assert');
const { core } = require('./helpers.cjs');

const EM = core('embedder-mode.cjs');
const { DEFAULTS, TYPES, parseMemoryBlock, isDefault } = core('memory-levers.cjs');

const PAIRS = [['required', 'required'], ['keyword', 'keyword'], ['off', 'off'], ['stop', 'required'], ['continue', 'keyword']];

test('the three values, their default, and the two old names', () => {
  assert.deepStrictEqual([...EM.MODES], ['required', 'keyword', 'off']);
  assert.strictEqual(EM.DEFAULT_MODE, 'required');
  assert.strictEqual(DEFAULTS.on_embedder_failure, 'required');
  for (const [given, canonical] of PAIRS) assert.strictEqual(EM.normalize(given), canonical, given);
  for (const bad of ['', 'Required', 'on', 'pause', 'none', null, undefined, 1, true, {}, ['off']]) assert.strictEqual(EM.normalize(bad), null, String(bad));
  assert.match(EM.describe(), /required, keyword, off/);
});

test('the memory block accepts each value and the old names, stores the new name, and refuses the rest with a message', () => {
  for (const [given, canonical] of PAIRS) assert.strictEqual(parseMemoryBlock({ on_embedder_failure: given }).value.on_embedder_failure, canonical, given);
  assert.strictEqual(parseMemoryBlock(undefined).value.on_embedder_failure, 'required', 'no block: the default');
  assert.strictEqual(parseMemoryBlock({}).value.on_embedder_failure, 'required');
  for (const bad of ['maybe', '', 7, null]) {
    assert.match(parseMemoryBlock({ on_embedder_failure: bad }).error, /memory\.on_embedder_failure must be one of required, keyword, off/, String(bad));
  }
  assert.strictEqual(isDefault(parseMemoryBlock({}).value), true, 'the default mode is the default block');
  assert.strictEqual(isDefault(parseMemoryBlock({ on_embedder_failure: 'keyword' }).value), false);
});

test('TYPES covers every lever and says what each accepts (the settings CLI derives its keys from DEFAULTS and TYPES)', () => {
  assert.deepStrictEqual(Object.keys(TYPES).sort(), Object.keys(DEFAULTS).sort());
  assert.deepStrictEqual(TYPES.on_embedder_failure, { type: 'enum', values: ['required', 'keyword', 'off'] }, 'the aliases are the parser\'s, not listed');
  for (const [k, t] of Object.entries(TYPES)) {
    assert.ok(['boolean', 'number', 'integer', 'enum', 'string'].includes(t.type), k);
    if (t.type === 'enum') assert.ok(t.values.includes(DEFAULTS[k]), `${k}: the default is one of the values`);
    if (t.type === 'boolean') assert.strictEqual(typeof DEFAULTS[k], 'boolean', k);
  }
});
