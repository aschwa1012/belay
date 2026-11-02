'use strict';
// run-harness-facts.cjs — the facts about the belay running a run that only the run process can state at start (ADR 0082
// decision 1): whether belay's own checkout has uncommitted changes, the sha-256 of the prompt it sends the orchestrator, and the
// `belay-prompt` version of the copy that prompt came from. Read once at run start, never on a read path. The one git spawn here
// is the exception to schema-stamp.cjs's no-spawn rule: `dirty` cannot be read from `.git` files without re-implementing the index.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const GIT_MS = 15000;

// true or false for a checkout, null when belay is an install without one or the status could not be read.
async function dirtyOf(root = ROOT) {
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  try {
    const r = await require('../core/git-safe.cjs').safeGit(['status', '--porcelain'], root, GIT_MS, { register: null });
    return r.executable && r.exit_code === 0 && !r.timed_out ? String(r.stdout).trim() !== '' : null;
  } catch { return null; } // not read: the record says null, and the run starts
}

const promptSha = (text) => (typeof text === 'string' ? crypto.createHash('sha256').update(text, 'utf8').digest('hex') : null);

// `promptText`: what the orchestrator is sent; `marker`: the copy's belay-prompt version (null when it has none).
async function collect({ promptText, marker = null, root = ROOT } = {}) {
  const ok = typeof marker === 'string' && /^[0-9.]{1,32}$/.test(marker); // a marker the core would refuse is left out: this record never refuses a run
  return { run_build: require('../core/schema-stamp.cjs').writtenBy(), dirty: await dirtyOf(root), prompt_sha: promptSha(promptText), prompt_marker: ok ? marker : null };
}

module.exports = { collect, dirtyOf, promptSha };
