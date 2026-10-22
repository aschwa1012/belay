'use strict';
// teardown.cjs — run every cleanup step, then report. The body's own error always wins; with no body error the first
// teardown error is thrown, so a cleanup that fails on a passing test is a failure, not silence.

async function teardown(bodyError, steps) {
  let first = null;
  for (const step of steps) {
    try { await step(); } catch (e) { if (first === null) first = e; }
  }
  if (first !== null && (bodyError === null || bodyError === undefined)) throw first;
}

// withTeardown(body, steps): run the body, then every step; rethrow the body's error, else the first teardown error.
async function withTeardown(body, steps) {
  let bodyError = null; let result;
  try { result = await body(); } catch (e) { bodyError = e === undefined ? new Error('undefined was thrown') : e; }
  await teardown(bodyError, steps);
  if (bodyError !== null) throw bodyError;
  return result;
}

module.exports = { teardown, withTeardown };
