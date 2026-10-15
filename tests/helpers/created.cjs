'use strict';
// created.cjs — ADR 0048 decision 8 (c). A test that reads a process's creation time as setup is not testing the
// snapshot, so the read is a named precondition: it is tried up to three times (each a fresh snapshot, never
// retried inside the product), and when none gives an answer the test fails saying that, not with a TypeError
// further down or a product bound that counted the snapshot. The caller starts its own clock after this resolves.

const assert = require('node:assert');
const ID = require('../../src/core/proc-identity.cjs');

async function readCreated(pid, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await ID.createdOf(pid, { kind: 'test-setup' });
    if (r && Number.isFinite(r.created)) return r;
  }
  assert.fail(`precondition: the process snapshot could not read the creation time of pid ${pid} in ${tries} reads (the machine is too loaded for this test's setup; this is not a product failure)`);
  return null;
}

module.exports = { readCreated };
