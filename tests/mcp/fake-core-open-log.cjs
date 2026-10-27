// fake-core-open-log.cjs — fake-core.cjs whose openCore first records the options it was called with (the caller's role and
// ownerOpts) as one JSON line in BELAY_TEST_OPEN_LOG, so a test can see which opener asks for a long-lived owner
// (ADR 0053 amendment 2). With BELAY_TEST_OPEN_THROW set it then refuses, so `belay run` stops right after its openCore.
'use strict';

const fs = require('node:fs');
const base = require('./fake-core.cjs');
const { CoreError } = base;

async function openCore(opts = {}) {
  const log = process.env.BELAY_TEST_OPEN_LOG;
  if (log) fs.appendFileSync(log, `${JSON.stringify({ role: opts.caller && opts.caller.role, ownerOpts: opts.ownerOpts === undefined ? null : { longLived: opts.ownerOpts.longLived === undefined ? null : opts.ownerOpts.longLived } })}\n`);
  if (process.env.BELAY_TEST_OPEN_THROW) throw new CoreError('E_INTERNAL', 'PROBE: openCore refused by fake-core-open-log.cjs after recording its options');
  return base.openCore(opts);
}

module.exports = { ...base, openCore };
