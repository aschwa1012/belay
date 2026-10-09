'use strict';
// head-lookup.cjs — build 12b (headsha), ADR 0029 amendment 2. A worker's base_sha and head_sha used to get one
// rev-parse with a 5 s timeout and no retry, so a loaded host lost the sha for good. This asks up to ATTEMPTS
// times with a short backoff, every attempt inside TOTAL_MS (the base code's own 5 s; lifecycle.cjs's HEAD_DRAIN_MS is 500 ms longer, to cover the kill of a git that timed out). An attempt gets all the time left, so git answering
// slowly (2 to 5 s on a loaded host, which one attempt always managed) still lands; a retry follows only a spawn failure (EAGAIN and the like), never a timeout or a git that ran and failed (inside lifecycle.cjs's HEAD_DRAIN_MS, so a
// shutdown stays bounded). A lookup that never answers resolves `{ sha: null, reason }` so the
// caller can write the reason on the row. Calls git through the module object so a test can stand in for it.

const G = require('./git-facts.cjs');

const ATTEMPTS = 3;
const TOTAL_MS = 5000;
const BACKOFF_MS = [150, 300];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookupSha(cwd) {
  const t0 = Date.now();
  let last = { sha: null, reason: 'no attempt was made' };
  for (let i = 0; i < ATTEMPTS; i++) {
    const left = TOTAL_MS - (Date.now() - t0);
    if (left < 200) break;
    last = await G.revParseHeadResult(cwd, { timeoutMs: left });
    if (last.sha || !last.retry) break;
    if (i < ATTEMPTS - 1) await sleep(Math.min(BACKOFF_MS[i], Math.max(0, TOTAL_MS - (Date.now() - t0))));
  }
  return { sha: last.sha || null, reason: last.sha ? null : last.reason };
}

module.exports = { lookupSha, ATTEMPTS, TOTAL_MS };
