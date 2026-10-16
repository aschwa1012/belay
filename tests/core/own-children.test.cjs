'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { childrenIn } = require('../helpers/own-children.cjs');

const E = (ppid, created) => ({ ppid, created, image: 'node.exe' });

test('own children: a child created after its parent is counted; a reused-pid orphan created before it is not', () => {
  const snap = new Map([[100, E(1, 5000)], [201, E(100, 5100)], [202, E(100, 5000)], [300, E(100, 4000)], [301, E(100, null)], [400, E(7, 6000)]]);
  assert.deepStrictEqual(childrenIn(snap, 100).sort(), [201, 202], 'the orphan (4000) and the child with no creation time are not counted');
});

test('own children: when the parent itself is not in the snapshot or has no creation time, only the parent id decides', () => {
  const snap = new Map([[201, E(100, 5100)], [300, E(100, 4000)], [400, E(7, 6000)]]);
  assert.deepStrictEqual(childrenIn(snap, 100).sort(), [201, 300]);
});
